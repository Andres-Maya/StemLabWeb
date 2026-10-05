/**
    Exporta desde la página: prepara la copia de las pistas (clips, volumen,
    paneo, mute, solo, efectos y master) y la renderiza en un Web Worker.
*/
import ExportWorker from './export.worker.ts?worker';
import type { AudioTrack } from '../model/track.ts';
import type { SourceData, TrackState } from '../dsp/mixerCore.ts';
import { safeFileName } from '../audio/decode.ts';
import { msg } from '../core/i18n.ts';
import type { ExportFormat, ExportJob, ExportRequest, ExportResult, FromExportWorker } from './exportTypes.ts';

export type { ExportFormat, ExportResult };

export interface ExportTask {
  promise: Promise<ExportResult>;
  cancel(): void;
}

export interface ExportFile {
  name: string;
  tracks: AudioTrack[];
  /** Pistas sueltas: suenan aunque estén en mute o haya otra en solo. */
  forceAudible: boolean;
  length: number;
}

function stateFor(track: AudioTrack, forceAudible: boolean): TrackState {
  const state = track.engineState();
  return forceAudible ? { ...state, mute: false, solo: false } : state;
}

export function startExport(files: ExportFile[], options: { sampleRate: number; masterVolume: number; format: ExportFormat;
                            mp3Bitrate: number; zipName: string }, onProgress: (value: number) => void): ExportTask {
  const sources = new Map<number, SourceData>();

  for (const file of files)
    for (const track of file.tracks)
      for (const source of track.getSources())
        sources.set(source.id, { left: source.left, right: source.right, length: source.length });

  const jobs: ExportJob[] = files.map(file => ({
    name: safeFileName(file.name),
    tracks: file.tracks.map(t => stateFor(t, file.forceAudible)),
    length: file.length,
  }));

  const request: ExportRequest = { ...options, sources: [...sources], jobs };
  const worker = new ExportWorker();

  const promise = new Promise<ExportResult>(resolve => {
    worker.onmessage = (event: MessageEvent<FromExportWorker>) => {
      if (event.data.type === 'progress') {
        onProgress(event.data.value);
      } else {
        resolve(event.data.result);
        worker.terminate();
      }
    };

    worker.onerror = event => {
      resolve({ ok: false, cancelled: false, error: event.message || msg('Error al exportar.'), blob: null, fileName: '',
                peak: 0, clipped: false, seconds: 0 });
      worker.terminate();
    };
  });

  worker.postMessage({ type: 'start', request });
  return { promise, cancel: () => worker.postMessage({ type: 'cancel' }) };
}

/** Descarga el archivo en el equipo (carpeta de descargas del navegador). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
