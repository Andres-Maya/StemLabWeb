/// <reference path="./worklet.d.ts" />
/**
    Hilo de audio (AudioWorklet): cabezal, mezcla, entrada del micrófono y
    grabación. Equivale a AudioEngine::audioDeviceIOCallbackWithContext de
    StemLab de escritorio: no reserva memoria en cada bloque, solo copia y
    procesa muestras. Todo lo pesado (decodificar, IA, exportar) ocurre fuera
    y llega aquí ya preparado.
*/
import { MixerCore } from '../dsp/mixerCore.ts';
import { SmoothedValue } from '../dsp/effects.ts';
import { decibelsToGain } from '../core/range.ts';
import { previewBinSize, type FromWorklet, type ToWorklet } from './protocol.ts';

/** Limitador suave: lineal hasta 0,8 y luego se curva sin pasar nunca de
    1,0, así un pico fuerte no produce el recorte brusco (y feo) digital. */
function softClip(x: number): number {
  const knee = 0.8;
  const magnitude = Math.abs(x);

  if (magnitude <= knee)
    return x;

  const shaped = knee + (1 - knee) * Math.tanh((magnitude - knee) / (1 - knee));
  return x < 0 ? -shaped : shaped;
}

const chunkSize = 16384;     // muestras por trozo de grabación enviado a la página

class StemLabProcessor extends AudioWorkletProcessor {
  private core = new MixerCore();
  private busL = new Float32Array(128);
  private busR = new Float32Array(128);
  private inputL = new Float32Array(128);
  private inputR = new Float32Array(128);

  // Transporte: solo este hilo avanza la posición. Los saltos pedidos desde la
  // página se aplican al empezar el siguiente bloque.
  private playing = false;
  private position = 0;
  private pendingSeek = -1;

  private inputGainDb = 18;
  private inputGain = new SmoothedValue();
  private inputPeaks: [number, number] = [0, 0];

  // Grabación
  private recording = false;
  private recChannels = 1;
  private recStart = -1;
  private recBuffers: Float32Array[] = [];
  private recFill = 0;
  private binPeak = 0;
  private binCount = 0;
  private preview: number[] = [];

  private blocksUntilTick = 0;
  private readonly blocksPerTick = Math.max(1, Math.round((sampleRate * 0.033) / 128));

  constructor() {
    super();
    this.core.prepare(sampleRate, 128);
    this.inputGain.reset(sampleRate, 0.05);
    this.inputGain.setCurrentAndTargetValue(decibelsToGain(this.inputGainDb));
    this.port.onmessage = (event: MessageEvent<ToWorklet>) => this.handle(event.data);
  }

  private post(message: FromWorklet, transfer: Transferable[] = []): void {
    this.port.postMessage(message, transfer);
  }

  private handle(message: ToWorklet): void {
    switch (message.type) {
      case 'source':
        this.core.sources.set(message.id, { left: message.left, right: message.right, length: message.length });
        break;
      case 'removeSource':
        this.core.sources.delete(message.id);
        break;
      case 'tracks':
        this.core.setTracks(message.tracks);
        break;
      case 'trackParams':
        this.core.setTrackParams(message.id, message.params);
        break;
      case 'master':
        this.core.masterVolume = message.volume;
        break;
      case 'inputGain':
        this.inputGainDb = message.db;
        break;
      case 'play':
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'stop':
        this.playing = false;
        this.seek(0);
        break;
      case 'seek':
        this.seek(message.position);
        break;
      case 'recordStart':
        this.startRecording(message.channels);
        break;
      case 'recordStop':
        this.stopRecording();
        break;
    }
  }

  private seek(position: number): void {
    position = Math.max(0, Math.round(position));
    this.pendingSeek = position;

    // Parado: la posición se actualiza ya para que la página la muestre.
    if (!this.playing)
      this.position = position;
  }

  private startRecording(channels: number): void {
    this.recChannels = Math.min(2, Math.max(1, channels));
    this.recBuffers = Array.from({ length: this.recChannels }, () => new Float32Array(chunkSize));
    this.recFill = 0;
    this.recStart = -1;
    this.binPeak = 0;
    this.binCount = 0;
    this.preview = [];
    this.recording = true;
    this.playing = true;
  }

  private flushChunk(): void {
    if (this.recFill === 0)
      return;

    const channels = this.recBuffers.map(b => b.slice(0, this.recFill));
    this.post({ type: 'recChunk', channels }, channels.map(c => c.buffer));
    this.recFill = 0;
  }

