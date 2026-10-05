/**
    Zona de pistas: regla de tiempo + lista desplazable de filas + cabezal +
    barra de desplazamiento horizontal.

    - Zoom: Ctrl + rueda (alrededor del ratón). Desplazamiento: Shift + rueda,
      rueda horizontal o la barra inferior. Al reproducir, la vista sigue al cabezal.
    - Al pasar el ratón por una pista aparece un "+" en la esquina derecha de su
      borde inferior: añade una pista justo debajo.
    - Las pistas se reordenan arrastrando su cabecera.
    - Carpetas (las crea la separación por IA): una cabecera con una flecha que
      despliega o pliega sus pistas y el botón "Ondas", que abre o cierra la
      pantalla de ondas. Arrastrando una pista se mete en la carpeta o se saca.

    Guarda la selección: pista seleccionada y, dentro de ella, el clip seleccionado.
*/
import type { AudioEngine } from '../audio/engine.ts';
import { previewBinSize } from '../audio/protocol.ts';
import { L, tr, type Localised } from '../core/i18n.ts';
import { gainToDecibels } from '../core/range.ts';
import { ClipEditing } from '../model/clip.ts';
import type { ProjectManager } from '../model/project.ts';
import type { AudioTrack } from '../model/track.ts';
import type { AudioClip } from '../model/clip.ts';
import { Colour, onBackground, Palette, trackColourFor } from './colour.ts';
import { h, localise, prepareCanvas, roundedRect, trackPointer } from './dom.ts';
import { item, separator, showMenu, submenu, type MenuEntry } from './menu.ts';
import { TimeRuler } from './timeRuler.ts';
import { headerWidth, rowHeight, TrackRow } from './trackRow.ts';

const folderHeaderHeight = 32;
const addButtonHeight = 26;
const minimumVisibleSeconds = 0.25;     // zoom máximo: 0,25 s a lo ancho
const zoomStep = 1.5;

export interface FolderInfo {
  id: string;
  name: string;
  colour: Colour;
  expanded: boolean;
  canShowWaves: boolean;      // quedan pistas de la separación: hay ondas que ver
  wavesOpen: boolean;         // su pantalla de ondas está abierta
}

/** Cabecera de una carpeta: flecha, icono, nombre y el botón "Ondas". */
class FolderHeader {
  readonly element: HTMLElement;
  info: FolderInfo;
  private arrow = h('div', { className: 'folder-arrow' });
  private icon = h('div', { className: 'folder-icon', 'aria-hidden': 'true' });
  private name = h('div', { className: 'folder-name' });
  private count = h('div', { className: 'folder-count' });
  private wavesButton = h('button', { className: 'text-button waves-button', type: 'button', text: tr('Ondas'),
                                      title: tr('Abrir o cerrar la pantalla de ondas de la separación') });
  onToggle: () => void = () => undefined;
  onToggleWaves: () => void = () => undefined;
  onMenu: (x: number, y: number) => void = () => undefined;

  constructor(info: FolderInfo) {
    this.info = info;
    this.element = h('div', { className: 'folder-header', title: tr('Clic: desplegar o plegar. Clic derecho: menú de la carpeta') },
      h('div', { className: 'folder-header-left' },
        h('div', { className: 'folder-colour' }), this.arrow, this.icon,
        h('div', { className: 'folder-text' }, this.name, this.count), this.wavesButton),
      h('div', { className: 'folder-band' }));

    this.wavesButton.addEventListener('click', e => {
      e.stopPropagation();
      this.onToggleWaves();
    });
    this.wavesButton.addEventListener('pointerdown', e => e.stopPropagation());

    // Clic: desplegar o plegar. Clic derecho (o pulsación larga): su menú.
    this.element.addEventListener('contextmenu', e => {
      e.preventDefault();
      this.onMenu(e.clientX, e.clientY);
    });
    this.element.addEventListener('click', e => {
      if (e.button === 0)
        this.onToggle();
    });
  }

  setInfo(info: FolderInfo, members: number): void {
    this.info = info;
    const colour = onBackground(info.colour);
    this.element.style.setProperty('--folder-colour', colour.toString());
    this.element.style.setProperty('--folder-tint', Palette.panel.interpolatedWith(colour, 0.14).toString());
    this.element.style.setProperty('--folder-band', colour.withAlpha(0.06).toString());
    this.element.classList.toggle('collapsed', !info.expanded);
    this.name.textContent = info.name;
    this.count.textContent = members === 1 ? tr('1 pista') : tr('{0} pistas', members);
    this.wavesButton.disabled = !info.canShowWaves;
    this.wavesButton.classList.toggle('on', info.wavesOpen);
    this.wavesButton.style.setProperty('--on-colour', info.colour.withAlpha(0.8).toString());
  }
}

/** Lo que se ve en la lista, en orden: cabeceras de carpeta y pistas. */
interface Entry {
  header: FolderHeader | null;
  row: TrackRow | null;
  folderId: string;           // la carpeta de la cabecera, o en la que está la pista
}

