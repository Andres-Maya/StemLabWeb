/**
    Fragmentos de audio (clips) y su edición no destructiva: dividir,
    recortar o mover solo cambia estos números; el audio nunca se modifica.

        línea de tiempo:  [timelineStart ........ timelineStart + length)
        audio original:   [sourceOffset  ........ sourceOffset  + length)
*/
import { computePeaks, type WaveformPeaks } from '../audio/peaks.ts';

/** Audio decodificado (estéreo, a la frecuencia del motor). Lo comparten todos
    los clips que salen del mismo archivo. */
export interface ClipSource {
  readonly id: number;
  name: string;                 // nombre del archivo (sin extensión)
  readonly left: Float32Array;
  readonly right: Float32Array; // el mismo array que left si el audio es mono
  readonly length: number;
  readonly sampleRate: number;
  /** Archivo original (se sube a la separación y se descarga tal cual). Las
      grabaciones no tienen: se codifican a WAV cuando hace falta. */
  blob: Blob | null;
  readonly peaks: WaveformPeaks;
}

let nextSourceId = 1;

export function createSource(name: string, left: Float32Array, right: Float32Array, sampleRate: number,
                             blob: Blob | null): ClipSource {
  return {
    id: nextSourceId++, name, left, right, length: left.length, sampleRate, blob,
    peaks: computePeaks(left, right),
  };
}

export interface AudioClip {
  id: number;
  source: ClipSource;
  timelineStart: number;
  sourceOffset: number;
  length: number;
}

let nextClipId = 1;

export function createClipId(): number {
  return nextClipId++;
}

export const clipEnd = (clip: AudioClip) => clip.timelineStart + clip.length;
export const clipContains = (clip: AudioClip, position: number) =>
  position >= clip.timelineStart && position < clipEnd(clip);

/** Longitud mínima de un clip tras recortarlo o dividirlo (~1,5 ms). */
const minimumLength = 64;

function find(clips: AudioClip[], clipId: number): AudioClip | undefined {
  return clips.find(c => c.id === clipId);
}

function copyList(clips: readonly AudioClip[]): AudioClip[] {
  return clips.map(c => ({ ...c }));
}

/** Divide el clip en la posición dada. Devuelve el id de la mitad derecha, o 0. */
function split(clips: AudioClip[], clipId: number, timelinePosition: number): number {
  const index = clips.findIndex(c => c.id === clipId);

  if (index < 0)
    return 0;

  const clip = clips[index];

  if (timelinePosition < clip.timelineStart + minimumLength || timelinePosition > clipEnd(clip) - minimumLength)
    return 0;

  const leftLength = timelinePosition - clip.timelineStart;
  const right: AudioClip = {
    ...clip,
    id: createClipId(),
    timelineStart: timelinePosition,
    sourceOffset: clip.sourceOffset + leftLength,
    length: clip.length - leftLength,
  };

  clips[index] = { ...clip, length: leftLength };

  // La mitad derecha va justo detrás: conserva el mismo orden de apilado.
  clips.splice(index + 1, 0, right);
  return right.id;
}

/** Mueve el borde izquierdo (reduce o recupera el principio del clip). */
function trimStart(clip: AudioClip, newTimelineStart: number): void {
  // Límites: no ir antes del principio del audio original, ni antes del 0,
  // ni dejar el clip más corto que el mínimo.
  const earliest = Math.max(0, clip.timelineStart - clip.sourceOffset);
  const latest = clipEnd(clip) - minimumLength;
  newTimelineStart = Math.min(Math.max(earliest, latest), Math.max(earliest, newTimelineStart));

  const delta = newTimelineStart - clip.timelineStart;
  clip.timelineStart = newTimelineStart;
  clip.sourceOffset += delta;
  clip.length -= delta;
}

/** Mueve el borde derecho (reduce o recupera el final del clip). */
function trimEnd(clip: AudioClip, newTimelineEnd: number): void {
  const available = clip.source.length - clip.sourceOffset;
  const lowest = clip.timelineStart + minimumLength;
  const highest = clip.timelineStart + Math.max(minimumLength, available);
  newTimelineEnd = Math.min(highest, Math.max(lowest, newTimelineEnd));
  clip.length = newTimelineEnd - clip.timelineStart;
}

/** Quita el clip de la lista. Devuelve true si existía. */
function remove(clips: AudioClip[], clipId: number): boolean {
  const index = clips.findIndex(c => c.id === clipId);

  if (index < 0)
    return false;

  clips.splice(index, 1);
  return true;
}

//============================================================================
// En una pista los fragmentos no se solapan: grabar, pegar, mover y recortar
// siempre dejan cada fragmento en espacio libre. Para grabar encima de otro
// audio se usa otra pista.

