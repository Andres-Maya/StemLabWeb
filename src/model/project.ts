/**
    Coordina la sesión con el motor de audio: importar audio, crear pistas,
    convertir grabaciones o stems en clips, carpetas y deshacer / rehacer.

    En la web no hay carpeta de proyecto ni guardado en la nube: todo vive en
    la memoria de esta pestaña y se descarga con Archivo > Exportar / descargar.
    Avisa (onChange) cada vez que cambian las pistas o los datos de la sesión.
*/
import type { AudioEngine, RecordingInfo } from '../audio/engine.ts';
import { baseName, decodeAudio } from '../audio/decode.ts';
import { ClipEditing, createClipId, createSource, type AudioClip, type ClipSource } from './clip.ts';
import { AudioTrack, type TrackFolder } from './track.ts';
import { UndoManager, type UndoableAction } from './undo.ts';

export type Result = { ok: true } | { ok: false; error: string };
export const ok: Result = { ok: true };
export const fail = (error: string): Result => ({ ok: false, error });

export interface NewTrack {
  name: string;
  source: ClipSource;
  startSample: number;
  // Pistas de una separación: carpeta en la que se muestran y su origen.
  folderId?: string;
  stemGroup?: string;
  stemId?: string;
}

export class ProjectManager {
  readonly engine: AudioEngine;
  tracks: AudioTrack[] = [];
  folders: TrackFolder[] = [];
  readonly undoManager = new UndoManager(200);
  name = 'Proyecto sin título';
  bpm = 120;

  // Se incrementa al empezar un proyecto nuevo: las cargas en curso del
  // anterior se descartan al terminar.
  private generation = 0;
  private pendingLoads = 0;
  private listeners = new Set<() => void>();
  private watched = new WeakSet<AudioTrack>();

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Avisa a la interfaz (sin tocar el motor). */
  sendChangeMessage(): void {
    for (const listener of [...this.listeners])
      listener();
  }

  isLoading(): boolean {
    return this.pendingLoads > 0;
  }

  hasContent(): boolean {
    return this.tracks.length > 0;
  }

  setBpm(bpm: number): void {
    this.bpm = Math.min(300, Math.max(20, bpm));
    this.sendChangeMessage();
  }

  /** Los cambios de volumen, efectos... de la pista llegan al motor al momento. */
  private watch(track: AudioTrack): void {
    if (this.watched.has(track))
      return;

    this.watched.add(track);

    for (const parameter of track.allParameters())
      parameter.onChange(() => this.engine.sendTrackParams(track));
  }

  /** Avisar tras editar clips o pistas (actualiza el motor y la interfaz). */
  notifyTracksEdited(): void {
    this.tracks.forEach(t => this.watch(t));
    this.engine.syncTracks(this.tracks);
    this.sendChangeMessage();
  }

  getContentLength(): number {
    return this.tracks.reduce((end, t) => Math.max(end, t.getEndSample()), 0);
  }

  //============================================================================
  /** Sesión vacía: se descarta todo (lo que no se haya descargado se pierde). */
  newProject(): void {
    ++this.generation;
    this.undoManager.clear();
    this.folders = [];
    this.engine.stop();

    for (const track of this.tracks)
      track.armed = false;

    this.tracks = [];
    this.engine.masterVolume.resetToDefault();
    this.name = 'Proyecto sin título';
    this.notifyTracksEdited();
  }

  //============================================================================
  // Pistas

  /** Decodifica los archivos y los añade como pistas nuevas (un solo paso del historial). */
  async importFiles(files: File[]): Promise<Result> {
    const generation = this.generation;
    const errors: string[] = [];
    const tracks: NewTrack[] = [];

    ++this.pendingLoads;
    this.sendChangeMessage();

    try {
      for (const file of files) {
        try {
          const source = await decodeAudio(this.engine.context, file, baseName(file.name));
          tracks.push({ name: baseName(file.name), source, startSample: 0 });
        } catch (error) {
          errors.push(file.name + ': ' + (error instanceof Error ? error.message : String(error)));
        }
      }
    } finally {
      --this.pendingLoads;
    }

    if (generation !== this.generation) {
      this.sendChangeMessage();
      return ok;
    }

    this.addTracks(tracks, 'Importar audio');
    return errors.length === 0 ? ok : fail(errors.join('\n'));
  }

