/**
    StemLab para Windows: el instalador de la versión de escritorio.

    El .exe no está en esta web: lo genera el repositorio de StemLab
    (installer/build-installer.ps1) y GitHub Actions lo publica en sus releases
    al crear una versión. La web consulta cuál es la última, así que no hay que
    tocarla al publicar una versión nueva.
*/
import { openDialog } from './dialogs.ts';
import { h } from './dom.ts';

const repository = 'Andres-Maya/StemLab';
const installerName = 'StemLab-Setup.exe';
const latestReleaseApi = `https://api.github.com/repos/${repository}/releases/latest`;

/** Descarga de la última versión publicada (si la API de GitHub no responde). */
export const latestInstallerUrl = `https://github.com/${repository}/releases/latest/download/${installerName}`;

export interface InstallerRelease {
  version: string;       // "0.1.0"
  url: string;           // descarga directa del .exe
  sizeBytes: number;
}

/** El instalador de una release (la respuesta de la API de GitHub), o null si no lo tiene. */
export function installerFromRelease(release: unknown): InstallerRelease | null {
  const { tag_name: tag, assets } = (release ?? {}) as { tag_name?: unknown; assets?: unknown };
  const asset = (Array.isArray(assets) ? assets : [])
    .find((a: { name?: unknown }) => a?.name === installerName) as { browser_download_url?: unknown; size?: unknown } | undefined;

  if (typeof asset?.browser_download_url !== 'string')
    return null;

  return {
    version: typeof tag === 'string' ? tag.replace(/^v/, '') : '',
    url: asset.browser_download_url,
    sizeBytes: typeof asset.size === 'number' ? asset.size : 0,
  };
}

type Lookup = { state: 'available'; release: InstallerRelease } | { state: 'none' } | { state: 'unknown' };

let lookup: Promise<Lookup> | null = null;

/** La última versión publicada: una consulta por sesión (la API limita las
    peticiones); si falla por la red, se vuelve a intentar la próxima vez. */
function latestInstaller(): Promise<Lookup> {
  lookup ??= fetch(latestReleaseApi, { headers: { Accept: 'application/vnd.github+json' } })
    .then(async (response): Promise<Lookup> => {
      if (response.status === 404)
        return { state: 'none' };              // todavía no hay ninguna release

      if (!response.ok)
        throw new Error(String(response.status));

      const release = installerFromRelease(await response.json());
      return release === null ? { state: 'none' } : { state: 'available', release };
    })
    .catch((): Lookup => {
      lookup = null;
      return { state: 'unknown' };
    });

  return lookup;
}

/** Explica qué es StemLab para Windows y descarga su instalador. */
export function showDesktopDownloadDialog(): void {
  const status = h('p', { className: 'dialog-hint', role: 'status', text: 'Buscando la última versión...' });
  const content = h('div', {},
    h('p', { text: 'StemLab para Windows es la versión de escritorio: la misma mini-DAW, instalada en tu equipo.' }),
    h('ul', { className: 'feature-list' },
      h('li', { text: 'Separa los instrumentos sin servidor: lleva Python y Demucs incluidos.' }),
      h('li', { text: 'Guarda y abre proyectos (.stemlab) con todo su audio.' }),
      h('li', { text: 'Graba con tu tarjeta de sonido en modo RAW, sin los efectos de Windows.' })),
    h('p', { className: 'dialog-hint', text: 'Windows 10 u 11 de 64 bits. Se instala solo para tu usuario, sin permisos de '
      + 'administrador. Como el instalador no está firmado, Windows puede avisar: pulsa «Más información» y «Ejecutar de '
      + 'todas formas».' }),
    status);

  let url = latestInstallerUrl;
  const dialog = openDialog('StemLab para Windows', content, [
    { label: 'Cancelar', value: 0 },
    { label: 'Descargar el instalador', value: 1, primary: true },
  ], value => {
    // En otra pestaña: la descarga no cierra esta sesión (ni pide confirmarlo).
    if (value === 1 && !download.disabled)
      window.open(url, '_blank', 'noopener');
  }, { icon: 'info', wide: true });

  const download = dialog.element.querySelector<HTMLButtonElement>('.dialog-button.primary')!;

  void latestInstaller().then(result => {
    if (result.state === 'available') {
      const { version, sizeBytes } = result.release;
      url = result.release.url;
      status.textContent = `Versión ${version}` + (sizeBytes > 0 ? ` · ${Math.round(sizeBytes / 1048576)} MB` : '') + ' · StemLab-Setup.exe';
    } else if (result.state === 'none') {
      download.disabled = true;
      status.textContent = 'Todavía no hay ninguna versión publicada para descargar.';
    } else {
      status.textContent = 'No se pudo comprobar la última versión: se descargará la más reciente publicada.';
    }
  });
}