/** Primera posición >= position donde cabe un clip de esa longitud sin
    solaparse con ninguno (si el cabezal está sobre audio, justo después). */
function findFreeSpace(clips: readonly AudioClip[], position: number, length: number): number {
  position = Math.max(0, position);
  length = Math.max(1, length);

  // Mientras algún clip ocupe parte de [position, position + length), se
  // salta a su final. Termina porque position solo avanza.
  for (let moved = true; moved;) {
    moved = false;

    for (const clip of clips) {
      if (clip.length > 0 && clip.timelineStart < position + length && clipEnd(clip) > position) {
        position = clipEnd(clip);
        moved = true;
      }
    }
  }

  return position;
}

/** Hueco libre que empieza en findFreeSpace(position, 1): [inicio, inicio
    del siguiente clip), o hasta el infinito si no hay ninguno detrás. */
function freeGapAt(clips: readonly AudioClip[], position: number): [number, number] {
  const start = findFreeSpace(clips, position, 1);
  let end = Number.MAX_SAFE_INTEGER;

  for (const clip of clips)
    if (clip.length > 0 && clip.timelineStart >= start)
      end = Math.min(end, clip.timelineStart);

  return [start, end];
}

/** Mueve el clip (arrastrarlo) sin que se solape con los demás:
      - Mientras su centro no pase del centro de un vecino, se detiene al tocarlo.
      - Si lo pasa, salta al otro lado del vecino, al hueco siguiente.
      - Si en ese hueco no cabe, se abre espacio: los clips que quedan por
        delante se desplazan todos juntos lo justo (mantienen sus distancias).
    Devuelve una lista nueva con los cambios; conserva el orden de la lista. */
function moveWithoutOverlap(original: readonly AudioClip[], clipId: number, newStart: number): AudioClip[] {
  const clips = copyList(original);
  const moving = find(clips, clipId);

  if (moving === undefined)
    return clips;

  const length = moving.length;
  const start = Math.max(0, newStart);
  const others = clips.filter(c => c.id !== clipId && c.length > 0)
                      .sort((a, b) => a.timelineStart - b.timelineStart);

  // Hueco que le toca: detrás de los clips cuyo centro ya ha pasado (se
  // comparan los dobles para no perder la media muestra).
  const centreTimesTwo = 2 * start + length;
  let index = 0;
  let lowest = 0;

  while (index < others.length && 2 * others[index].timelineStart + others[index].length < centreTimesTwo)
    lowest = Math.max(lowest, clipEnd(others[index++]));

  const highest = index < others.length ? others[index].timelineStart : Number.MAX_SAFE_INTEGER;

  if (highest - lowest >= length) {
    // Cabe: se coloca donde se soltó, sin pasar de los vecinos del hueco.
    moving.timelineStart = Math.min(highest - length, Math.max(lowest, start));
    return clips;
  }

  // No cabe: se abre espacio desplazando todos los de delante a la vez.
  moving.timelineStart = Math.max(lowest, start);
  const shift = clipEnd(moving) - highest;

  for (let i = index; i < others.length; ++i)
    others[i].timelineStart += shift;

  return clips;
}

/** Límites para recortar el clip sin pisar a sus vecinos: el fin del
    anterior y el principio del siguiente. */
function freeRangeAround(clips: readonly AudioClip[], clip: AudioClip): [number, number] {
  let lowest = 0;
  let highest = Number.MAX_SAFE_INTEGER;

  for (const other of clips) {
    if (other.id === clip.id || other.length <= 0)
      continue;

    if (clipEnd(other) <= clip.timelineStart)
      lowest = Math.max(lowest, clipEnd(other));
    else if (other.timelineStart >= clipEnd(clip))
      highest = Math.min(highest, other.timelineStart);
  }

  return [lowest, highest];
}

/** Recorta un clip nuevo (una grabación) al hueco libre donde empieza: el
    principio se lleva al final del audio que lo tape y el final, al
    principio del siguiente clip. Devuelve false si no queda nada. */
function fitIntoFreeSpace(existing: readonly AudioClip[], clip: AudioClip): boolean {
  const [gapStart, gapEnd] = freeGapAt(existing, clip.timelineStart);
  const start = Math.max(gapStart, clip.timelineStart);
  const end = Math.min(gapEnd, clipEnd(clip));

  if (end - start < minimumLength)
    return false;

  clip.sourceOffset += start - clip.timelineStart;
  clip.timelineStart = start;
  clip.length = end - start;
  return true;
}

/** Operaciones de edición sobre copias de la lista de clips. */
export const ClipEditing = {
  minimumLength,
  find,
  copyList,
  split,
  trimStart,
  trimEnd,
  remove,
  findFreeSpace,
  freeGapAt,
  moveWithoutOverlap,
  freeRangeAround,
  fitIntoFreeSpace,
};