  /** Suma una carga pendiente (p. ej. mientras se descargan los stems). */
  beginLoading(): () => void {
    ++this.pendingLoads;
    this.sendChangeMessage();
    let done = false;

    return () => {
      if (!done) {
        done = true;
        --this.pendingLoads;
        this.sendChangeMessage();
      }
    };
  }

  /** Añade las pistas; todas juntas son un solo paso del historial. */
  addTracks(newTracks: NewTrack[], undoName: string): AudioTrack[] {
    const created: AudioTrack[] = [];
    let startedTransaction = false;

    for (const request of newTracks) {
      const clip = this.makeClip(request.source, request.startSample);

      if (clip === null)
        continue;

      const track = new AudioTrack(request.name);
      track.setClips([clip]);
      track.folderId = request.folderId ?? '';
      track.stemGroup = request.stemGroup ?? '';
      track.stemId = request.stemId ?? '';

      if (!startedTransaction)
        this.undoManager.beginNewTransaction(undoName);

      startedTransaction = true;
      this.undoManager.perform(new TrackPresenceAction('add', this, track));
      created.push(track);
    }

    this.notifyTracksEdited();
    return created;
  }

  /** Clip con todo el audio desde la posición indicada. Si empezaría antes del
      0 (grabación con compensación de latencia) se recorta por el principio. */
  private makeClip(source: ClipSource, startSample: number): AudioClip | null {
    let start = Math.round(startSample);
    let offset = 0;
    let length = source.length;

    if (start < 0) {
      offset -= start;
      length += start;
      start = 0;
    }

    if (length < ClipEditing.minimumLength)
      return null;

    return { id: createClipId(), source, timelineStart: start, sourceOffset: offset, length };
  }

  /** Crea una pista vacía (p. ej. para grabar en ella) en la posición
      indicada, o al final si insertIndex < 0. */
  addEmptyTrack(baseName: string, insertIndex = -1, folderId = ''): AudioTrack {
    const track = new AudioTrack(this.createTrackName(baseName));
    track.folderId = folderId;
    this.performUndoable(new TrackPresenceAction('add', this, track, insertIndex), 'Añadir pista');
    return track;
  }

  /** Inserta una copia de la pista (Pegar pista). Si el nombre ya existe se añade "(copia)". */
  pasteTrack(copyFrom: AudioTrack, insertIndex = -1): AudioTrack {
    const track = copyFrom.createCopy(this.createCopyName(copyFrom.name));

    // Fuera de una carpeta que ya no existe.
    if (this.findFolder(track.folderId) === undefined)
      track.folderId = '';

    this.performUndoable(new TrackPresenceAction('add', this, track, insertIndex), 'Pegar pista');
    return track;
  }

  removeTrack(track: AudioTrack, actionName = 'Eliminar pista'): void {
    if (this.tracks.includes(track))
      this.performUndoable(new TrackPresenceAction('remove', this, track), actionName);
  }

  /** Cambia el orden (solo visual: no afecta al sonido). */
  moveTrack(fromIndex: number, toIndex: number): void {
    const size = this.tracks.length;

    if (fromIndex < 0 || fromIndex >= size || toIndex < 0 || toIndex >= size || fromIndex === toIndex)
      return;

    const [track] = this.tracks.splice(fromIndex, 1);
    this.tracks.splice(toIndex, 0, track);
  }

  /** Anota un cambio de orden que ya se aplicó (arrastrar la cabecera, Alt+flechas). */
  trackMoved(track: AudioTrack, fromIndex: number, toIndex: number): void {
    if (fromIndex !== toIndex)
      this.performUndoable(new MoveTrackAction(this, track, fromIndex, toIndex), 'Mover pista');
  }

