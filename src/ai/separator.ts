/**
    Separación de instrumentos con Demucs a través del servidor de StemLab Web
    (server/stemlab_server.py): sube la canción, sigue el progreso y descarga
    los stems. El servidor borra sus archivos en cuanto se descargan.

    Como AIProcessManager en la versión de escritorio: una separación a la
    vez, con progreso y estado que la interfaz consulta, y un callback al
    terminar.
*/
import { stemSortOrder } from '../core/strings.ts';

export interface ModelInfo {
  id: string;
  description: string;
  stems: string[];        // pistas que genera, en orden ("vocals", "drums"...)
}

export const MODELS: ModelInfo[] = [
  { id: 'htdemucs', description: '4 pistas: voz, batería, bajo y otros (recomendado)', stems: ['vocals', 'drums', 'bass', 'other'] },
  { id: 'htdemucs_ft', description: '4 pistas, más calidad (unas 4 veces más lento)', stems: ['vocals', 'drums', 'bass', 'other'] },
  { id: 'htdemucs_6s', description: '6 pistas: añade guitarra y piano (experimental)',
    stems: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] },
];

export interface Stem {
  name: string;           // identificador del modelo: "vocals", "drums"...
  blob: Blob;
}

export interface SeparationResult {
  ok: boolean;
  cancelled: boolean;
  error: string;
  stems: Stem[];
}

type ServerEvent =
  | { type: 'status'; message: string }
  | { type: 'progress'; value: number }
  | { type: 'done'; stems: { name: string; url: string }[] }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

const serverHelp = 'No se pudo conectar con el servidor de separación.\n\n'
  + 'La separación por IA la hace Demucs en el servidor de StemLab Web. Ponlo en marcha con:\n\n'
  + '    python server/stemlab_server.py\n\n'
  + '(con el Python que tiene Demucs instalado; ver README.md).';

export class SeparationManager {
  currentModel = 'htdemucs';
  private busy = false;
  private progress = -1;
  private status = '';
  private cancelled = false;
  private jobId = '';
  private upload: XMLHttpRequest | null = null;
  private events: EventSource | null = null;
  private downloads: AbortController | null = null;
  private onFinished: ((result: SeparationResult) => void) | null = null;

  getName(): string {
    return 'Demucs';
  }

  getAvailableModels(): ModelInfo[] {
    return MODELS;
  }

  /** Pistas que generará el modelo actual (para mostrarlas antes de que existan). */
  getExpectedStems(): string[] {
    return MODELS.find(m => m.id === this.currentModel)?.stems ?? ['vocals', 'drums', 'bass', 'other'];
  }

  isBusy(): boolean { return this.busy; }
  /** 0..1, o negativo si todavía no hay porcentaje. */
  getProgress(): number { return this.progress; }
  getStatus(): string { return this.status; }