/** Dónde caería una pista al soltarla. */
interface DropSlot {
  y: number;                  // línea de inserción (para elegir la más cercana)
  insertAt: number;           // antes de qué entrada (sin contar la arrastrada)
  folderId: string;           // carpeta destino ('' = fuera)
  before: AudioTrack | null;  // antes de esta pista; nulo = al final de la carpeta o de la lista
}

export class TrackList {
  readonly element = h('div', { className: 'track-list' });
  private engine: AudioEngine;
  private projects: ProjectManager;
  private ruler = new TimeRuler();
  private viewport = h('div', { className: 'track-viewport' });
  private content = h('div', { className: 'track-content' });
  private emptyHint = h('div', { className: 'empty-hint' });
  private emptyAddButton = this.createAddButton(L('Añadir una pista (T)'), () => this.onAddTrack(-1, ''));
  private addBelowButton = this.createAddButton(L('Añadir una pista debajo'), () => this.addBelow());
  private recordingCanvas = h('canvas', { className: 'recording-lane' });
  private playhead = h('div', { className: 'playhead' });
  private scrollTrack = h('div', { className: 'hscroll-track' });
  private scrollThumb = h('div', { className: 'hscroll-thumb' });

  private rows: TrackRow[] = [];
  private folders: FolderInfo[] = [];
  private folderHeaders = new Map<string, FolderHeader>();
  private entries: Entry[] = [];
  private drop: DropSlot | null = null;
  private selected: AudioTrack | null = null;
  private selectedClip = 0;
  private addBelowRow = -1;
  private draggingRow = -1;

  // Línea de tiempo: duración total (contenido + margen) y tramo visible.
  private totalLength = 30;
  private visibleStart = 0;
  private visibleLength = 30;
  private fitToWindow = true;
  private knownContentLength = -1;
  private waveWidth = 1;
  private contentHeight = 0;

  // Vista previa de la grabación en curso.
  private recording = { visible: false, peaks: [] as number[], row: null as TrackRow | null, dirty: false };

  onSelectionChanged: (track: AudioTrack | null) => void = () => undefined;
  onDeleteRequested: (track: AudioTrack) => void = () => undefined;
  onContextMenu: (track: AudioTrack, clipId: number, seconds: number, x: number, y: number) => void = () => undefined;
  onClipsEdited: (track: AudioTrack, clipsBefore: AudioClip[], actionName: string) => void = () => undefined;
  onTracksReordered: (track: AudioTrack, fromIndex: number, toIndex: number) => void = () => undefined;
  onTrackRenamed: (track: AudioTrack, oldName: string) => void = () => undefined;
  onAddTrack: (insertIndex: number, folderId: string) => void = () => undefined;
  onToggleFolder: (folderId: string) => void = () => undefined;
  onToggleFolderWindow: (folderId: string) => void = () => undefined;
  onDeleteFolderRequested: (folderId: string) => void = () => undefined;
  onTrackDropped: (track: AudioTrack, folderId: string, index: number) => void = () => undefined;
  onCopyTrack: (track: AudioTrack) => void = () => undefined;
  onCutTrack: (track: AudioTrack) => void = () => undefined;
  onPasteTrack: (insertIndex: number) => void = () => undefined;
  canPasteTrack: () => boolean = () => false;
  onDownloadTrack: (track: AudioTrack) => void = () => undefined;
  onDownloadFolder: (folderId: string) => void = () => undefined;

  constructor(engine: AudioEngine, projects: ProjectManager) {
    this.engine = engine;
    this.projects = projects;

    localise(this.emptyHint, 'text', L('Pulsa + para añadir una pista, arrastra aquí una canción o usa Archivo > Importar audio...\n'
                                       + 'Después, IA > Separar instrumentos. Para grabar, añade una pista y pulsa R.'));
    this.emptyAddButton.style.top = '6px';
    this.content.append(this.emptyHint, this.emptyAddButton, this.recordingCanvas, this.playhead, this.addBelowButton);
    this.viewport.append(this.content);
    this.scrollTrack.append(this.scrollThumb);

    this.ruler.onSeek = seconds => this.seekTo(seconds);
    this.ruler.onWheel = (x, e) => this.handleWheel(x, e);

    this.element.append(
      h('div', { className: 'ruler-row' }, h('div', { className: 'ruler-corner' }), this.ruler.element),
      this.viewport,
      h('div', { className: 'hscroll-row' }, h('div', { className: 'hscroll-corner' }), this.scrollTrack));

    this.content.addEventListener('pointermove', e => this.updateAddButton(e));
    this.content.addEventListener('pointerleave', () => this.hideAddButton());
    this.setupScrollBar();

    new ResizeObserver(() => this.layoutRows()).observe(this.viewport);
    requestAnimationFrame(() => this.frame());
  }

