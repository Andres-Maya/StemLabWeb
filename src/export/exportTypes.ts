import type { SourceData, TrackState } from '../dsp/mixerCore.ts';

export type ExportFormat = 'wav16' | 'wav24' | 'wav32' | 'mp3';

/** Un archivo a renderizar: las pistas que suenan en él y su duración. */
export interface ExportJob {
  name: string;                 // nombre del archivo, sin extensión
  tracks: TrackState[];
  length: number;               // muestras desde el 0
}

export interface ExportRequest {
  sampleRate: number;
  masterVolume: number;
  format: ExportFormat;
  mp3Bitrate: number;
  sources: [number, SourceData][];
  jobs: ExportJob[];
  zipName: string;              // varios archivos: un .zip con este nombre ('' = uno solo)
}

export interface ExportResult {
  ok: boolean;
  cancelled: boolean;
  error: string;
  blob: Blob | null;
  fileName: string;
  peak: number;                 // pico antes de convertir al formato (1.0 = 0 dBFS)
  clipped: boolean;             // el pico pasó de 0 dBFS y el formato (entero o MP3) lo recortó
  seconds: number;
}

export type ToExportWorker = { type: 'start'; request: ExportRequest } | { type: 'cancel' };
export type FromExportWorker = { type: 'progress'; value: number } | { type: 'done'; result: ExportResult };

export function fileExtension(format: ExportFormat): string {
  return format === 'mp3' ? '.mp3' : '.wav';
}

/** Frecuencias que admite MP3 (LAME): hasta 48 kHz. */
export function mp3SampleRate(rate: number): number {
  if (rate <= 48000)
    return rate;

  return Math.abs(rate % 44100) < 1 ? 44100 : 48000;
}
