/**
    Dirección del servidor de separación (server/stemlab_server.py).

    - Vacía: el mismo origen que la web (npm run dev, o la web servida por el
      propio servidor de Python).
    - Una URL: la web está en otro sitio (por ejemplo, desplegada en Vercel) y
      separa en ese servidor: http://localhost:8000 si corre en este equipo, o
      la dirección pública donde esté instalado.

    Se elige en IA > Servidor de separación (se recuerda en este navegador) o
    al compilar con la variable de entorno VITE_SEPARATION_URL.
*/
import { tr } from '../core/i18n.ts';

const storageKey = 'stemlab.separationServer';

export function normaliseServerUrl(url: string): string {
  url = url.trim().replace(/\/+$/, '').replace(/\/api$/, '');

  if (url !== '' && !/^https?:\/\//i.test(url))
    url = (/^(localhost|127\.|\[::1\])/i.test(url) ? 'http://' : 'https://') + url;

  return url;
}

export function defaultSeparationServer(): string {
  return normaliseServerUrl(String(import.meta.env.VITE_SEPARATION_URL ?? ''));
}

export function getSeparationServer(): string {
  try {
    const saved = localStorage.getItem(storageKey);

    if (saved !== null)
      return normaliseServerUrl(saved);
  } catch {
    // Sin almacenamiento (modo privado): se usa el valor por defecto.
  }

  return defaultSeparationServer();
}

export function setSeparationServer(url: string): string {
  const value = normaliseServerUrl(url);

  try {
    if (value === defaultSeparationServer())
      localStorage.removeItem(storageKey);
    else
      localStorage.setItem(storageKey, value);
  } catch {
    // Se usa solo en esta sesión.
  }

  return value;
}

/** URL completa de una ruta de la API ("/api/health"...). */
export function apiUrl(path: string, server = getSeparationServer()): string {
  return server + path;
}

/** ¿La web se sirve desde este equipo? (entonces el servidor suele estar en el mismo origen). */
export function isLocalPage(): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
}

export interface HealthResult {
  ok: boolean;
  message: string;
}

/** Comprueba que en esa dirección hay un servidor de StemLab Web con Demucs. */
export async function checkSeparationServer(server: string): Promise<HealthResult> {
  const where = server === '' ? tr('esta misma web') : server;

  if (server.startsWith('http://') && location.protocol === 'https:' && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(server))
    return { ok: false, message: tr('Esta web usa HTTPS y el navegador no deja conectar con {0} (HTTP). Usa una dirección HTTPS, o http://localhost si el servidor está en este equipo.', server) };

  try {
    const response = await fetch(apiUrl('/api/health', server), { cache: 'no-store' });
    const body = await response.json().catch(() => null) as { ok?: boolean; scriptFound?: boolean } | null;

    if (!response.ok || body?.ok !== true)
      return { ok: false, message: tr('En {0} no hay un servidor de separación de StemLab Web.', where) };

    if (body.scriptFound === false)
      return { ok: false, message: tr('El servidor de {0} no encuentra stemlab_separate.py.', where) };

    return { ok: true, message: tr('Conectado con el servidor de separación de {0}.', where) };
  } catch {
    return { ok: false, message: tr('No se pudo conectar con {0}. ¿Está en marcha el servidor de separación?', where) };
  }
}
