/**
    Carril de una pista: dibuja sus clips sobre la línea de tiempo compartida y
    permite editarlos con el ratón.

      - Clic: mueve el cabezal ahí (también sobre un clip, que además queda
        seleccionado).
      - Arrastrar el centro: desplaza el clip. Arrastrar un borde: lo recorta.
      En una pista los fragmentos no se solapan: al mover, un clip se detiene
      contra su vecino hasta que su centro pasa del centro del vecino; entonces
      salta al otro lado, y si ahí no cabe, los de delante se apartan.
      - Clic derecho: menú de edición.

    Animación al mover: el clip que se arrastra se "levanta" (sube un poco, con
    sombra) y sigue al ratón por encima de los demás, que se oscurecen debajo;
    los que se apartan se deslizan, y al soltar baja hasta su sitio. Es solo
    visual: la pista ya tiene la posición final en todo momento.
*/
import { rangeOf } from '../audio/peaks.ts';
import { ClipEditing, clipEnd, type AudioClip, type ClipSource } from '../model/clip.ts';
import type { AudioTrack } from '../model/track.ts';
import { Colour, Palette } from './colour.ts';
import { h, prepareCanvas, roundedRect } from './dom.ts';

const edgeHandleWidth = 6;      // zona de agarre para recortar
const dragThreshold = 3;        // píxeles antes de empezar a mover
const slideTime = 0.07;         // constantes de tiempo (s) del deslizamiento
const liftTime = 0.05;          // y del levantamiento
const liftInset = 5;
const liftHeight = 3;

type DragMode = 'none' | 'seek' | 'move' | 'trimStart' | 'trimEnd';

export class WaveformLane {
  readonly element = h('div', { className: 'lane' });
  private canvas = h('canvas');
  private track: AudioTrack;
  private clips: AudioClip[] = [];
  private verticalZooms = new Map<ClipSource, number>();

  private waveColour = Palette.accent;
  private visibleStart = 0;
  private visibleLength = 60;
  private dimmed = false;
  private selectedClip = 0;
  private width = 0;
  private height = 0;

  private dragMode: DragMode = 'none';
  private dragOriginal: AudioClip | null = null;
  private clipsBeforeDrag: AudioClip[] = [];
  private dragStartX = 0;
  private clickSeconds = 0;
  private dragChanged = false;

  // Animación (solo visual). Posiciones en muestras de la línea de tiempo.
  private shownStarts = new Map<number, number>();
  private floatingClip = 0;
  private floatingStart = 0;
  private topClip = 0;
  private lift = 0;
  private animating = false;
  private lastFrameMs = 0;
  private paintPending = false;

  onSeek: (seconds: number) => void = () => undefined;
  onClipClicked: (clipId: number) => void = () => undefined;
  onContextMenu: (clipId: number, seconds: number, x: number, y: number) => void = () => undefined;
  onClipsEdited: (clipsBefore: AudioClip[], actionName: string) => void = () => undefined;
  onWheel: (x: number, event: WheelEvent) => boolean = () => false;

  constructor(track: AudioTrack) {
    this.track = track;
    this.element.append(this.canvas);

    this.canvas.addEventListener('pointerdown', e => this.pointerDown(e));
    this.canvas.addEventListener('pointermove', e => this.pointerMove(e));
    this.canvas.addEventListener('pointerup', e => this.pointerUp(e));
    this.canvas.addEventListener('pointercancel', e => this.pointerUp(e));
    // Clic derecho (o pulsación larga en pantallas táctiles): menú de edición.
    this.canvas.addEventListener('contextmenu', e => {
      e.preventDefault();
      const hit = this.findClipAt(e.offsetX);
      this.onClipClicked(hit.clipId);
      this.onContextMenu(hit.clipId, this.secondsForX(e.offsetX), e.clientX, e.clientY);
    });
    this.canvas.addEventListener('wheel', e => {
      if (this.onWheel(e.offsetX, e))
        e.preventDefault();
    }, { passive: false });

    this.clipsChanged();
  }