  /** Anota un cambio de nombre que ya se aplicó a la pista. */
  trackRenamed(track: AudioTrack, oldName: string): void {
    if (track.name !== oldName)
      this.performUndoable(new RenameTrackAction(this, track, oldName, track.name), 'Cambiar nombre de la pista');
  }

  //============================================================================
  // Carpetas (las crea la separación por IA)

  findFolder(folderId: string): TrackFolder | undefined {
    return folderId === '' ? undefined : this.folders.find(f => f.id === folderId);
  }

  addFolder(folder: TrackFolder): void {
    this.folders.push(folder);
    this.sendChangeMessage();
  }

  setFolderExpanded(folderId: string, expanded: boolean): void {
    const folder = this.findFolder(folderId);

    if (folder !== undefined && folder.expanded !== expanded) {
      folder.expanded = expanded;
      this.sendChangeMessage();
    }
  }

  /** Pistas que se muestran en la carpeta, en orden. */
  getFolderTracks(folderId: string): AudioTrack[] {
    return folderId === '' ? [] : this.tracks.filter(t => t.folderId === folderId);
  }

  /** Pistas que generó la separación de esa carpeta (estén dentro o no). */
  getStemTracks(folderId: string): AudioTrack[] {
    return folderId === '' ? [] : this.tracks.filter(t => t.stemGroup === folderId);
  }

  /** Meter la pista en una carpeta, sacarla (folderId vacío) o cambiarla de
      sitio, y dejarla en esa posición. Se puede deshacer. */
  moveTrackToFolder(track: AudioTrack, folderId: string, index: number): void {
    if (!this.tracks.includes(track))
      return;

    const sameFolder = track.folderId === folderId;

    if (sameFolder && this.tracks.indexOf(track) === index)
      return;

    const name = sameFolder ? 'Mover pista'
               : folderId === '' ? 'Sacar de la carpeta'
               : track.folderId === '' ? 'Meter en la carpeta'
               : 'Mover a otra carpeta';

    this.performUndoable(new FolderMoveAction(this, track, folderId, index), name);
  }

  /** Elimina la carpeta con las pistas que tiene dentro (las que se sacaron
      de ella se quedan). Es un solo paso del historial. */
  removeFolder(folderId: string): void {
    const folder = this.findFolder(folderId);

    if (folder === undefined)
      return;

    this.undoManager.beginNewTransaction('Eliminar carpeta');

    for (const track of this.getFolderTracks(folderId))
      this.undoManager.perform(new TrackPresenceAction('remove', this, track));

    this.undoManager.perform(new FolderPresenceAction(this, folder));
  }

  //============================================================================
  // Grabación

  getArmedTrack(): AudioTrack | undefined {
    return this.tracks.find(t => t.armed);
  }

  /** Pista en la que se está grabando (solo una). */
  setArmedTrack(armed: AudioTrack | null): void {
    for (const track of this.tracks)
      track.armed = track === armed;

    this.sendChangeMessage();
  }

  /** Añade la grabación como un clip nuevo de la pista indicada (o de una
      pista nueva si ya no existe), recortada al hueco libre donde empieza:
      nunca tapa el audio que ya tiene la pista. */
  addRecording(recording: RecordingInfo, target: AudioTrack | null): Result {
    if (recording.timelineStart < 0 || recording.channels[0].length === 0)
      return fail('No se grabó audio.');

    const left = recording.channels[0];
    const right = recording.channels[1] ?? left;
    const source = createSource('Grabacion', left, right, recording.sampleRate, null);

    // Compensación de latencia: lo que se grabó en el instante T corresponde a
    // lo que sonaba en T - (latencia de entrada + latencia de salida).
    const clip = this.makeClip(source, recording.timelineStart - recording.latencySamples);

    if (clip === null)
      return fail('La grabación es demasiado corta.');

    if (target !== null && this.tracks.includes(target)) {
      // Los fragmentos de una pista no se solapan: la toma se recorta al hueco
      // libre donde empieza. Se puede deshacer.
      const updated = target.getClips();

      if (!ClipEditing.fitIntoFreeSpace(updated, clip))
        return fail('No quedaba espacio libre para la grabación en la pista.');

      updated.push(clip);
      this.editClips(target, updated, 'Grabar fragmento');
      return ok;
    }

    const track = new AudioTrack(this.createTrackName('Grabación'));
    track.setClips([clip]);
    this.performUndoable(new TrackPresenceAction('add', this, track), 'Grabar fragmento');
    return ok;
  }

