/** Regla de tiempo sobre las formas de onda: marcas, cabezal y clic para saltar. */
import { Palette } from './colour.ts';
import { h, prepareCanvas, trackPointer } from './dom.ts';

export class TimeRuler {
  readonly element = h('canvas', { className: 'time-ruler' });
  onSeek: (seconds: number) => void = () => undefined;
  onWheel: (x: number, event: WheelEvent) => boolean = () => false;
  private visibleStart = 0;
  private visibleLength = 30;
  private playheadSeconds = 0;
  private width = 0;
  private height = 24;

  constructor() {
    this.element.addEventListener('pointerdown', event => {
      if (event.button !== 0)
        return;

      const seek = (e: PointerEvent) => {
        const rect = this.element.getBoundingClientRect();
        this.onSeek(Math.max(0, this.visibleStart + (e.clientX - rect.left) / rect.width * this.visibleLength));
      };

      seek(event);
      trackPointer(event, seek);
    });

    this.element.addEventListener('wheel', event => {
      const rect = this.element.getBoundingClientRect();

      if (this.onWheel(event.clientX - rect.left, event))
        event.preventDefault();
    }, { passive: false });
  }

  setSize(width: number, height: number): void {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.draw();
    }
  }

  setVisibleRange(start: number, length: number): void {
    this.visibleStart = Math.max(0, start);
    this.visibleLength = Math.max(0.01, length);
    this.draw();
  }

  setPlayheadSeconds(seconds: number): void {
    if (seconds !== this.playheadSeconds) {
      this.playheadSeconds = seconds;
      this.draw();
    }
  }

  private draw(): void {
    const { width, height } = this;

    if (width <= 0)
      return;

    const g = prepareCanvas(this.element, width, height);
    g.fillStyle = Palette.panel.toString();
    g.fillRect(0, 0, width, height);

    const pixelsPerSecond = width / this.visibleLength;

    // Intervalo de marcas: el más pequeño que deja al menos ~70 px entre etiquetas.
    let step = 600;

    for (const candidate of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) {
      if (candidate * pixelsPerSecond >= 70) {
        step = candidate;
        break;
      }
    }

    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';

    const firstTick = Math.ceil(this.visibleStart / step) * step;

    for (let i = 0; ; ++i) {
      const t = firstTick + i * step;

      if (t > this.visibleStart + this.visibleLength)
        break;

      const x = Math.round((t - this.visibleStart) * pixelsPerSecond);
      const minutes = Math.floor(t / 60 + 1e-9);
      const seconds = t - minutes * 60;

      // Con zoom alto se muestran décimas: 0:01.5
      const secondsText = step < 1 ? seconds.toFixed(1).padStart(4, '0') : String(Math.round(seconds)).padStart(2, '0');

      g.fillStyle = Palette.outline.toString();
      g.fillRect(x, height * 0.55, 1, height * 0.45);
      g.fillStyle = Palette.textDim.toString();
      g.fillText(minutes + ':' + secondsText, x + 3, height * 0.35);
    }

    // Marca del cabezal (solo si está dentro de lo visible).
    const playheadX = (this.playheadSeconds - this.visibleStart) * pixelsPerSecond;

    if (playheadX >= -5 && playheadX <= width + 5) {
      g.fillStyle = Palette.accent.toString();
      g.beginPath();
      g.moveTo(playheadX - 5, 0);
      g.lineTo(playheadX + 5, 0);
      g.lineTo(playheadX, 7);
      g.closePath();
      g.fill();
    }

    g.fillStyle = Palette.outline.toString();
    g.fillRect(0, height - 1, width, 1);
  }
}
