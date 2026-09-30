/**
    Fila de una pista:  [nombre · M · S · × · volumen · paneo · medidor] [clips]

    - Clic en la cabecera: selecciona la pista entera (sin fragmento), así
      Ctrl+C / Ctrl+X copian o cortan la pista.
    - Arrastrar la cabecera (nombre o zona vacía) arriba/abajo: mueve la pista.
    - Doble clic en el nombre (o F2): cambiar el nombre.
    - Clic derecho en la cabecera: menú de la pista.
    Mientras se graba en la pista, su franja de color se pone roja.
*/
import type { AudioEngine } from '../audio/engine.ts';
import type { AudioTrack } from '../model/track.ts';
import { Colour, Palette } from './colour.ts';
import { IconButton, Knob, LevelMeter, LinearSlider, toggleButton } from './controls.ts';
import { h, trackPointer } from './dom.ts';
import { WaveformLane } from './waveformLane.ts';

/** Ancho de la cabecera de las pistas (250 px; más estrecha en pantallas pequeñas, ver --header-width). */
export function headerWidth(): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-width')) || 250;
}

export const rowHeight = 84;
const reorderThreshold = 5;     // píxeles antes de empezar a mover la pista

export class TrackRow {
  readonly element: HTMLElement;
  readonly track: AudioTrack;
  readonly colour: Colour;
  readonly lane: WaveformLane;
  private header: HTMLElement;
  private folderStrip: HTMLElement;
  private colourStrip: HTMLElement;
  private nameLabel: HTMLElement;
  private editing = false;
  private selected = false;
  private folderColour = Palette.transparent;
  private stopWatchingMute: () => void;
  reordering = false;

  onSelect: (row: TrackRow) => void = () => undefined;
  onHeaderClicked: (row: TrackRow) => void = () => undefined;
  onDelete: (row: TrackRow) => void = () => undefined;
  onRenamed: (row: TrackRow, oldName: string) => void = () => undefined;
  onHeaderMenu: (row: TrackRow, x: number, y: number) => void = () => undefined;
  onReorderDrag: (row: TrackRow, clientY: number, grabY: number) => void = () => undefined;
  onReorderEnd: (row: TrackRow) => void = () => undefined;

  constructor(track: AudioTrack, colour: Colour, engine: AudioEngine) {
    this.track = track;
    this.colour = colour;

    this.folderStrip = h('div', { className: 'folder-strip' });
    this.colourStrip = h('div', { className: 'colour-strip' });
    this.nameLabel = h('div', { className: 'track-name', title: 'Doble clic (o F2) para cambiar el nombre. Arrastra para mover la pista.' });
    this.nameLabel.addEventListener('dblclick', () => this.startRename());

    const mute = toggleButton(track.mute, 'M', Palette.mute, 'Silenciar (mute)');
    const solo = toggleButton(track.solo, 'S', Palette.solo, 'Solo');
    const remove = new IconButton('Eliminar pista', 'close');
    remove.element.classList.add('small');
    remove.element.addEventListener('click', () => this.onDelete(this));

    const volume = new LinearSlider(track.volume, { colour });
    volume.element.classList.add('track-volume');
    volume.element.title = 'Volumen';
    const pan = new Knob(track.pan, { size: 38 });
    pan.element.title = 'Paneo';
    const meter = new LevelMeter(ch => engine.getAndResetTrackPeak(track.id, ch));
    meter.element.classList.add('track-meter');

    this.header = h('div', { className: 'track-header' },
      this.folderStrip, this.colourStrip,
      h('div', { className: 'track-controls' },
        h('div', { className: 'track-top' }, this.nameLabel, mute, solo, remove.element),
        h('div', { className: 'track-bottom' }, volume.element, pan.element)),
      meter.element);

    this.lane = new WaveformLane(track);
    this.lane.setWaveColour(colour);
    this.lane.setDimmed(track.mute.getBool());
    this.stopWatchingMute = track.mute.onChange(p => this.lane.setDimmed(p.getBool()));

    this.element = h('div', { className: 'track-row' }, this.header, this.lane.element);
    this.element.style.setProperty('--track-colour', colour.toString());

    this.header.addEventListener('pointerdown', e => this.pointerDown(e));

    // Clic derecho (o pulsación larga en pantallas táctiles): menú de la pista.
    this.header.addEventListener('contextmenu', e => {
      e.preventDefault();

      if ((e.target as HTMLElement).closest('input'))
        return;

      this.onHeaderClicked(this);
      this.onHeaderMenu(this, e.clientX, e.clientY);
    });
    this.trackChanged();
  }

  /** Al quitar la fila: la pista puede seguir viva (en el historial de deshacer). */
  dispose(): void {
    this.stopWatchingMute();
    this.element.remove();
  }

  setSelected(selected: boolean): void {
    if (selected !== this.selected) {
      this.selected = selected;
      this.element.classList.toggle('selected', selected);
    }
  }

  /** Color de la carpeta en la que está (transparente = ninguna): una franja a la izquierda. */
  setFolderColour(colour: Colour): void {
    if (!colour.equals(this.folderColour)) {
      this.folderColour = colour;
      this.folderStrip.style.display = colour.isTransparent() ? 'none' : 'block';
      this.folderStrip.style.background = colour.withAlpha(0.55).toString();
      this.colourStrip.style.left = colour.isTransparent() ? '0' : '8px';
    }
  }

  /** Volver a leer clips, nombre y estado de grabación de la pista. */
  trackChanged(): void {
    if (!this.editing)
      this.nameLabel.textContent = this.track.name;

    this.colourStrip.style.background = (this.track.armed ? Palette.record : this.colour).toString();
    this.lane.clipsChanged();
  }

  /** Abre el editor del nombre (como un doble clic). */
  startRename(): void {
    if (this.editing)
      return;

    this.editing = true;
    const oldName = this.track.name;
    const field = h('input', { type: 'text', className: 'name-input', value: oldName, 'aria-label': 'Nombre de la pista' });
    this.nameLabel.replaceChildren(field);
    field.focus();
    field.select();

    let cancelled = false;

    field.addEventListener('pointerdown', e => e.stopPropagation());
    field.addEventListener('keydown', e => {
      e.stopPropagation();

      if (e.key === 'Enter')
        field.blur();

      if (e.key === 'Escape') {
        cancelled = true;
        field.blur();
      }
    });

    field.addEventListener('blur', () => {
      this.editing = false;
      const newName = field.value.trim();
      this.nameLabel.textContent = this.track.name;

      if (cancelled || newName === '' || newName === oldName)
        return;

      this.track.name = newName;
      this.nameLabel.textContent = newName;
      this.onRenamed(this, oldName);
    });
  }

  private pointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement;

    // Los controles de la cabecera (botones, volumen, paneo) funcionan solos.
    if (target.closest('button, .slider, .knob, input'))
      return;

    this.onHeaderClicked(this);

    if (event.button !== 0 || this.editing)
      return;

    const grabY = event.clientY - this.element.getBoundingClientRect().top;
    const startY = event.clientY;
    this.reordering = false;

    trackPointer(event, e => {
      if (!this.reordering && Math.abs(e.clientY - startY) < reorderThreshold)
        return;

      if (!this.reordering) {
        this.reordering = true;
        this.element.classList.add('reordering');
        document.body.classList.add('dragging-track');
      }

      this.onReorderDrag(this, e.clientY, grabY);
    }, () => {
      if (!this.reordering)
        return;

      this.reordering = false;
      this.element.classList.remove('reordering');
      document.body.classList.remove('dragging-track');
      this.onReorderEnd(this);
    });
  }
}
