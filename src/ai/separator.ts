/**
    Separación de instrumentos con Demucs a través del servidor de StemLab Web
    (server/stemlab_server.py): sube la canción, sigue el progreso y descarga
    los stems. El servidor borra sus archivos en cuanto se descargan.

    Como AIProcessManager en la versión de escritorio: una separación a la
    vez, con progreso y estado que la interfaz consulta, y un callback al
    terminar.
*/
import { msg, tr, trMatching } from '../core/i18n.ts';
import { stemSortOrder } from '../core/strings.ts';
import { apiUrl, getSeparationServer, isLocalPage } from './serverConfig.ts';

export interface ModelInfo {
  id: string;
  description: string;
  stems: string[];        // pistas que genera, en orden ("vocals", "drums"...)
}

export const MODELS: ModelInfo[] = [
  { id: 'htdemucs', description: msg('4 pistas: voz, batería, bajo y otros (recomendado)'), stems: ['vocals', 'drums', 'bass', 'other'] },
  { id: 'htdemucs_ft', description: msg('4 pistas, más calidad (unas 4 veces más lento)'), stems: ['vocals', 'drums', 'bass', 'other'] },
  { id: 'htdemucs_6s', description: msg('6 pistas: añade guitarra y piano (experimental)'),
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
  /** No se pudo conectar con el servidor (hay que arrancarlo o cambiar su dirección). */
  serverUnavailable?: boolean;
}

type ServerEvent =
  | { type: 'status'; message: string }
  | { type: 'progress'; value: number }
  | { type: 'done'; stems: { name: string; url: string }[] }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

/** Los mensajes que envía el servidor (stemlab_server.py y stemlab_separate.py
    los escriben en español): con estas plantillas se muestran en el idioma elegido. */
const serverMessages = [
  msg('En cola: hay otra separación en marcha...'),
  msg('Iniciando Python...'),
  msg('Cargando PyTorch...'),
  msg('Cargando modelo {0} en {1} (la primera vez se descarga)...'),
  msg('Leyendo {0}...'),
  msg('Separando instrumentos ({0})...'),
  msg('Guardando pistas...'),
  msg('El modelo terminó pero no generó ningún stem.'),
  msg('No se recibió ningún audio.'),
  msg('El archivo es demasiado grande (máximo 1 GB).'),
  msg('La separación no existe (quizá ya se borró).'),
  msg('Modelo desconocido: {0}'),
  msg('No se pudo ejecutar Python ({0}): {1}'),
  msg('Python terminó con código {0}:\n\n{1}'),
];

/** Qué hacer cuando no se puede conectar con el servidor de separación. */
function serverHelp(server: string): string {
  const start = tr('La separación por IA la hace Demucs (Python + PyTorch) en el servidor de StemLab Web, '
                   + 'que no puede ejecutarse dentro del navegador ni en Vercel. Ponlo en marcha con el Python '
                   + 'que tiene Demucs instalado:') + '\n\n    python server/stemlab_server.py';
  const desktop = '\n\n' + tr('O instala StemLab para Windows (Ayuda > Descargar StemLab para Windows): separa en tu equipo, sin servidor.');

  if (server === '' && !isLocalPage())
    return tr('Esta web no tiene un servidor de separación configurado.') + '\n\n' + start + '\n\n'
         + tr('Después escribe su dirección en IA > Servidor de separación... '
              + '(http://localhost:8000 si lo has arrancado en este equipo).') + desktop;

  return (server !== '' ? tr('No se pudo conectar con el servidor de separación ({0}).', server)
                        : tr('No se pudo conectar con el servidor de separación.')) + '\n\n' + start + '\n\n'
       + tr('Si está en otra dirección, cámbiala en IA > Servidor de separación... (ver README.md).') + desktop;
}

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
  private server = '';

  getName(): string {
    return 'Demucs';
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
    this.status = tr('Subiendo la canción al servidor de separación...');
    this.jobId = '';
    this.onFinished = onFinished;
    this.server = getSeparationServer();

    const request = new XMLHttpRequest();
    this.upload = request;
    request.open('POST', this.url(`/api/separations?model=${encodeURIComponent(this.currentModel)}&name=${encodeURIComponent(fileName)}`));
    request.responseType = 'json';

    request.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0)
        this.status = tr('Subiendo la canción al servidor de separación... {0} %', Math.round((event.loaded / event.total) * 100));
    };

    request.onerror = () => this.finishUnavailable();
    request.onabort = () => this.finish({ ok: false, cancelled: true, error: tr('Separación cancelada.'), stems: [] });

    request.onload = () => {
      this.upload = null;
      const body = request.response as { id?: string; error?: string } | null;

      if (request.status !== 201 || body?.id === undefined) {
        // Sin servidor de separación detrás (404 de Vercel, proxy de Vite sin Python...).
        if ([0, 404, 502, 504].includes(request.status))
          this.finishUnavailable();
        else
          this.finish({ ok: false, cancelled: false, error: body?.error !== undefined ? trMatching(body.error, serverMessages)
                                                                              : tr('El servidor respondió {0}.', request.status), stems: [] });

        return;
      }

      this.jobId = body.id;
      this.status = tr('Iniciando Python...');
      this.follow(body.id);
    };

    request.send(file);
    return true;
  }

  private follow(jobId: string): void {
    const source = new EventSource(this.url(`/api/separations/${jobId}/events`));
    this.events = source;
    let finished = false;

    source.onmessage = message => {
      const event = JSON.parse(message.data) as ServerEvent;

      switch (event.type) {
        case 'status':
          this.status = trMatching(event.message, serverMessages);
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
          this.finish({ ok: false, cancelled: false, error: trMatching(event.message, serverMessages), stems: [] });
          break;
        case 'cancelled':
          finished = true;
          source.close();
          this.finish({ ok: false, cancelled: true, error: tr('Separación cancelada.'), stems: [] });
          break;
      }
    };

    source.onerror = () => {
      // EventSource reintenta solo; si el servidor ya no conoce la separación
      // (se reinició), no tiene sentido seguir esperando.
      if (finished || this.cancelled)
        return;

      const giveUp = () => {
        if (!finished && !this.cancelled) {
          source.close();
          this.finishUnavailable();
        }
      };

      void fetch(this.url(`/api/separations/${jobId}/events`), { method: 'HEAD' })
        .then(response => { if (!response.ok) giveUp(); }, giveUp);
    };
  }

  private async downloadStems(stems: { name: string; url: string }[]): Promise<void> {
    this.status = tr('Descargando las pistas...');
    this.progress = 1;
    this.downloads = new AbortController();

    try {
      const result: Stem[] = [];

      for (const stem of stems) {
        const response = await fetch(this.url(stem.url), { signal: this.downloads.signal });

        if (!response.ok)
          throw new Error(tr('No se pudo descargar el stem "{0}" ({1}).', stem.name, response.status));

        result.push({ name: stem.name, blob: await response.blob() });
      }

      result.sort((a, b) => stemSortOrder(a.name) - stemSortOrder(b.name));
      this.forget();
      this.finish({ ok: true, cancelled: false, error: '', stems: result });
    } catch (error) {
      this.forget();

      if (this.cancelled)
        this.finish({ ok: false, cancelled: true, error: tr('Separación cancelada.'), stems: [] });
      else
        this.finish({ ok: false, cancelled: false, error: error instanceof Error ? error.message : String(error), stems: [] });
    }
  }

  /** El servidor borra la canción y los stems. */
  private forget(): void {
    if (this.jobId !== '') {
      void fetch(this.url(`/api/separations/${this.jobId}`), { method: 'DELETE' }).catch(() => undefined);
      this.jobId = '';
    }
  }

  /** Rutas de la API en el servidor de esta separación. */
  private url(path: string): string {
    return apiUrl(path, this.server);
  }

  /** No se pudo hablar con el servidor: hay que arrancarlo o cambiar su dirección. */
  private finishUnavailable(): void {
    this.finish({ ok: false, cancelled: false, error: serverHelp(this.server), stems: [], serverUnavailable: true });
  }

  cancel(): void {
    if (!this.busy || this.cancelled)
      return;

    this.cancelled = true;
    this.status = tr('Cancelando...');

    if (this.upload !== null) {
      this.upload.abort();
      return;
    }

    this.downloads?.abort();
    this.events?.close();
    this.forget();
    this.finish({ ok: false, cancelled: true, error: tr('Separación cancelada.'), stems: [] });
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
