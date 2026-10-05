/**
    Tema de la interfaz: oscuro (el de siempre) o claro.

    Los colores de la página son variables CSS que cambian con el atributo
    data-theme de <html> (styles.css); los de los lienzos, Palette (colour.ts).
*/
import { setPaletteTheme, type Theme } from './colour.ts';

const storageKey = 'stemlab.theme';
const listeners = new Set<() => void>();
let theme: Theme = 'dark';

function apply(): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  setPaletteTheme(theme);
}

export function getTheme(): Theme {
  return theme;
}

export function setTheme(next: Theme): void {
  if (next === theme)
    return;

  theme = next;
  apply();

  try { localStorage.setItem(storageKey, next); } catch { /* sin almacenamiento */ }

  for (const listener of [...listeners])
    listener();
}

/** Avisa al cambiar de tema (después de actualizar Palette). */
export function onThemeChange(listener: () => void): void {
  listeners.add(listener);
}

/** Al arrancar: el tema guardado (oscuro si nunca se eligió). */
export function initTheme(): void {
  let saved: string | null = null;

  try { saved = localStorage.getItem(storageKey); } catch { /* sin almacenamiento */ }

  theme = saved === 'light' ? 'light' : 'dark';
  apply();
}
