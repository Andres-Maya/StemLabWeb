import { msg, tr } from './i18n.ts';

/** Formatea segundos como mm:ss.mmm */
export function formatTime(seconds: number): string {
  seconds = Math.max(0, seconds);
  const totalMillis = Math.floor(seconds * 1000);
  const minutes = Math.floor(totalMillis / 60000);
  const secs = Math.floor(totalMillis / 1000) % 60;
  const millis = totalMillis % 1000;

  return String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0') + '.' + String(millis).padStart(3, '0');
}

const knownStems: [string, string][] = [
  ['vocals', msg('Voz')],
  ['drums', msg('Batería')],
  ['bass', msg('Bajo')],
  ['guitar', msg('Guitarra')],
  ['piano', msg('Piano')],
  ['other', msg('Otros')],
];

/** Nombre de un stem en el idioma de la interfaz ("vocals" → "Voz"). */
export function stemDisplayName(stemId: string): string {
  const name = knownStems.find(([id]) => id === stemId)?.[1];
  return name !== undefined ? tr(name) : stemId;
}

/** Orden de presentación de los stems (voz, batería, bajo, guitarra, piano, otros). */
export function stemSortOrder(stemId: string): number {
  const index = knownStems.findIndex(([id]) => id === stemId);
  return index < 0 ? knownStems.length : index;
}