  //============================================================================
  /** Vuelve a crear las filas y las cabeceras de carpeta (cambió el idioma o
      el tema: se construyeron con los textos y colores de antes). */
  rebuild(): void {
    for (const row of this.rows)
      row.dispose();

    for (const header of this.folderHeaders.values())
      header.element.remove();

    this.rows = [];
    this.folderHeaders.clear();
    this.setFolders(this.folders);
    this.refresh();
    this.setVisibleRange(this.visibleStart, this.visibleLength);
  }

  /** Sincroniza las filas con las pistas del proyecto (conserva las existentes). */
  refresh(): void {
    const tracks = this.projects.tracks;
    const newRows: TrackRow[] = [];

    tracks.forEach((track, i) => {
      const existing = this.rows.find(r => r.track === track);

      if (existing !== undefined) {
        existing.trackChanged();
        newRows.push(existing);
        return;
      }

      newRows.push(this.createRow(track, i));
    });

    // Las filas de pistas eliminadas se quitan (y liberan su pista).
    for (const row of this.rows)
      if (!newRows.includes(row))
        row.dispose();

    this.rows = newRows;
    this.rebuildEntries();
    this.emptyHint.style.display = this.rows.length === 0 ? '' : 'none';
    this.emptyAddButton.style.display = this.rows.length === 0 ? 'block' : 'none';
    this.hideAddButton();

    if (this.selected !== null && !this.rows.some(r => r.track === this.selected))
      this.selectTrack(null);
    else if (this.selected === null && this.rows.length > 0)
      this.selectTrack(this.rows[0].track);

    // El clip seleccionado puede haber desaparecido (eliminado o cortado).
    if (this.selected !== null && this.selectedClip !== 0
        && ClipEditing.find(this.selected.getClips(), this.selectedClip) === undefined)
      this.selectedClip = 0;

    this.updateSelectionDisplay();
    this.knownContentLength = -1;
    this.layoutRows();
    this.updateTimeline();
  }

  private createRow(track: AudioTrack, index: number): TrackRow {
    const row = new TrackRow(track, trackColourFor(track.name, index), this.engine);

    row.onSelect = r => this.selectTrack(r.track);
    row.onHeaderClicked = r => this.selectClip(r.track, 0);
    row.onDelete = r => this.onDeleteRequested(r.track);
    row.onRenamed = (r, oldName) => this.onTrackRenamed(r.track, oldName);
    row.onHeaderMenu = (r, x, y) => this.showTrackMenu(r, x, y);
    row.onReorderDrag = (r, clientY, grabY) => this.reorderDrag(r, clientY, grabY);
    row.onReorderEnd = r => this.reorderEnd(r);

    const lane = row.lane;
    lane.onSeek = seconds => {
      this.selectTrack(track);
      this.seekTo(seconds);
    };
    lane.onClipClicked = clipId => this.selectClip(track, clipId);
    lane.onContextMenu = (clipId, seconds, x, y) => this.onContextMenu(track, clipId, seconds, x, y);
    lane.onClipsEdited = (before, name) => this.onClipsEdited(track, before, name);
    lane.onLiveEdit = () => this.engine.syncTracks(this.projects.tracks);
    lane.onWheel = (x, e) => this.handleWheel(x, e);
    lane.setVisibleRange(this.visibleStart, this.visibleLength);

    this.content.insertBefore(row.element, this.recordingCanvas);
    return row;
  }

  /** "+" en un círculo sobre una línea: solo el círculo responde al ratón. */
  private createAddButton(tooltip: Localised, onClick: () => void): HTMLElement {
    const circle = h('button', { className: 'add-track-circle', type: 'button', title: tooltip, 'aria-label': tooltip });
    circle.addEventListener('click', onClick);
    circle.addEventListener('pointerdown', e => e.stopPropagation());
    return h('div', { className: 'add-track-button' }, h('div', { className: 'add-track-line' }), circle);
  }

  /** El "+" de una pista de carpeta añade la nueva dentro de la carpeta. */
  private addBelow(): void {
    const row = this.rows[this.addBelowRow];

    if (row !== undefined)
      this.onAddTrack(this.addBelowRow + 1, this.findFolder(row.track.folderId) !== undefined ? row.track.folderId : '');
  }

  //============================================================================
  setFolders(folders: FolderInfo[]): void {
    this.folders = folders;

    // Una cabecera por carpeta; las de carpetas que ya no existen se quitan.
    for (const [id, header] of [...this.folderHeaders]) {
      if (this.findFolder(id) === undefined) {
        header.element.remove();
        this.folderHeaders.delete(id);
      }
    }

    for (const folder of folders) {
      if (this.folderHeaders.has(folder.id))
        continue;

      const header = new FolderHeader(folder);
      const id = folder.id;
      header.onToggle = () => this.onToggleFolder(id);
      header.onToggleWaves = () => this.onToggleFolderWindow(id);
      header.onMenu = (x, y) => this.showFolderMenu(id, x, y);
      this.folderHeaders.set(id, header);
      this.content.insertBefore(header.element, this.recordingCanvas);
    }

    this.rebuildEntries();
    this.layoutRows();
  }

