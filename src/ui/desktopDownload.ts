/**
    StemLab de escritorio: las descargas para Windows y para Linux.

    Los archivos no están en esta web: los genera el repositorio de StemLab
    (installer/build-installer.ps1 y installer/build-linux.sh) y GitHub Actions
    los publica en sus releases al crear una versión. La web consulta cuál es
    la última, así que no hay que tocarla al publicar una versión nueva.
*/
import { tr } from '../core/i18n.ts';
import { openDialog } from './dialogs.ts';
import { h } from './dom.ts';

const repository = 'Andres-Maya/StemLab';
const latestReleaseApi = `https://api.github.com/repos/${repository}/releases/latest`;

export type DesktopPlatform = 'windows' | 'linux';

/** El archivo que publica cada plataforma en la release. */
export const desktopPackages: Record<DesktopPlatform, { name: string; file: string }> = {
  windows: { name: 'Windows', file: 'StemLab-Setup.exe' },
  linux: { name: 'Linux', file: 'StemLab-Linux-x86_64.tar.gz' },
};

const platforms = Object.keys(desktopPackages) as DesktopPlatform[];

/** Descarga de la última versión publicada (si la API de GitHub no responde). */
export function latestInstallerUrl(platform: DesktopPlatform): string {
  return `https://github.com/${repository}/releases/latest/download/${desktopPackages[platform].file}`;
}

export interface InstallerRelease {
  version: string;       // "0.2.0"
  url: string;           // descarga directa del archivo
  sizeBytes: number;
}

/** La descarga de una plataforma en una release (la respuesta de la API de
    GitHub), o null si esa release no la tiene. */
export function installerFromRelease(release: unknown, platform: DesktopPlatform = 'windows'): InstallerRelease | null {
  const { tag_name: tag, assets } = (release ?? {}) as { tag_name?: unknown; assets?: unknown };
  const asset = (Array.isArray(assets) ? assets : [])
    .find((a: { name?: unknown }) => a?.name === desktopPackages[platform].file) as { browser_download_url?: unknown; size?: unknown } | undefined;

  if (typeof asset?.browser_download_url !== 'string')
    return null;

  return {
    version: typeof tag === 'string' ? tag.replace(/^v/, '') : '',
    url: asset.browser_download_url,
    sizeBytes: typeof asset.size === 'number' ? asset.size : 0,
  };
}

/** La plataforma de quien visita la web (para ofrecerle primero su descarga),
    o null si StemLab de escritorio no existe para ella (macOS, móviles...). */
export function detectDesktopPlatform(userAgent: string): DesktopPlatform | null {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent))
    return null;

  if (/Windows/i.test(userAgent))
    return 'windows';

  if (/Linux|X11|CrOS/i.test(userAgent) && !/Mac OS X|Macintosh/i.test(userAgent))
    return /CrOS/i.test(userAgent) ? null : 'linux';

  return null;
}

type Lookup =
  | { state: 'known'; releases: Record<DesktopPlatform, InstallerRelease | null> }     // null: esa release no la trae
  | { state: 'none' }                                                                  // todavía no hay ninguna release
  | { state: 'unknown' };                                                              // GitHub no respondió

let lookup: Promise<Lookup> | null = null;

/** La última versión publicada: una consulta por sesión (la API limita las
    peticiones); si falla por la red, se vuelve a intentar la próxima vez. */
function latestInstallers(): Promise<Lookup> {
  lookup ??= fetch(latestReleaseApi, { headers: { Accept: 'application/vnd.github+json' } })
    .then(async (response): Promise<Lookup> => {
      if (response.status === 404)
        return { state: 'none' };

      if (!response.ok)
        throw new Error(String(response.status));

      const release: unknown = await response.json();
      return { state: 'known', releases: { windows: installerFromRelease(release, 'windows'), linux: installerFromRelease(release, 'linux') } };
    })
    .catch((): Lookup => {
      lookup = null;
      return { state: 'unknown' };
    });

  return lookup;
}

/** Explica qué es StemLab de escritorio y descarga el de Windows o el de Linux. */
export function showDesktopDownloadDialog(): void {
  // Primero, el botón de la plataforma de quien visita (Windows si no se sabe).
  const own = detectDesktopPlatform(navigator.userAgent) ?? 'windows';
  const order = [...platforms.filter(p => p !== own), own];

  const status = h('p', { className: 'dialog-hint', role: 'status', text: tr('Buscando la última versión...') });
  const content = h('div', {},
    h('p', { text: tr('StemLab de escritorio es la misma mini-DAW instalada en tu equipo, para Windows y para Linux.') }),
    h('ul', { className: 'feature-list' },
      h('li', { text: tr('Separa los instrumentos sin servidor: lleva Python y Demucs incluidos.') }),
      h('li', { text: tr('Guarda y abre proyectos (.stemlab) con todo su audio.') }),
      h('li', { text: tr('Graba directamente con tu tarjeta de sonido (en Windows, en modo RAW: sin los efectos del sistema).') })),
    h('p', { className: 'dialog-hint', text: tr('Windows: 10 u 11 de 64 bits. Se instala solo para tu usuario, sin permisos de '
      + 'administrador. Como el instalador no está firmado, Windows puede avisar: pulsa «Más información» y «Ejecutar de '
      + 'todas formas».') }),
    h('p', { className: 'dialog-hint', text: tr('Linux: 64 bits (x86_64) con glibc 2.39 o posterior (Ubuntu 24.04, Fedora 40, Debian 13...). '
      + 'Descomprime el archivo y abre ./StemLab; ./install.sh lo añade al menú de aplicaciones.') }),
    status);

  const urls: Record<DesktopPlatform, string | null> = { windows: latestInstallerUrl('windows'), linux: latestInstallerUrl('linux') };

  const dialog = openDialog(tr('StemLab de escritorio'), content, [
    { label: tr('Cancelar'), value: 0 },
    ...order.map((platform, i) => ({ label: tr('Descargar para {0}', desktopPackages[platform].name), value: i + 1, primary: platform === own })),
  ], value => {
    const url = value > 0 ? urls[order[value - 1]] : null;

    // En otra pestaña: la descarga no cierra esta sesión (ni pide confirmarlo).
    if (url !== null)
      window.open(url, '_blank', 'noopener');
  }, { icon: 'info', wide: true });

  // Los botones de descarga, en el orden en que se crearon (después de Cancelar).
  const buttons = [...dialog.element.querySelectorAll<HTMLButtonElement>('.dialog-buttons .dialog-button')].slice(1);

  void latestInstallers().then(result => {
    if (result.state === 'unknown') {
      status.textContent = tr('No se pudo comprobar la última versión: se descargará la más reciente publicada.');
      return;
    }

    const lines: string[] = [];

    order.forEach((platform, i) => {
      const { name, file } = desktopPackages[platform];
      const release = result.state === 'known' ? result.releases[platform] : null;

      if (release === null) {
        urls[platform] = null;
        buttons[i].disabled = true;
        buttons[i].textContent = tr('{0}: aún no disponible', name);
        return;
      }

      urls[platform] = release.url;
      lines.push(`${name}: ` + tr('versión {0}', release.version)
                 + (release.sizeBytes > 0 ? ` · ${Math.round(release.sizeBytes / 1048576)} MB` : '') + ` · ${file}`);
    });

    status.textContent = lines.length > 0 ? lines.reverse().join('\n') : tr('Todavía no hay ninguna versión publicada para descargar.');
    status.style.whiteSpace = 'pre-line';
  });
}
