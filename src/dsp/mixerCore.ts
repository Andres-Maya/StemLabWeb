/**
    Mezclador: pistas (clips + volumen, paneo, mute, solo y efectos) + bus
    master. Es el núcleo del motor de audio y lo usan igual el AudioWorklet
    (tiempo real) y la exportación (fuera de tiempo real), así que el archivo
    exportado suena exactamente como lo que se oye.

    Todas las pistas leen de la misma posición (cabezal único): los stems
    siempre están alineados a nivel de muestra.
*/
import { EffectChain, SmoothedValue } from './effects.ts';
import type { EffectsState } from './effectDefs.ts';
import { decibelsToGain } from '../core/range.ts';

/** Audio decodificado (estéreo, a la frecuencia del motor). Solo lectura. */
export interface SourceData {
  left: Float32Array;
  right: Float32Array;
  length: number;
}

/** Un fragmento en la línea de tiempo, en muestras. */
export interface ClipData {
  sourceId: number;
  timelineStart: number;
  sourceOffset: number;
  length: number;
}

export interface TrackParams {
  volume: number;         // dB
  pan: number;            // -1..1
  mute: boolean;
  solo: boolean;
  effects: EffectsState;
}

export interface TrackState extends TrackParams {
  id: number;
  clips: ClipData[];
}

// Fundido en los bordes de cada clip para que cortar en mitad de la onda no
// produzca chasquidos (~1 ms).
const edgeFadeLength = 48;

class TrackDSP {
  readonly id: number;
  clips: ClipData[] = [];
  endSample = 0;
  volume = 0;
  pan = 0;
  mute = false;
  solo = false;
  readonly chain = new EffectChain();
  private leftGain = new SmoothedValue();
  private rightGain = new SmoothedValue();
  private scratchL = new Float32Array(0);
  private scratchR = new Float32Array(0);
  peakL = 0;
  peakR = 0;

  constructor(id: number) {
    this.id = id;
  }

  prepare(sampleRate: number, blockSize: number): void {
    this.scratchL = new Float32Array(blockSize);
    this.scratchR = new Float32Array(blockSize);
    this.chain.prepare(sampleRate);

    for (const smoothed of [this.leftGain, this.rightGain]) {
      smoothed.reset(sampleRate, 0.02);
      smoothed.setCurrentAndTargetValue(0);
    }
  }

  setParams(params: Partial<TrackParams>): void {
    if (params.volume !== undefined) this.volume = params.volume;
    if (params.pan !== undefined) this.pan = params.pan;
    if (params.mute !== undefined) this.mute = params.mute;
    if (params.solo !== undefined) this.solo = params.solo;
    this.chain.setState(params.effects);
  }

  setClips(clips: ClipData[]): void {
    this.clips = clips;
    this.endSample = clips.reduce((end, c) => Math.max(end, c.timelineStart + c.length), 0);
  }

  private renderClips(sources: Map<number, SourceData>, n: number, position: number): void {
    const outL = this.scratchL, outR = this.scratchR;

    // En orden: donde dos clips se solapan, el posterior sobrescribe al anterior.
    for (const clip of this.clips) {
      const source = sources.get(clip.sourceId);

      if (source === undefined)
        continue;

      const offsetInClip = position - clip.timelineStart;
      const first = Math.min(n, Math.max(0, -offsetInClip));
      const last = Math.min(n, Math.max(0, clip.length - offsetInClip));

      if (last <= first)
        continue;

      const readStart = clip.sourceOffset + offsetInClip;

      for (let i = first; i < last; ++i) {
        const index = readStart + i;
        const inside = index >= 0 && index < source.length;
        outL[i] = inside ? source.left[index] : 0;
        outR[i] = inside ? source.right[index] : 0;
      }

      // Fundidos cortos en los bordes del clip.
      for (let i = first; i < last; ++i) {
        const positionInClip = offsetInClip + i;
        const distanceToEdge = Math.min(positionInClip, clip.length - 1 - positionInClip);

        if (distanceToEdge >= edgeFadeLength) {
          // Saltar directamente hasta la zona de fundido final.
          const fadeOutStart = clip.length - edgeFadeLength - offsetInClip;
          i = Math.max(i, fadeOutStart - 1);
          continue;
        }

        const gain = distanceToEdge / edgeFadeLength;
        outL[i] *= gain;
        outR[i] *= gain;
      }
    }
  }