  //============================================================================
  // Edición de fragmentos con deshacer / rehacer

  private performUndoable(action: UndoableAction, actionName: string): void {
    this.undoManager.beginNewTransaction(actionName);
    this.undoManager.perform(action);
  }

  /** Sustituye los clips de la pista y anota el cambio en el historial. */
  editClips(track: AudioTrack, newClips: AudioClip[], actionName: string): void {
    this.performUndoable(new ClipEditAction(this, track, track.getClips(), newClips), actionName);
  }

  /** Anota una edición que ya se aplicó a la pista (arrastrar con el ratón
      aplica cada movimiento al momento para oírlo). */
  clipsEdited(track: AudioTrack, clipsBefore: AudioClip[], actionName: string): void {
    this.performUndoable(new ClipEditAction(this, track, clipsBefore, track.getClips()), actionName);
  }

  canUndo(): boolean { return this.undoManager.canUndo(); }
  canRedo(): boolean { return this.undoManager.canRedo(); }
  getUndoDescription(): string { return this.undoManager.getUndoDescription(); }
  getRedoDescription(): string { return this.undoManager.getRedoDescription(); }

  undo(): boolean {
    const done = this.undoManager.undo();
    this.notifyTracksEdited();
    return done;
  }

  redo(): boolean {
    const done = this.undoManager.redo();
    this.notifyTracksEdited();
    return done;
  }

  createTrackName(baseName: string): string {
    for (let number = 1; ; ++number) {
      const candidate = baseName + ' ' + number;

      if (!this.tracks.some(t => t.name === candidate))
        return candidate;
    }
  }

  /** El nombre tal cual si está libre; si no, "nombre (copia)", "nombre (copia 2)"... */
  createCopyName(name: string): string {
    const isTaken = (candidate: string) => this.tracks.some(t => t.name === candidate);

    if (!isTaken(name))
      return name;

    for (let number = 1; ; ++number) {
      const candidate = name + (number === 1 ? ' (copia)' : ` (copia ${number})`);

      if (!isTaken(candidate))
        return candidate;
    }
  }
}

//==============================================================================
// Acciones del historial

/** Cambio de la lista de clips de una pista: la de antes y la de después. Los
    clips comparten el audio, así que copiar las listas no duplica muestras. */
class ClipEditAction implements UndoableAction {
  private project: ProjectManager;
  private track: AudioTrack;
  private before: AudioClip[];
  private after: AudioClip[];

  constructor(project: ProjectManager, track: AudioTrack, before: AudioClip[], after: AudioClip[]) {
    this.project = project;
    this.track = track;
    this.before = ClipEditing.copyList(before);
    this.after = ClipEditing.copyList(after);
  }

  perform(): boolean { return this.apply(this.after); }
  undo(): boolean { return this.apply(this.before); }

  private apply(clips: AudioClip[]): boolean {
    // La pista ya no está en el proyecto: el historial deja de ser válido.
    if (!this.project.tracks.includes(this.track))
      return false;

    this.track.setClips(clips);
    this.project.notifyTracksEdited();
    return true;
  }
}

/** Poner o quitar una pista. La acción conserva la pista (clips, volumen y
    efectos) para devolverla a su sitio. */
class TrackPresenceAction implements UndoableAction {
  private kind: 'add' | 'remove';
  private project: ProjectManager;
  private track: AudioTrack;
  private index: number;

  constructor(kind: 'add' | 'remove', project: ProjectManager, track: AudioTrack, insertIndex = -1) {
    this.kind = kind;
    this.project = project;
    this.track = track;
    this.index = insertIndex;
  }

  perform(): boolean { return this.kind === 'add' ? this.insert() : this.remove(); }
  undo(): boolean { return this.kind === 'add' ? this.remove() : this.insert(); }