  private findFolder(folderId: string): FolderInfo | undefined {
    return folderId === '' ? undefined : this.folders.find(f => f.id === folderId);
  }

  private isFolderHeaderShown(folderId: string): boolean {
    return this.entries.some(e => e.header !== null && e.folderId === folderId);
  }

  private rebuildEntries(): void {
    // Las pistas se ven en el orden del proyecto; las de una carpeta, juntas
    // bajo su cabecera (donde está la primera), y ocultas si está plegada.
    this.entries = [];
    const shown = new Set<string>();

    for (const header of this.folderHeaders.values())
      header.element.style.display = 'none';

    for (const row of this.rows) {
      const folderId = row.track.folderId;
      const folder = this.findFolder(folderId);

      if (folder === undefined) {
        row.setFolderColour(Palette.transparent);
        row.element.style.display = '';
        this.entries.push({ header: null, row, folderId: '' });
        continue;
      }

      if (shown.has(folderId))
        continue;

      shown.add(folderId);
      const header = this.folderHeaders.get(folderId)!;
      const members = this.rows.filter(r => r.track.folderId === folderId);
      header.setInfo(folder, members.length);
      header.element.style.display = '';
      this.entries.push({ header, row: null, folderId });

      for (const member of members) {
        member.setFolderColour(folder.colour);
        member.element.style.display = folder.expanded ? '' : 'none';

        if (folder.expanded)
          this.entries.push({ header: null, row: member, folderId });
      }
    }
  }

  private static heightOf(entry: Entry): number {
    return entry.header !== null ? folderHeaderHeight : rowHeight;
  }

  private elementOf(entry: Entry): HTMLElement {
    return entry.header !== null ? entry.header.element : entry.row!.element;
  }

  /** Posición (sin contar "excluding") justo después de la última pista de la
      carpeta; al final si no tiene ninguna. */
  private indexAtEndOf(folderId: string, excluding: AudioTrack | null): number {
    let index = 0, afterLast = -1;

    for (const track of this.projects.tracks) {
      if (track === excluding)
        continue;

      ++index;

      if (track.folderId === folderId)
        afterLast = index;
    }

    return afterLast >= 0 ? afterLast : index;
  }

  //============================================================================
  // Selección

  getSelectedTrack(): AudioTrack | null {
    return this.selected;
  }

  getSelectedClipId(): number {
    return this.selectedClip;
  }

  selectTrack(track: AudioTrack | null): void {
    const previous = this.selected;
    this.selected = track;

    if (previous !== track) {
      this.selectedClip = 0;
      this.onSelectionChanged(track);
    }

    this.updateSelectionDisplay();
  }

  selectClip(track: AudioTrack, clipId: number): void {
    this.selectTrack(track);
    this.selectedClip = clipId;
    this.updateSelectionDisplay();
  }

  private updateSelectionDisplay(): void {
    for (const row of this.rows) {
      const isSelected = row.track === this.selected;
      row.setSelected(isSelected);
      row.lane.setSelectedClip(isSelected ? this.selectedClip : 0);
    }
  }

  /** Abre el editor del nombre de la pista seleccionada (F2). */
  renameSelectedTrack(): void {
    this.rows.find(r => r.track === this.selected)?.startRename();
  }

  /** Mueve la pista seleccionada una posición (-1 arriba, +1 abajo). */
  moveSelectedTrack(direction: number): void {
    const index = this.rows.findIndex(r => r.track === this.selected);

    if (index >= 0)
      this.moveTrack(index, index + direction);
  }

  private moveTrack(fromIndex: number, toIndex: number): void {
    const count = this.rows.length;

    if (fromIndex < 0 || fromIndex >= count || toIndex < 0 || toIndex >= count || fromIndex === toIndex) {
      this.layoutRows();
      return;
    }

    const track = this.rows[fromIndex].track;
    this.projects.moveTrack(fromIndex, toIndex);
    this.refresh();
    this.onTracksReordered(track, fromIndex, toIndex);
  }

  //============================================================================
  // Menús

  private showFolderMenu(folderId: string, x: number, y: number): void {
    const folder = this.findFolder(folderId);

    if (folder === undefined)
      return;

    showMenu([
      item(folder.expanded ? tr('Plegar carpeta') : tr('Desplegar carpeta'), () => this.onToggleFolder(folderId)),
      item(folder.wavesOpen ? tr('Cerrar ondas') : tr('Abrir ondas'), () => this.onToggleFolderWindow(folderId), { enabled: folder.canShowWaves }),
      separator(),
      item(tr('Descargar sus pistas (.zip)...'), () => this.onDownloadFolder(folderId)),
      separator(),
      item(tr('Eliminar carpeta...'), () => this.onDeleteFolderRequested(folderId)),
    ], x, y);
  }