  setSize(width: number, height: number): void {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.invalidate();
    }
  }

  setWaveColour(colour: Colour): void {
    this.waveColour = colour;
    this.invalidate();
  }

  /** Tramo de la línea de tiempo que se ve (zoom y desplazamiento). */
  setVisibleRange(start: number, length: number): void {
    start = Math.max(0, start);
    length = Math.max(0.01, length);

    if (start !== this.visibleStart || length !== this.visibleLength) {
      this.visibleStart = start;
      this.visibleLength = length;
      this.invalidate();
    }
  }

  setDimmed(dimmed: boolean): void {
    if (dimmed !== this.dimmed) {
      this.dimmed = dimmed;
      this.invalidate();
    }
  }

  setSelectedClip(clipId: number): void {
    if (clipId !== this.selectedClip) {
      this.selectedClip = clipId;
      this.invalidate();
    }
  }

  /** Volver a leer los clips de la pista (tras una edición o una grabación). */
  clipsChanged(): void {
    // Mientras se arrastra, la lista es la del arrastre.
    if (this.dragMode === 'move' || this.dragMode === 'trimStart' || this.dragMode === 'trimEnd')
      return;

    this.clips = this.track.getClips();

    for (const clip of this.clips) {
      if (!this.verticalZooms.has(clip.source)) {
        // Las grabaciones con micrófonos integrados suelen quedar muy bajas y se
        // verían planas: se amplía el dibujo (no el sonido) hasta x20.
        const peak = clip.source.peaks.maxPeak;
        this.verticalZooms.set(clip.source, peak > 0 ? Math.min(20, Math.max(1, 0.9 / peak)) : 1);
      }
    }

    this.syncShownStarts();
    this.invalidate();
  }

  //============================================================================
  private invalidate(): void {
    if (this.paintPending)
      return;

    this.paintPending = true;
    requestAnimationFrame(() => {
      this.paintPending = false;
      this.paint();
    });
  }

  private shownStartOf(clip: AudioClip): number {
    return this.shownStarts.get(clip.id) ?? clip.timelineStart;
  }

  /** Un clip nuevo aparece en su sitio; uno que ya se veía y cambió de
      posición (se apartó, se deshizo un movimiento...) se desliza. */
  private syncShownStarts(): void {
    const updated = new Map<number, number>();
    let needsAnimation = false;

    for (const clip of this.clips) {
      const shown = this.shownStartOf(clip);
      updated.set(clip.id, shown);
      needsAnimation ||= shown !== clip.timelineStart;
    }

    this.shownStarts = updated;

    if (needsAnimation)
      this.startAnimation();
  }

  private startAnimation(): void {
    if (this.animating)
      return;

    this.animating = true;
    this.lastFrameMs = performance.now();
    requestAnimationFrame(now => this.animate(now));
  }

  private animate(now: number): void {
    const elapsed = Math.min(0.1, Math.max(0, (now - this.lastFrameMs) / 1000));
    this.lastFrameMs = now;

    // Acercamiento exponencial: rápido al principio y suave al final.
    const slide = 1 - Math.exp(-elapsed / slideTime);
    const liftStep = 1 - Math.exp(-elapsed / liftTime);
    let stillMoving = false;

    for (const clip of this.clips) {
      if (clip.id === this.floatingClip)
        continue;

      const shown = this.shownStartOf(clip);
      const target = clip.timelineStart;
      const quarterPixel = 0.25 * this.visibleLength * clip.source.sampleRate / Math.max(1, this.width);

      if (Math.abs(target - shown) > quarterPixel) {
        this.shownStarts.set(clip.id, shown + (target - shown) * slide);
        stillMoving = true;
      } else {
        this.shownStarts.set(clip.id, target);
      }
    }

    const liftTarget = this.floatingClip !== 0 ? 1 : 0;

    if (Math.abs(liftTarget - this.lift) > 0.01) {
      this.lift += (liftTarget - this.lift) * liftStep;
      stillMoving = true;
    } else {
      this.lift = liftTarget;
    }

    this.paint();

    if (stillMoving) {
      requestAnimationFrame(t => this.animate(t));
    } else {
      this.animating = false;

      if (this.floatingClip === 0) {
        this.topClip = 0;
        this.paint();
      }
    }
  }

  private secondsForX(x: number): number {
    return this.width > 0 ? Math.max(0, this.visibleStart + (x / this.width) * this.visibleLength) : 0;
  }

  private xForPosition(sample: number, sampleRate: number): number {
    return ((sample / sampleRate - this.visibleStart) / this.visibleLength) * this.width;
  }

  //============================================================================
  private paint(): void {
    const { width, height } = this;

    if (width <= 0 || height <= 0)
      return;

    const g = prepareCanvas(this.canvas, width, height);
    g.fillStyle = Palette.background.toString();
    g.fillRect(0, 0, width, height);

    let top: AudioClip | null = null;

    // En orden: los clips posteriores quedan por encima. El levantado, al final.
    for (const clip of this.clips) {
      if (clip.id === this.topClip)
        top = clip;
      else
        this.drawClip(g, clip, this.shownStartOf(clip), 0);
    }

    if (top === null)
      return;

    const start = top.id === this.floatingClip ? this.floatingStart : this.shownStartOf(top);

    // Lo que queda debajo del clip levantado se oscurece: se ve que pasa por encima.
    if (this.lift > 0) {
      const end = start + top.length;
      g.fillStyle = Palette.black.withAlpha(0.35 * this.lift).toString();

      for (const clip of this.clips) {
        if (clip.id === top.id)
          continue;

        const otherStart = this.shownStartOf(clip);
        const from = Math.max(start, otherStart);
        const to = Math.min(end, otherStart + clip.length);

        if (to > from) {
          const x0 = this.xForPosition(from, clip.source.sampleRate);
          const x1 = this.xForPosition(to, clip.source.sampleRate);
          roundedRect(g, x0, 3, x1 - x0, height - 6, 4);
          g.fill();
        }
      }
    }

    this.drawClip(g, top, start, this.lift);
  }

  private drawClip(g: CanvasRenderingContext2D, clip: AudioClip, drawnStart: number, liftAmount: number): void {
    const rate = clip.source.sampleRate;
    const x0 = this.xForPosition(drawnStart, rate);
    const x1 = this.xForPosition(drawnStart + clip.length, rate);

    if (x1 - x0 < 1 || x1 < 0 || x0 > this.width)
      return;

    const inset = liftInset * liftAmount;
    const ax = x0, ay = 3 + inset - liftHeight * liftAmount;
    const aw = x1 - x0, ah = this.height - 6 - 2 * inset;
    const isSelected = clip.id === this.selectedClip;
    const colour = this.waveColour;

    if (liftAmount > 0) {
      // Sombra más grande y más abajo cuanto más levantado está.
      g.save();
      g.shadowColor = Palette.black.withAlpha(0.8 * liftAmount).toString();
      g.shadowBlur = 4 + 10 * liftAmount;
      g.shadowOffsetY = 2 + 5 * liftAmount;
      g.fillStyle = Palette.background.toString();
      roundedRect(g, ax, ay, aw, ah, 4);
      g.fill();
      g.restore();

      // Halo del color de la pista alrededor.
      g.strokeStyle = colour.withAlpha(0.35 * liftAmount).toString();
      g.lineWidth = 2;
      roundedRect(g, ax - 1.5, ay - 1.5, aw + 3, ah + 3, 5.5);
      g.stroke();
    }

    // Tapar lo que haya debajo. Levantado deja entrever lo de abajo.
    g.fillStyle = Palette.background.withAlpha(1 - 0.35 * liftAmount).toString();
    roundedRect(g, ax, ay, aw, ah, 4);
    g.fill();

    g.fillStyle = colour.withAlpha(this.dimmed ? 0.05 : isSelected ? 0.3 : 0.12 + 0.12 * liftAmount).toString();
    g.fill();

    // La onda: cada canal en su mitad, min/max por columna de píxeles. Con
    // mucho zoom un clip mide miles de píxeles: solo se dibuja lo visible.
    const zoom = this.verticalZooms.get(clip.source) ?? 1;
    const left = Math.max(0, Math.ceil(ax));
    const right = Math.min(this.width, Math.floor(ax + aw));
    const samplesPerPixel = clip.length / (x1 - x0);
    const channelHeight = (ah - 4) / 2;
    g.fillStyle = (this.dimmed ? colour.withAlpha(0.3) : colour).toString();

    for (let ch = 0; ch < 2; ++ch) {
      const data = ch === 0 ? clip.source.left : clip.source.right;
      const midY = ay + 2 + channelHeight * (ch + 0.5);
      const half = channelHeight / 2;

      for (let px = left; px < right; ++px) {
        const s0 = clip.sourceOffset + (px - x0) * samplesPerPixel;
        const [lo, hi] = rangeOf(clip.source.peaks, data, ch, s0, s0 + Math.max(1, samplesPerPixel));
        const topY = Math.max(midY - half, midY - hi * zoom * half);
        const bottomY = Math.min(midY + half, midY - lo * zoom * half);

        if (bottomY - topY > 0.05)
          g.fillRect(px, topY, 1, Math.max(0.6, bottomY - topY));
      }
    }

    g.strokeStyle = (isSelected ? Palette.text : colour.withAlpha(0.5 + 0.5 * liftAmount)).toString();
    g.lineWidth = isSelected || liftAmount > 0 ? 1.5 : 1;
    roundedRect(g, ax, ay, aw, ah, 4);
    g.stroke();

    // Asas de recorte del clip seleccionado (no mientras se arrastra).
    if (isSelected && liftAmount <= 0 && aw > 3 * edgeHandleWidth) {
      g.fillStyle = Palette.text.withAlpha(0.8).toString();
      const handleHeight = ah * 0.4;
      roundedRect(g, ax, ay + (ah - handleHeight) / 2, 3, handleHeight, 1.5);
      g.fill();
      roundedRect(g, ax + aw - 3, ay + (ah - handleHeight) / 2, 3, handleHeight, 1.5);
      g.fill();
    }
  }

  //============================================================================
  private findClipAt(x: number): { clipId: number; mode: DragMode } {
    // Del último al primero: el clip que se ve encima es el que se agarra.
    for (let i = this.clips.length - 1; i >= 0; --i) {
      const clip = this.clips[i];
      const x0 = this.xForPosition(clip.timelineStart, clip.source.sampleRate);
      const x1 = this.xForPosition(clipEnd(clip), clip.source.sampleRate);

      if (x < x0 || x > x1)
        continue;

      const wide = x1 - x0 > 3 * edgeHandleWidth;

      if (wide && x - x0 <= edgeHandleWidth) return { clipId: clip.id, mode: 'trimStart' };
      if (wide && x1 - x <= edgeHandleWidth) return { clipId: clip.id, mode: 'trimEnd' };

      return { clipId: clip.id, mode: 'move' };
    }

    return { clipId: 0, mode: 'seek' };
  }

  private pointerMove(event: PointerEvent): void {
    if (this.dragMode !== 'none') {
      this.drag(event);
      return;
    }

    const hit = this.findClipAt(event.offsetX);
    this.canvas.style.cursor = hit.mode === 'trimStart' || hit.mode === 'trimEnd' ? 'ew-resize'
                             : hit.mode === 'move' ? 'grab' : 'default';
  }

  private pointerDown(event: PointerEvent): void {
    const hit = this.findClipAt(event.offsetX);
    this.dragMode = 'none';
    this.dragChanged = false;
    this.onClipClicked(hit.clipId);

    if (event.button !== 0)
      return;

    this.canvas.setPointerCapture(event.pointerId);

    if (hit.clipId === 0) {
      this.dragMode = 'seek';
      this.onSeek(this.secondsForX(event.offsetX));
      return;
    }

    const clip = ClipEditing.find(this.clips, hit.clipId);

    if (clip !== undefined) {
      this.dragMode = hit.mode;
      this.dragOriginal = { ...clip };
      this.clipsBeforeDrag = this.track.getClips();
      this.dragStartX = event.offsetX;
      this.clickSeconds = this.secondsForX(event.offsetX);

      if (hit.mode === 'move')
        this.canvas.style.cursor = 'grabbing';
    }
  }

  private drag(event: PointerEvent): void {
    if (this.dragMode === 'seek') {
      this.onSeek(this.secondsForX(event.offsetX));
      return;
    }

    const original = this.dragOriginal;

    if (this.dragMode === 'none' || original === null || this.width <= 0)
      return;

    const dx = event.offsetX - this.dragStartX;

    if (!this.dragChanged && Math.abs(dx) < dragThreshold)
      return;

    const samplesPerPixel = (this.visibleLength * original.source.sampleRate) / this.width;
    const delta = Math.round(dx * samplesPerPixel);

    // Siempre se parte de la lista de antes de arrastrar: si se vuelve atrás,
    // los clips que se apartaron regresan a su sitio.
    let updated: AudioClip[];

    if (this.dragMode === 'move') {
      updated = ClipEditing.moveWithoutOverlap(this.clipsBeforeDrag, original.id, original.timelineStart + delta);

      // Se "levanta" y se dibuja justo bajo el ratón, aunque pase por encima
      // de otro clip; la pista ya tiene su posición real (la que sonará).
      this.floatingClip = this.topClip = original.id;
      this.floatingStart = Math.max(0, original.timelineStart + delta);
      this.startAnimation();
    } else {
      // Recortar: el borde se detiene en el vecino.
      const [lowest, highest] = ClipEditing.freeRangeAround(this.clipsBeforeDrag, original);
      const edited = { ...original };

      if (this.dragMode === 'trimStart')
        ClipEditing.trimStart(edited, Math.max(lowest, original.timelineStart + delta));
      else
        ClipEditing.trimEnd(edited, Math.min(highest, clipEnd(original) + delta));

      updated = this.clipsBeforeDrag.map(c => (c.id === edited.id ? edited : { ...c }));
    }

    // Se aplica a la pista en cada movimiento para oír el resultado al momento.
    this.track.setClips(updated);
    this.clips = updated;
    this.syncShownStarts();
    this.dragChanged = true;
    this.onLiveEdit();
    this.invalidate();
  }

  /** Cada movimiento del arrastre llega al motor al momento. */
  onLiveEdit: () => void = () => undefined;

  private pointerUp(event: PointerEvent): void {
    const mode = this.dragMode;
    const changed = this.dragChanged;
    this.dragMode = 'none';
    this.dragChanged = false;

    if (this.canvas.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId);

    this.pointerMove(event);

    // Al soltar, el clip baja desde donde está el ratón hasta su sitio real.
    if (this.floatingClip !== 0) {
      this.shownStarts.set(this.floatingClip, this.floatingStart);
      this.floatingClip = 0;
      this.startAnimation();
    }

    if (mode === 'none' || mode === 'seek')
      return;

    const before = this.clipsBeforeDrag;
    this.clipsBeforeDrag = [];

    if (changed)
      this.onClipsEdited(before, mode === 'move' ? 'Mover fragmento' : 'Recortar fragmento');
    else
      // Clic sin arrastrar sobre un clip: además de seleccionarlo, el cabezal
      // va ahí (para grabar o pegar a continuación, o escuchar desde ese punto).
      this.onSeek(this.clickSeconds);
  }

  /** Estado de la animación (para las pruebas). */
  getLiftAmount(): number {
    return this.lift;
  }
}
