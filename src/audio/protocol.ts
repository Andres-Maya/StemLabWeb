/** Mensajes entre la página (AudioEngine) y el AudioWorklet (hilo de audio). */
import type { TrackParams, TrackState } from '../dsp/mixerCore.ts';

export type ToWorklet =
  | { type: 'source'; id: number; left: Float32Array; right: Float32Array; length: number }
  | { type: 'removeSource'; id: number }
  | { type: 'tracks'; tracks: TrackState[] }
  | { type: 'trackParams'; id: number; params: Partial<TrackParams> }
  | { type: 'master'; volume: number }
  | { type: 'inputGain'; db: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'seek'; position: number }
  | { type: 'recordStart'; channels: number }
  | { type: 'recordStop' };

export interface Tick {
  type: 'tick';
  frame: number;                       // currentFrame del AudioContext al enviarlo
  position: number;                    // cabezal (muestras)
  playing: boolean;
  recording: boolean;
  contentLength: number;
  trackPeaks: [number, number, number][];   // [id, izquierda, derecha]
  master: [number, number];
  input: [number, number];
  preview: number[];                   // picos nuevos de la grabación (uno por previewBinSize muestras)
  recordStart: number;                 // posición del primer sample grabado (-1: aún nada)
}

export type FromWorklet =
  | Tick
  | { type: 'recChunk'; channels: Float32Array[] }
  | { type: 'recDone'; startPosition: number };

/** Vista previa en directo de la grabación: un pico por cada previewBinSize muestras. */
export const previewBinSize = 512;