  private showTrackMenu(row: TrackRow, x: number, y: number): void {
    const index = this.rows.indexOf(row);

    if (index < 0)
      return;

    const track = row.track;
    const indexNow = () => this.rows.findIndex(r => r.track === track);
    const current = this.findFolder(track.folderId);
    const folderOf = () => (this.findFolder(track.folderId) !== undefined ? track.folderId : '');

    // Carpetas: sacar de la suya o meter en otra (de las que se ven).
    const into: MenuEntry[] = this.folders
      .filter(f => f !== current && this.isFolderHeaderShown(f.id))
      .map(f => item(f.name, () => this.onTrackDropped(track, f.id, this.indexAtEndOf(f.id, track))));

    const entries: MenuEntry[] = [
      item(tr('Cambiar nombre'), () => this.rows[indexNow()]?.startRename(), { shortcut: 'F2' }),
      item(tr('Añadir pista debajo'), () => this.onAddTrack(indexNow() + 1, folderOf())),
      separator(),
      item(tr('Copiar pista'), () => this.onCopyTrack(track), { shortcut: 'Ctrl+C' }),
      item(tr('Cortar pista'), () => this.onCutTrack(track), { shortcut: 'Ctrl+X' }),
      item(tr('Pegar pista debajo'), () => this.onPasteTrack(indexNow() + 1), { shortcut: 'Ctrl+V', enabled: this.canPasteTrack() }),
      separator(),
      item(tr('Subir pista'), () => this.moveTrack(indexNow(), indexNow() - 1), { shortcut: 'Alt+↑', enabled: index > 0 }),
      item(tr('Bajar pista'), () => this.moveTrack(indexNow(), indexNow() + 1), { shortcut: 'Alt+↓', enabled: index + 1 < this.rows.length }),
    ];

    if (current !== undefined || into.length > 0) {
      entries.push(separator());

      if (current !== undefined)
        entries.push(item(tr('Sacar de la carpeta "{0}"', current.name),
                          () => this.onTrackDropped(track, '', this.indexAtEndOf(track.folderId, track))));

      entries.push(submenu(tr('Meter en la carpeta'), into, into.length > 0));
    }

    entries.push(separator(),
                 item(tr('Descargar pista...'), () => this.onDownloadTrack(track), { enabled: track.hasClips() }),
                 separator(),
                 item(tr('Eliminar pista...'), () => this.onDeleteRequested(track), { shortcut: tr('Supr') }));

    showMenu(entries, x, y);
  }

  //============================================================================
  // Reordenar arrastrando la cabecera

  private reorderDrag(row: TrackRow, clientY: number, grabY: number): void {
    const from = this.rows.indexOf(row);

    if (from < 0 || this.rows.length < 2)
      return;

    this.draggingRow = from;
    this.hideAddButton();

    // Lo que se ve sin la pista arrastrada, colocado sin huecos.
    const others = this.entries.filter(e => e.row !== row);
    const tops: number[] = [];
    let total = 0;

    for (const entry of others) {
      tops.push(total);
      total += TrackList.heightOf(entry);
    }

    // La fila sigue al ratón.
    const parentY = clientY - this.content.getBoundingClientRect().top;
    const top = Math.min(total, Math.max(0, parentY - grabY));
    row.element.style.top = `${top}px`;
    row.element.style.zIndex = '5';

    // Sitios donde puede caer: antes de cada pista o carpeta (fuera), justo
    // bajo una cabecera, entre sus pistas y al final de su bloque (dentro),
    // sobre una cabecera plegada (dentro) y al final de la lista.
    const firstMember = (folderId: string) => this.rows.find(r => r !== row && r.track.folderId === folderId)?.track ?? null;
    const slots: DropSlot[] = [];
    const count = others.length;

    for (let i = 0; i < count; ++i) {
      const entry = others[i];
      const entryHeight = TrackList.heightOf(entry);

      if (entry.header !== null) {
        slots.push({ y: tops[i], insertAt: i, folderId: '', before: firstMember(entry.folderId) });

        const folder = this.findFolder(entry.folderId);
        const next = others[i + 1];
        const hasMembersBelow = next !== undefined && next.row !== null && next.folderId === entry.folderId;

        if (folder !== undefined && folder.expanded)
          slots.push({ y: tops[i] + entryHeight, insertAt: i + 1, folderId: entry.folderId,
                       before: hasMembersBelow ? next.row!.track : null });
        else
          slots.push({ y: tops[i] + entryHeight / 2, insertAt: i + 1, folderId: entry.folderId, before: null });
      } else if (entry.folderId === '') {
        slots.push({ y: tops[i], insertAt: i, folderId: '', before: entry.row!.track });
      } else {
        if (i > 0 && others[i - 1].header === null)
          slots.push({ y: tops[i], insertAt: i, folderId: entry.folderId, before: entry.row!.track });

        const next = others[i + 1];
        const lastOfFolder = next === undefined || next.header !== null || next.folderId !== entry.folderId;

        if (lastOfFolder)
          slots.push({ y: tops[i] + entryHeight - 20, insertAt: i + 1, folderId: entry.folderId, before: null });
      }
    }

    slots.push({ y: total, insertAt: count, folderId: '', before: null });

    // El más cercano al centro de la fila arrastrada.
    const centre = top + rowHeight / 2;
    this.drop = slots.reduce((best, slot) => (Math.abs(slot.y - centre) < Math.abs(best.y - centre) ? slot : best));

    // Las demás se apartan dejando el hueco; la arrastrada muestra la franja
    // de la carpeta en la que caería.
    let y = 0;

    for (let i = 0; i < count; ++i) {
      if (i === this.drop.insertAt)
        y += rowHeight;

      this.elementOf(others[i]).style.top = `${y}px`;
      y += TrackList.heightOf(others[i]);
    }

    const target = this.findFolder(this.drop.folderId);
    row.setFolderColour(target !== undefined ? target.colour : Palette.transparent);

    // Desplazar la lista si se arrastra cerca del borde.
    const viewportRect = this.viewport.getBoundingClientRect();

    if (clientY < viewportRect.top + 30)
      this.viewport.scrollTop -= 12;
    else if (clientY > viewportRect.bottom - 30)
      this.viewport.scrollTop += 12;
  }