  /** Procesa la pista y SUMA el resultado en el bus. */
  renderAdd(sources: Map<number, SourceData>, busL: Float32Array, busR: Float32Array,
            n: number, position: number, audible: boolean): void {
    // Volumen + balance. El balance deja el centro a ganancia unidad: así la
    // suma de los stems sin tocar reproduce la mezcla original.
    const gain = audible ? decibelsToGain(this.volume, -60) : 0;
    const pan = this.pan;
    const halfPi = Math.PI / 2;

    this.leftGain.setTargetValue(gain * (pan > 0 ? Math.cos(pan * halfPi) : 1));
    this.rightGain.setTargetValue(gain * (pan < 0 ? Math.cos(-pan * halfPi) : 1));

    // Silenciada y con la rampa de salida terminada: no hace falta procesar.
    if (!audible && !this.leftGain.isSmoothing() && !this.rightGain.isSmoothing())
      return;

    this.scratchL.fill(0, 0, n);
    this.scratchR.fill(0, 0, n);
    this.renderClips(sources, n, position);
    this.chain.process(this.scratchL, this.scratchR, n);

    let peakL = 0, peakR = 0;

    for (let i = 0; i < n; ++i) {
      const l = this.scratchL[i] * this.leftGain.getNextValue();
      const r = this.scratchR[i] * this.rightGain.getNextValue();
      busL[i] += l;
      busR[i] += r;
      peakL = Math.max(peakL, Math.abs(l));
      peakR = Math.max(peakR, Math.abs(r));
    }

    this.peakL = Math.max(this.peakL, peakL);
    this.peakR = Math.max(this.peakR, peakR);
  }
}

export class MixerCore {
  sampleRate = 48000;
  blockSize = 128;
  readonly sources = new Map<number, SourceData>();
  tracks: TrackDSP[] = [];
  masterVolume = 0;
  private masterGain = new SmoothedValue();
  masterPeakL = 0;
  masterPeakR = 0;
  contentLength = 0;

  prepare(sampleRate: number, blockSize: number): void {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.masterGain.reset(sampleRate, 0.02);
    this.masterGain.setCurrentAndTargetValue(decibelsToGain(this.masterVolume, -60));

    for (const track of this.tracks)
      track.prepare(sampleRate, blockSize);
  }

  /** Sustituye la lista de pistas conservando el estado (efectos, rampas) de
      las que ya existían. */
  setTracks(states: TrackState[]): void {
    const existing = new Map(this.tracks.map(t => [t.id, t]));

    this.tracks = states.map(state => {
      let track = existing.get(state.id);

      if (track === undefined) {
        track = new TrackDSP(state.id);
        track.setParams(state);
        track.prepare(this.sampleRate, this.blockSize);
      } else {
        track.setParams(state);
      }

      track.setClips(state.clips);
      return track;
    });

    this.updateContentLength();
  }

  setTrackParams(id: number, params: Partial<TrackParams>): void {
    this.tracks.find(t => t.id === id)?.setParams(params);
  }

  updateContentLength(): void {
    this.contentLength = this.tracks.reduce((end, t) => Math.max(end, t.endSample), 0);
  }

  /** Escribe la mezcla estéreo en bus[0, n). */
  render(busL: Float32Array, busR: Float32Array, n: number, position: number, playing: boolean): void {
    busL.fill(0, 0, n);
    busR.fill(0, 0, n);

    if (playing) {
      const anySolo = this.tracks.some(t => t.solo);

      for (const track of this.tracks) {
        const audible = !track.mute && (!anySolo || track.solo);
        track.renderAdd(this.sources, busL, busR, n, position, audible);
      }
    }

    this.masterGain.setTargetValue(decibelsToGain(this.masterVolume, -60));
    let peakL = 0, peakR = 0;

    for (let i = 0; i < n; ++i) {
      const gain = this.masterGain.getNextValue();
      busL[i] *= gain;
      busR[i] *= gain;
      peakL = Math.max(peakL, Math.abs(busL[i]));
      peakR = Math.max(peakR, Math.abs(busR[i]));
    }

    this.masterPeakL = Math.max(this.masterPeakL, peakL);
    this.masterPeakR = Math.max(this.masterPeakR, peakR);
  }
}
