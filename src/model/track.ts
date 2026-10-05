/**
    Una pista: lista de clips en la línea de tiempo + controles de canal
    (volumen, paneo, mute, solo) + cadena de efectos. El audio de los clips ya
    está decodificado en memoria (ClipSource).
*/
import { msg } from '../core/i18n.ts';
import { Parameter } from '../core/parameter.ts';
import { NormalisableRange } from '../core/range.ts';
import { EFFECT_DEFS, type EffectsState } from '../dsp/effectDefs.ts';
import type { TrackParams, TrackState } from '../dsp/mixerCore.ts';
import { clipEnd, createClipId, type AudioClip, type ClipSource } from './clip.ts';
import type { Colour } from '../ui/colour.ts';

export interface EffectModel {
  id: string;
  name: string;
  enabled: Parameter;
  params: Parameter[];
}

let nextTrackId = 1;

export class AudioTrack {
  readonly id = nextTrackId++;
  name: string;
  /** Pista en la que se está grabando (solo una a la vez). */
  armed = false;
  /** Carpeta en la que se muestra (id de TrackFolder; '' = ninguna). */
  folderId = '';
  /** Pista generada por una separación: su grupo (id de la carpeta que se creó)
      y el stem ("vocals"...). Se conserva aunque se saque de la carpeta. */
  stemGroup = '';
  stemId = '';

  readonly volume = Parameter.continuous('volume', msg('Volumen'), new NormalisableRange(-60, 12, 0.1, 2), 0, 'dB');
  readonly pan = Parameter.continuous('pan', msg('Paneo'), new NormalisableRange(-1, 1, 0.01), 0);
  readonly mute = Parameter.toggle('mute', 'Mute', false);
  readonly solo = Parameter.toggle('solo', 'Solo', false);
  readonly effects: EffectModel[];

  private clips: AudioClip[] = [];

  constructor(name: string) {
    this.name = name;
    this.volume.textFormatter = db => (db <= -60 ? '-inf dB' : db.toFixed(1) + ' dB');
    this.pan.textFormatter = value => {
      const percent = Math.round(Math.abs(value) * 100);
      return percent === 0 ? 'C' : (value < 0 ? 'L ' : 'R ') + percent;
    };

    this.effects = EFFECT_DEFS.map(def => ({
      id: def.id,
      name: def.name,
      enabled: Parameter.toggle('enabled', msg('Activo'), def.enabledByDefault),
      params: def.params.map(p => Parameter.fromDef(p)),
    }));
  }

  /** Todos los parámetros (para escucharlos y enviarlos al motor). */
  allParameters(): Parameter[] {
    return [this.volume, this.pan, this.mute, this.solo, ...this.effects.flatMap(e => [e.enabled, ...e.params])];
  }

  getClips(): AudioClip[] {
    return this.clips.map(c => ({ ...c }));
  }

  setClips(clips: AudioClip[]): void {
    this.clips = clips.map(c => ({ ...c }));
  }

  hasClips(): boolean {
    return this.clips.length > 0;
  }

  /** Audio distinto que usan los clips. */
  getSources(): ClipSource[] {
    return [...new Set(this.clips.map(c => c.source))];
  }

  getEndSample(): number {
    return this.clips.reduce((end, c) => Math.max(end, clipEnd(c)), 0);
  }

  effectsState(): EffectsState {
    const state: EffectsState = {};

    for (const effect of this.effects) {
      const params: Record<string, number> = {};

      for (const p of effect.params)
        params[p.id] = p.get();

      state[effect.id] = { enabled: effect.enabled.getBool(), params };
    }

    return state;
  }

  params(): TrackParams {
    return {
      volume: this.volume.get(),
      pan: this.pan.get(),
      mute: this.mute.getBool(),
      solo: this.solo.getBool(),
      effects: this.effectsState(),
    };
  }

  /** Lo que necesita el motor de audio. */
  engineState(): TrackState {
    return {
      id: this.id,
      ...this.params(),
      clips: this.clips.map(c => ({
        sourceId: c.source.id, timelineStart: c.timelineStart, sourceOffset: c.sourceOffset, length: c.length,
      })),
    };
  }

  /** Volumen, paneo, mute, solo y efectos (para copiar la pista). */
  copyStateFrom(other: AudioTrack): void {
    this.volume.set(other.volume.get());
    this.pan.set(other.pan.get());
    this.mute.set(other.mute.get());
    this.solo.set(other.solo.get());

    this.effects.forEach((effect, i) => {
      effect.enabled.set(other.effects[i].enabled.get());
      effect.params.forEach((p, j) => p.set(other.effects[i].params[j].get()));
    });

    this.folderId = other.folderId;
    this.stemGroup = other.stemGroup;
    this.stemId = other.stemId;
  }

  /** Pista nueva con los mismos clips (ids nuevos; el audio se comparte),
      volumen, paneo, mute, solo y efectos. No copia el estado de grabación. */
  createCopy(newName: string): AudioTrack {
    const copy = new AudioTrack(newName);
    copy.setClips(this.clips.map(c => ({ ...c, id: createClipId() })));
    copy.copyStateFrom(this);
    return copy;
  }
}

/**
    Carpeta de pistas. La crea la separación por IA con las pistas que genera
    (Voz, Batería...). Guarda lo necesario para su pantalla de ondas: el color,
    el audio de la canción separada (para el anillo de frecuencias) y los stems.
*/
export interface TrackFolder {
  id: string;
  name: string;
  colour: Colour;
  expanded: boolean;
  stems: string[];                  // "vocals", "drums"...
  source: ClipSource | null;        // audio de la canción separada
  sourceStart: number;              // tramo que usaba su fragmento (muestras)
  sourceLength: number;
}