  private insert(): boolean {
    const tracks = this.project.tracks;

    if (tracks.includes(this.track))
      return false;

    const size = tracks.length;
    tracks.splice(this.index < 0 ? size : Math.min(this.index, size), 0, this.track);
    this.project.notifyTracksEdited();
    return true;
  }

  private remove(): boolean {
    const tracks = this.project.tracks;
    this.index = tracks.indexOf(this.track);

    if (this.index < 0)
      return false;

    this.track.armed = false;
    tracks.splice(this.index, 1);
    this.project.notifyTracksEdited();
    return true;
  }
}

/** Cambiar una pista de posición. */
class MoveTrackAction implements UndoableAction {
  private project: ProjectManager;
  private track: AudioTrack;
  private fromIndex: number;
  private toIndex: number;

  constructor(project: ProjectManager, track: AudioTrack, fromIndex: number, toIndex: number) {
    this.project = project;
    this.track = track;
    this.fromIndex = fromIndex;
    this.toIndex = toIndex;
  }

  perform(): boolean { return this.moveTo(this.toIndex); }
  undo(): boolean { return this.moveTo(this.fromIndex); }

  private moveTo(newIndex: number): boolean {
    const current = this.project.tracks.indexOf(this.track);

    if (current < 0)
      return false;

    // Al anotar un arrastre, la pista ya está en su sitio: no se mueve.
    if (current !== newIndex)
      this.project.moveTrack(current, newIndex);

    this.project.notifyTracksEdited();
    return true;
  }
}

/** Meter una pista en una carpeta, sacarla o moverla: carpeta y posición. */
class FolderMoveAction implements UndoableAction {
  private project: ProjectManager;
  private track: AudioTrack;
  private fromFolder: string;
  private targetFolder: string;
  private fromIndex: number;
  private targetIndex: number;

  constructor(project: ProjectManager, track: AudioTrack, toFolder: string, toIndex: number) {
    this.project = project;
    this.track = track;
    this.fromFolder = track.folderId;
    this.targetFolder = toFolder;
    this.fromIndex = project.tracks.indexOf(track);
    this.targetIndex = toIndex;
  }

  perform(): boolean { return this.apply(this.targetFolder, this.targetIndex); }
  undo(): boolean { return this.apply(this.fromFolder, this.fromIndex); }

  private apply(folder: string, index: number): boolean {
    const current = this.project.tracks.indexOf(this.track);

    if (current < 0)
      return false;

    this.track.folderId = folder;
    index = Math.min(this.project.tracks.length - 1, Math.max(0, index));

    if (current !== index)
      this.project.moveTrack(current, index);

    this.project.notifyTracksEdited();
    return true;
  }
}

/** Poner o quitar una carpeta de la lista (eliminar carpeta). */
class FolderPresenceAction implements UndoableAction {
  private project: ProjectManager;
  private folder: TrackFolder;
  private index = 0;

  constructor(project: ProjectManager, folder: TrackFolder) {
    this.project = project;
    this.folder = folder;
  }

  perform(): boolean {
    const folders = this.project.folders;
    const found = folders.findIndex(f => f.id === this.folder.id);

    if (found < 0)
      return false;

    this.index = found;
    folders.splice(found, 1);
    this.project.notifyTracksEdited();
    return true;
  }

  undo(): boolean {
    const folders = this.project.folders;
    folders.splice(Math.min(folders.length, Math.max(0, this.index)), 0, this.folder);
    this.project.notifyTracksEdited();
    return true;
  }
}

/** Cambiar el nombre de una pista. */
class RenameTrackAction implements UndoableAction {
  private project: ProjectManager;
  private track: AudioTrack;
  private oldName: string;
  private newName: string;

  constructor(project: ProjectManager, track: AudioTrack, oldName: string, newName: string) {
    this.project = project;
    this.track = track;
    this.oldName = oldName;
    this.newName = newName;
  }

  perform(): boolean { this.track.name = this.newName; this.project.notifyTracksEdited(); return true; }
  undo(): boolean { this.track.name = this.oldName; this.project.notifyTracksEdited(); return true; }
}