  private reorderEnd(row: TrackRow): void {
    const track = row.track;
    const slot = this.drop;
    this.draggingRow = -1;
    this.drop = null;
    row.element.style.zIndex = '';

    if (slot === null) {
      this.refresh();
      return;
    }

    // Posición en el proyecto, contando sin la pista arrastrada.
    let index = 0;

    if (slot.before !== null) {
      for (const other of this.projects.tracks) {
        if (other === slot.before)
          break;

        if (other !== track)
          ++index;
      }
    } else if (slot.folderId !== '') {
      index = this.indexAtEndOf(slot.folderId, track);
    } else {
      index = this.projects.tracks.length - 1;
    }

    this.onTrackDropped(track, slot.folderId, index);
    this.refresh();
  }

  //============================================================================
  // "+" para añadir una pista debajo

  private updateAddButton(event: PointerEvent): void {
    if (this.rows.length === 0 || this.draggingRow >= 0 || (event.buttons & 1) !== 0)
      return;

    if (this.addBelowButton.contains(event.target as Node))
      return;

    const y = event.clientY - this.content.getBoundingClientRect().top;
    const entry = this.entries.find(e => {
      if (e.row === null)
        return false;

      const top = e.row.element.offsetTop;
      return y >= top && y < top + rowHeight;
    });

    if (entry?.row == null) {
      this.hideAddButton();
      return;
    }

    const row = this.rows.indexOf(entry.row);

    if (row !== this.addBelowRow || this.addBelowButton.style.display !== 'block') {
      this.addBelowRow = row;
      const border = entry.row.element.offsetTop + rowHeight - 1;
      const button = this.addBelowButton;
      button.style.top = `${border - addButtonHeight / 2}px`;
      button.style.setProperty('--add-colour', entry.row.colour.toString());
      button.style.display = 'block';
    }
  }

  private hideAddButton(): void {
    this.addBelowButton.style.display = 'none';
    this.addBelowRow = -1;
  }

  //============================================================================
  // Disposición, zoom y desplazamiento

  private layoutRows(): void {
    const width = this.viewport.clientWidth;
    let listHeight = 0;

    for (const entry of this.entries)
      listHeight += TrackList.heightOf(entry);

    this.contentHeight = Math.max(this.viewport.clientHeight, listHeight + 40);
    this.content.style.height = `${this.contentHeight}px`;

    let y = 0;

    for (const entry of this.entries) {
      const element = this.elementOf(entry);
      element.style.top = `${y}px`;
      y += TrackList.heightOf(entry);
    }

    this.waveWidth = Math.max(1, width - headerWidth());

    for (const row of this.rows)
      row.lane.setSize(this.waveWidth, rowHeight - 1);

    this.ruler.setSize(this.waveWidth, 24);
    this.playhead.style.height = `${this.contentHeight}px`;
    this.setVisibleRange(this.visibleStart, this.visibleLength);
  }

  private updateTimeline(): void {
    const rate = this.engine.sampleRate;
    const contentSeconds = this.projects.getContentLength() / rate;

    // Un poco de margen a la derecha para poder grabar después del final.
    this.totalLength = Math.max(30, contentSeconds * 1.05);

    if (this.fitToWindow) {
      this.setVisibleRange(0, this.totalLength);
    } else {
      this.totalLength = Math.max(this.totalLength, this.visibleStart + this.visibleLength);
      this.setVisibleRange(this.visibleStart, this.visibleLength);
    }
  }