  private stopRecording(): void {
    if (!this.recording)
      return;

    this.recording = false;
    this.flushChunk();
    this.post({ type: 'recDone', startPosition: this.recStart });
    this.sendTick();
  }

  private record(inputs: Float32Array[], numInputs: number, n: number, timelinePosition: number): void {
    if (this.recStart < 0)
      this.recStart = timelinePosition;

    for (let i = 0; i < n; ++i) {
      for (let ch = 0; ch < this.recChannels; ++ch) {
        // Si la entrada tiene menos canales de los previstos, se repite el último.
        const sample = inputs[Math.min(ch, numInputs - 1)][i];
        this.recBuffers[ch][this.recFill] = sample;
        this.binPeak = Math.max(this.binPeak, Math.abs(sample));
      }

      if (++this.recFill === chunkSize) {
        this.flushChunk();
        this.recBuffers = Array.from({ length: this.recChannels }, () => new Float32Array(chunkSize));
      }

      if (++this.binCount === previewBinSize) {
        this.preview.push(this.binPeak);
        this.binPeak = 0;
        this.binCount = 0;
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const n = output.length > 0 ? output[0].length : 128;

    if (n > this.busL.length) {
      this.busL = new Float32Array(n);
      this.busR = new Float32Array(n);
      this.inputL = new Float32Array(n);
      this.inputR = new Float32Array(n);
      this.core.prepare(sampleRate, n);
    }

    if (this.pendingSeek >= 0) {
      this.position = this.pendingSeek;
      this.pendingSeek = -1;
    }

    const blockStart = this.position;
    const playing = this.playing;

    // Entrada: ganancia + limitador suave. El medidor funciona siempre; la
    // grabación solo mientras suena el transporte.
    const input = inputs[0];
    const numInputs = input !== undefined ? Math.min(2, input.length) : 0;

    if (numInputs > 0) {
      this.inputGain.setTargetValue(decibelsToGain(this.inputGainDb));
      const processed = [this.inputL, this.inputR];

      for (let i = 0; i < n; ++i) {
        const gain = this.inputGain.getNextValue();

        for (let ch = 0; ch < numInputs; ++ch) {
          const sample = softClip(input[ch][i] * gain);
          processed[ch][i] = sample;
          this.inputPeaks[ch] = Math.max(this.inputPeaks[ch], Math.abs(sample));
        }
      }

      if (numInputs === 1)
        this.inputPeaks[1] = this.inputPeaks[0];

      if (playing && this.recording)
        this.record(processed, numInputs, n, blockStart);
    }

    this.core.render(this.busL, this.busR, n, blockStart, playing);

    if (output.length === 1) {
      for (let i = 0; i < n; ++i)
        output[0][i] = 0.5 * (this.busL[i] + this.busR[i]);
    } else {
      for (let ch = 0; ch < output.length; ++ch) {
        if (ch < 2)
          output[ch].set(ch === 0 ? this.busL.subarray(0, n) : this.busR.subarray(0, n));
        else
          output[ch].fill(0);
      }
    }

    if (playing) {
      this.position += n;

      // Fin de la canción, o no hay nada que sonar: parar y volver al inicio
      // (salvo si se está grabando: la toma alarga la canción).
      const end = this.core.contentLength;

      if (!this.recording && blockStart + n >= end) {
        this.playing = false;
        this.position = 0;
      }
    }

    if (--this.blocksUntilTick <= 0) {
      this.blocksUntilTick = this.blocksPerTick;
      this.sendTick();
    }

    return true;
  }

  private sendTick(): void {
    const trackPeaks: [number, number, number][] = this.core.tracks.map(t => [t.id, t.peakL, t.peakR]);

    for (const track of this.core.tracks)
      track.peakL = track.peakR = 0;

    this.post({
      type: 'tick',
      position: this.pendingSeek >= 0 ? this.pendingSeek : this.position,
      playing: this.playing,
      recording: this.recording,
      contentLength: this.core.contentLength,
      trackPeaks,
      master: [this.core.masterPeakL, this.core.masterPeakR],
      input: [this.inputPeaks[0], this.inputPeaks[1]],
      preview: this.preview,
      recordStart: this.recStart,
    });

    this.core.masterPeakL = this.core.masterPeakR = 0;
    this.inputPeaks[0] = this.inputPeaks[1] = 0;
    this.preview = [];
  }
}

registerProcessor('stemlab-engine', StemLabProcessor);