  /** Devuelve false si ya hay una separación en marcha. */
  start(file: Blob, fileName: string, onFinished: (result: SeparationResult) => void): boolean {
    if (this.busy)
      return false;

    this.busy = true;
    this.cancelled = false;
    this.progress = -1;
    this.status = 'Subiendo la canción al servidor de separación...';
    this.jobId = '';
    this.onFinished = onFinished;

    const request = new XMLHttpRequest();
    this.upload = request;
    request.open('POST', `/api/separations?model=${encodeURIComponent(this.currentModel)}&name=${encodeURIComponent(fileName)}`);
    request.responseType = 'json';

    request.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0)
        this.status = `Subiendo la canción al servidor de separación... ${Math.round((event.loaded / event.total) * 100)} %`;
    };

    request.onerror = () => this.finish({ ok: false, cancelled: false, error: serverHelp, stems: [] });
    request.onabort = () => this.finish({ ok: false, cancelled: true, error: 'Separación cancelada.', stems: [] });

    request.onload = () => {
      this.upload = null;
      const body = request.response as { id?: string; error?: string } | null;

      if (request.status !== 201 || body?.id === undefined) {
        const error = request.status === 404 || request.status === 502 || request.status === 504 || request.status === 0
          ? serverHelp : body?.error ?? `El servidor respondió ${request.status}.`;
        this.finish({ ok: false, cancelled: false, error, stems: [] });
        return;
      }

      this.jobId = body.id;
      this.status = 'Iniciando Python...';
      this.follow(body.id);
    };

    request.send(file);
    return true;
  }

  private follow(jobId: string): void {
    const source = new EventSource(`/api/separations/${jobId}/events`);
    this.events = source;
    let finished = false;

    source.onmessage = message => {
      const event = JSON.parse(message.data) as ServerEvent;

      switch (event.type) {
        case 'status':
          this.status = event.message;
          break;
        case 'progress':
          this.progress = event.value;
          break;
        case 'done':
          finished = true;
          source.close();
          void this.downloadStems(event.stems);
          break;
        case 'error':
          finished = true;
          source.close();
          this.forget();
          this.finish({ ok: false, cancelled: false, error: event.message, stems: [] });
          break;
        case 'cancelled':
          finished = true;
          source.close();
          this.finish({ ok: false, cancelled: true, error: 'Separación cancelada.', stems: [] });
          break;
      }
    };

    source.onerror = () => {
      // EventSource reintenta solo; si el servidor ya no conoce la separación
      // (se reinició), no tiene sentido seguir esperando.
      if (finished || this.cancelled)
        return;

      void fetch(`/api/separations/${jobId}/events`, { method: 'HEAD' }).then(response => {
        if (!response.ok && !finished && !this.cancelled) {
          source.close();
          this.finish({ ok: false, cancelled: false, error: serverHelp, stems: [] });
        }
      }).catch(() => {
        if (!finished && !this.cancelled) {
          source.close();
          this.finish({ ok: false, cancelled: false, error: serverHelp, stems: [] });
        }
      });
    };
  }

  private async downloadStems(stems: { name: string; url: string }[]): Promise<void> {
    this.status = 'Descargando las pistas...';
    this.progress = 1;
    this.downloads = new AbortController();

    try {
      const result: Stem[] = [];

      for (const stem of stems) {
        const response = await fetch(stem.url, { signal: this.downloads.signal });

        if (!response.ok)
          throw new Error(`No se pudo descargar el stem "${stem.name}" (${response.status}).`);

        result.push({ name: stem.name, blob: await response.blob() });
      }

      result.sort((a, b) => stemSortOrder(a.name) - stemSortOrder(b.name));
      this.forget();
      this.finish({ ok: true, cancelled: false, error: '', stems: result });
    } catch (error) {
      this.forget();

      if (this.cancelled)
        this.finish({ ok: false, cancelled: true, error: 'Separación cancelada.', stems: [] });
      else
        this.finish({ ok: false, cancelled: false, error: error instanceof Error ? error.message : String(error), stems: [] });
    }
  }

  /** El servidor borra la canción y los stems. */
  private forget(): void {
    if (this.jobId !== '') {
      void fetch(`/api/separations/${this.jobId}`, { method: 'DELETE' }).catch(() => undefined);
      this.jobId = '';
    }
  }

  cancel(): void {
    if (!this.busy || this.cancelled)
      return;

    this.cancelled = true;
    this.status = 'Cancelando...';

    if (this.upload !== null) {
      this.upload.abort();
      return;
    }

    this.downloads?.abort();
    this.events?.close();
    this.forget();
    this.finish({ ok: false, cancelled: true, error: 'Separación cancelada.', stems: [] });
  }

  private finish(result: SeparationResult): void {
    if (!this.busy)
      return;

    this.busy = false;
    this.upload = null;
    this.events?.close();
    this.events = null;
    this.downloads = null;
    this.progress = -1;
    this.status = '';

    const callback = this.onFinished;
    this.onFinished = null;
    callback?.(result);
  }
}
