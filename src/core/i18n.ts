/**
    Idioma de la interfaz.

    El código está escrito en español y ese texto es la clave de la traducción:
    tr('Añadir pista') devuelve el texto en el idioma elegido (o el mismo texto
    si es español o falta la traducción). Los datos variables van con {0}, {1}...

        tr('Pista "{0}" eliminada.', track.name)

    Un idioma nuevo es un diccionario más en core/lang/ (ver lang/en.ts) y una
    entrada en `languages`. No usa el DOM: también lo importa el modelo.
*/
import { en } from './lang/en.ts';

export type Language = 'es' | 'en';

export const languages: readonly { id: Language; name: string }[] = [
  { id: 'es', name: 'Español' },
  { id: 'en', name: 'English' },
];

const dictionaries: Partial<Record<Language, Record<string, string>>> = { en };
const storageKey = 'stemlab.language';
const listeners = new Set<() => void>();
let language: Language = 'es';

function format(text: string, args: readonly (string | number)[]): string {
  return args.length === 0 ? text : text.replace(/\{(\d+)\}/g, (match, index) => String(args[Number(index)] ?? match));
}

/** El texto en el idioma actual. */
export function tr(source: string, ...args: (string | number)[]): string {
  return format(dictionaries[language]?.[source] ?? source, args);
}

/** Marca un texto que se traducirá más tarde con tr() (nombres de parámetros,
    de acciones de deshacer...): así las pruebas comprueban que tiene traducción. */
export const msg = (source: string): string => source;

/** Un texto que sigue al idioma: los elementos fijos de la página lo reciben
    en `h(..., { text: L('Entrada') })` y se actualizan solos al cambiarlo. */
export class Localised {
  readonly source: string;
  readonly args: readonly (string | number)[];

  constructor(source: string, args: readonly (string | number)[]) {
    this.source = source;
    this.args = args;
  }

  toString(): string {
    return tr(this.source, ...this.args);
  }
}

export const L = (source: string, ...args: (string | number)[]): Localised => new Localised(source, args);

/** Traduce un texto que llega ya compuesto (los mensajes del servidor de
    separación): busca la plantilla de `patterns` que lo produce. */
export function trMatching(text: string, patterns: readonly string[]): string {
  if (language === 'es')
    return text;

  for (const pattern of patterns) {
    const expression = pattern.replace(/[.*+?^$()[\]\\|]/g, '\\$&').replace(/\{\d+\}/g, '(.+)');
    const match = new RegExp('^' + expression + '$', 's').exec(text);

    if (match !== null) {
      // Los grupos salen en el orden en que aparecen {n} en la plantilla.
      const order = [...pattern.matchAll(/\{(\d+)\}/g)].map(m => Number(m[1]));
      const args: string[] = [];
      order.forEach((index, group) => { args[index] = match[group + 1]; });
      return tr(pattern, ...args);
    }
  }

  return text;
}

export function getLanguage(): Language {
  return language;
}

export function setLanguage(next: Language): void {
  if (next === language || !languages.some(l => l.id === next))
    return;

  language = next;

  try { globalThis.localStorage?.setItem(storageKey, next); } catch { /* sin almacenamiento */ }

  for (const listener of [...listeners])
    listener();
}

/** Avisa al cambiar de idioma. Devuelve la función que deja de escuchar. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Al arrancar: el idioma guardado o, la primera vez, el del navegador. */
export function initLanguage(): void {
  let saved: string | null = null;

  try { saved = globalThis.localStorage?.getItem(storageKey) ?? null; } catch { /* sin almacenamiento */ }

  const wanted = saved ?? (globalThis.navigator?.language ?? 'es').slice(0, 2).toLowerCase();
  language = languages.find(l => l.id === wanted)?.id ?? 'en';
}