  private setVisibleRange(start: number, length: number): void {
    length = Math.min(Math.max(minimumVisibleSeconds, this.totalLength), Math.max(minimumVisibleSeconds, length));
    start = Math.min(Math.max(0, this.totalLength - length), Math.max(0, start));

    this.visibleStart = start;
    this.visibleLength = length;
    this.ruler.setVisibleRange(start, length);
    this.recording.dirty = true;

    for (const row of this.rows)
      row.lane.setVisibleRange(start, length);

    const trackWidth = this.scrollTrack.clientWidth;
    this.scrollThumb.style.left = `${(start / this.totalLength) * trackWidth}px`;
    this.scrollThumb.style.width = `${Math.max(16, (length / this.totalLength) * trackWidth)}px`;
  }

  private setupScrollBar(): void {
    this.scrollThumb.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startSeconds = this.visibleStart;

      trackPointer(event, e => {
        const secondsPerPixel = this.totalLength / Math.max(1, this.scrollTrack.clientWidth);
        this.fitToWindow = false;
        this.setVisibleRange(startSeconds + (e.clientX - startX) * secondsPerPixel, this.visibleLength);
      });
    });

    this.scrollTrack.addEventListener('pointerdown', event => {
      // Clic en la barra: una página hacia ese lado.
      const rect = this.scrollThumb.getBoundingClientRect();
      const direction = event.clientX < rect.left ? -1 : event.clientX > rect.right ? 1 : 0;

      if (direction !== 0) {
        this.fitToWindow = false;
        this.setVisibleRange(this.visibleStart + direction * this.visibleLength * 0.9, this.visibleLength);
      }
    });

    this.scrollTrack.addEventListener('wheel', e => {
      if (this.handleWheel(0, e, true))
        e.preventDefault();
    }, { passive: false });
  }

  private zoomAround(anchorSeconds: number, factor: number): void {
    const newLength = Math.min(this.totalLength, Math.max(minimumVisibleSeconds, this.visibleLength * factor));

    if (newLength >= this.totalLength - 1e-6) {
      this.zoomToFit();
      return;
    }

    // El instante bajo el ratón (o el cabezal) se queda en el mismo sitio.
    const newStart = anchorSeconds - ((anchorSeconds - this.visibleStart) * newLength) / this.visibleLength;
    this.fitToWindow = false;
    this.setVisibleRange(newStart, newLength);
  }

  zoomIn(): void {
    const playheadSeconds = this.engine.getPosition() / this.engine.sampleRate;
    const visible = playheadSeconds >= this.visibleStart && playheadSeconds <= this.visibleStart + this.visibleLength;
    this.zoomAround(visible ? playheadSeconds : this.visibleStart + this.visibleLength * 0.5, 1 / zoomStep);
  }

  zoomOut(): void {
    this.zoomAround(this.visibleStart + this.visibleLength * 0.5, zoomStep);
  }

  zoomToFit(): void {
    this.fitToWindow = true;
    this.updateTimeline();
  }

  /** Ctrl + rueda: zoom. Shift + rueda o rueda horizontal: desplazamiento lateral.
      Devuelve false para la rueda normal (desplaza la lista en vertical). */
  private handleWheel(x: number, event: WheelEvent, horizontalOnly = false): boolean {
    const scale = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1;
    const deltaX = (event.deltaX * scale) / 100;
    const deltaY = (event.deltaY * scale) / 100;

    if (event.ctrlKey || event.metaKey) {
      const delta = deltaY !== 0 ? deltaY : deltaX;

      if (delta !== 0)
        this.zoomAround(this.visibleStart + (x / this.waveWidth) * this.visibleLength, Math.pow(2, delta * 0.24));

      return true;
    }

    const horizontal = event.shiftKey || horizontalOnly ? (deltaX !== 0 ? deltaX : deltaY)
                     : Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : 0;

    if (horizontal !== 0) {
      this.fitToWindow = false;
      this.setVisibleRange(this.visibleStart + horizontal * this.visibleLength * 0.06, this.visibleLength);
      return true;
    }

    return false;
  }

  private seekTo(seconds: number): void {
    // Mientras se graba, la toma ocupa un tramo continuo desde donde empezó:
    // saltar la desalinearía con lo que suena.
    if (this.engine.isRecording())
      return;

    this.engine.setPosition(seconds * this.engine.sampleRate);
  }

  //============================================================================
  // Cada fotograma: cabezal, seguimiento y grabación en directo

  private frame(): void {
    requestAnimationFrame(() => this.frame());

    // La duración cambia al terminar una grabación o al editar clips.
    const length = this.projects.getContentLength();

    if (length !== this.knownContentLength) {
      this.knownContentLength = length;
      this.updateTimeline();
    }

    const seconds = this.engine.getPosition() / this.engine.sampleRate;

    // Grabando más allá del final: la línea de tiempo se alarga por delante del cabezal.
    if (this.engine.isRecording() && seconds > this.totalLength - 2) {
      this.totalLength = seconds * 1.25;
      this.setVisibleRange(this.fitToWindow ? 0 : this.visibleStart, this.fitToWindow ? this.totalLength : this.visibleLength);
    }

    // Con zoom, la vista sigue al cabezal mientras suena.
    if (this.engine.isPlaying() && !this.fitToWindow
        && (seconds > this.visibleStart + this.visibleLength * 0.97 || seconds < this.visibleStart))
      this.setVisibleRange(seconds - this.visibleLength * 0.05, this.visibleLength);

    this.ruler.setPlayheadSeconds(seconds);

    const relative = (seconds - this.visibleStart) / this.visibleLength;

    if (relative >= 0 && relative <= 1) {
      this.playhead.style.display = 'block';
      this.playhead.style.transform = `translateX(${headerWidth() + Math.round(relative * this.waveWidth)}px)`;
    } else {
      this.playhead.style.display = 'none';
    }

    this.updateRecordingLane();
  }

  private updateRecordingLane(): void {
    // La vista previa se dibuja sobre la zona de clips de la pista en la que se graba.
    const target = this.engine.isRecording()
      ? this.rows.find(r => r.track.armed && r.element.style.display !== 'none') ?? null : null;
    const state = this.recording;

    if (target === null) {
      if (state.visible) {
        state.visible = false;
        state.peaks = [];
        this.recordingCanvas.style.display = 'none';
      }

      return;
    }

    if (!state.visible) {
      state.visible = true;
      state.peaks = [];
      this.recordingCanvas.style.display = 'block';

      // Que la pista que se graba quede a la vista aunque haya muchas.
      const bottom = target.element.offsetTop + rowHeight;

      if (bottom > this.viewport.scrollTop + this.viewport.clientHeight || target.element.offsetTop < this.viewport.scrollTop)
        this.viewport.scrollTop = Math.max(0, bottom - this.viewport.clientHeight);
    }

    const peaks = this.engine.readRecordingPeaks();

    if (peaks.length > 0) {
      state.peaks.push(...peaks);
      state.dirty = true;
    }

    if (state.row !== target) {
      state.row = target;
      state.dirty = true;
    }

    this.recordingCanvas.style.top = `${target.element.offsetTop}px`;

    if (state.dirty) {
      state.dirty = false;
      this.drawRecordingLane(target);
    }
  }

  private drawRecordingLane(target: TrackRow): void {
    const width = this.waveWidth, height = rowHeight - 1;
    const g = prepareCanvas(this.recordingCanvas, width, height);
    g.clearRect(0, 0, width, height);

    const startSample = this.engine.getRecordingClipStart();
    const peaks = this.recording.peaks;

    if (startSample === null || peaks.length === 0)
      return;

    const rate = this.engine.sampleRate;
    const pixelsPerSample = width / (this.visibleLength * rate);
    const xForSample = (sample: number) => (sample - this.visibleStart * rate) * pixelsPerSample;
    const startX = xForSample(startSample);
    const endX = startX + peaks.length * previewBinSize * pixelsPerSample;

    // Solo en el hueco libre de la pista: lo que quede fuera (unos
    // milisegundos de latencia, o lo que pase del fragmento siguiente) se
    // recorta al terminar, y el audio que ya había no se tapa.
    const [freeStart, freeEnd] = ClipEditing.freeGapAt(target.track.getClips(), startSample);
    const left = Math.max(0, startX, xForSample(freeStart));
    const right = Math.min(width, endX, xForSample(freeEnd));

    if (right - left <= 0)
      return;

    // Con el aspecto de un fragmento de la pista (su color), no en rojo: al
    // terminar, la toma queda igual que se veía mientras se grababa.
    const colour = target.colour;
    g.fillStyle = colour.withAlpha(0.12).toString();
    roundedRect(g, left, 3, right - left, height - 6, 4);
    g.fill();
    g.strokeStyle = colour.withAlpha(0.5).toString();
    g.lineWidth = 1;
    g.stroke();

    g.fillStyle = colour.toString();
    const centreY = height / 2;
    const halfHeight = (height - 6) / 2 - 2;
    let column = -1;
    let columnPeak = 0;

    const drawColumn = () => {
      if (column >= left && column < right && columnPeak > 0) {
        // Escala en dB (-60..0), como un medidor de grabación: los micrófonos
        // integrados captan bajo y en escala lineal apenas se verían.
        const db = gainToDecibels(columnPeak, -60);
        const hgt = Math.max(1, Math.min(1, Math.max(0, (db + 60) / 60)) * halfHeight);
        g.fillRect(column, centreY - hgt, 1, hgt * 2);
      }
    };

    for (let i = 0; i < peaks.length; ++i) {
      const x = Math.floor(startX + i * previewBinSize * pixelsPerSample);

      if (x !== column) {
        drawColumn();
        column = x;
        columnPeak = 0;
      }

      columnPeak = Math.max(columnPeak, peaks[i]);
    }

    drawColumn();
  }
}
