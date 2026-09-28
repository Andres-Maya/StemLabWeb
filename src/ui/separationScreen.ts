/**
    Animación de la separación por IA. En la versión de escritorio era una
    ventana aparte; aquí es una pantalla dentro de la misma pestaña, encima del
    proyecto. Cerrarla solo la oculta: la separación sigue (Ver progreso en la
    barra de estado, IA > Mostrar progreso o el botón "Ondas" de la carpeta).

      - En el centro, el porcentaje. Lo rodea un anillo de frecuencias del color
        de la pista que se separa: una línea que forma un círculo y se deforma
        con picos, con puntos brillantes en los más altos. Dibuja la propia
        canción: recorre su audio en tiempo real (sin audio, una señal sintética).
      - Cada cierto porcentaje sale del centro la onda de una de las pistas que
        se van a generar (Voz, Batería...): una animación de su color. Con 4
        pistas aparecen al 20, 40, 60 y 80 %.
      - Al terminar aparecen todas y se muestra "¡Separación completada!".
      - Después, cada onda se mantiene mientras exista su pista (isStemPresent):
        si se elimina se desvanece, y si se deshace vuelve.
*/
import type { ClipSource } from '../model/clip.ts';
import { Colour, Palette } from './colour.ts';
import { h, prepareCanvas } from './dom.ts';

const twoPi = Math.PI * 2;
const appearSeconds = 0.8;      // lo que tarda una pista nueva en salir y colocarse
export const ringPoints = 360;

const easeOutCubic = (x: number) => { x = 1 - Math.min(1, Math.max(0, x)); return 1 - x * x * x; };

function easeOutBack(x: number): number {
  // Se pasa un poco y vuelve: la pista "rebota" al llegar a su sitio.
  x = Math.min(1, Math.max(0, x));
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function fillGlow(g: CanvasRenderingContext2D, x: number, y: number, radius: number, colour: Colour, alpha: number): void {
  if (radius <= 0 || alpha <= 0)
    return;

  const gradient = g.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, colour.withAlpha(alpha).toString());
  gradient.addColorStop(1, colour.withAlpha(0).toString());
  g.fillStyle = gradient;
  g.beginPath();
  g.arc(x, y, radius, 0, twoPi);
  g.fill();
}

export interface StemInfo {
  name: string;         // nombre visible ("Voz")
  colour: Colour;       // el que tendrá la pista
}

/** Estado y dibujo de una separación (una por carpeta). */
export class SeparationView {
  readonly sourceName: string;
  readonly sourceColour: Colour;
  readonly stems: StemInfo[];

  getProgress: () => number = () => -1;       // 0..1, negativo = todavía sin porcentaje
  getStatus: () => string = () => '';
  isStemPresent: (index: number) => boolean = () => true;

  private appearedAt: number[];
  private present: boolean[];
  private presence: number[];
  private time = 0;
  private progress = -1;
  private shownProgress = 0;
  finished = false;
  succeeded = false;
  status = '';

  private audio: ClipSource | null = null;
  private audioStart = 0;
  private audioLength = 0;
  readonly ringLevels = new Float32Array(ringPoints);
  private ringPeak = 0.05;

  constructor(sourceName: string, sourceColour: Colour, stems: StemInfo[]) {
    this.sourceName = sourceName;
    this.sourceColour = sourceColour;
    this.stems = stems;
    this.appearedAt = stems.map(() => -1);
    this.present = stems.map(() => true);
    this.presence = stems.map(() => 1);
  }

  /** Audio de la canción que se separa: el tramo [start, start + length) del fragmento. */
  setSourceAudio(source: ClipSource | null, start: number, length: number): void {
    this.audio = source;
    this.audioStart = Math.max(0, start);
    this.audioLength = source !== null ? Math.min(length, source.length - this.audioStart) : 0;
  }

  /** Al terminar: si fue bien aparecen todas las pistas y el mensaje final. */
  setFinished(succeeded: boolean): void {
    this.finished = true;
    this.succeeded = succeeded;
    this.advance(0);
  }

  /** Porcentaje al que aparece la pista index de numStems: (index + 1) / (numStems + 1). */
  static appearanceThreshold(index: number, numStems: number): number {
    return (index + 1) / (numStems + 1);
  }

  getNumVisibleStems(): number {
    return this.stems.filter((_, i) => this.appearedAt[i] >= 0 && this.present[i]).length;
  }

  title(): string {
    return (this.finished && this.succeeded ? 'Pistas de "' : 'Separando "') + this.sourceName + '"';
  }

  advance(seconds: number): void {
    this.time += seconds;

    if (!this.finished) {
      this.progress = this.getProgress();
      this.status = this.getStatus();
    }

    if (this.finished && this.succeeded) {
      this.progress = 1;
      this.status = '¡Separación completada!';
    }

    // El número se acerca al progreso real sin saltos.
    if (this.progress >= 0)
      this.shownProgress += (this.progress - this.shownProgress) * (1 - Math.exp(-seconds / 0.25));

    this.updateRing(seconds);

    // Cada pista aparece al pasar su porcentaje (todas al terminar bien).
    const numStems = this.stems.length;

    for (let i = 0; i < numStems; ++i)
      if (this.appearedAt[i] < 0 && this.progress >= SeparationView.appearanceThreshold(i, numStems))
        this.appearedAt[i] = this.time;

    // Cada onda sigue a su pista: se desvanece si se elimina y vuelve si se deshace.
    const fade = 1 - Math.exp(-seconds / 0.15);

    for (let i = 0; i < numStems; ++i) {
      this.present[i] = this.isStemPresent(i);
      const target = this.present[i] ? 1 : 0;
      this.presence[i] = Math.abs(target - this.presence[i]) < 0.01 ? target : this.presence[i] + (target - this.presence[i]) * fade;
    }
  }

  private updateRing(seconds: number): void {
    // Cada punto del anillo resume unas pocas muestras: 360 puntos recorren
    // unos 45 ms de la canción, como un osciloscopio puesto en círculo.
    const samplesPerPoint = 6;
    const window = ringPoints * samplesPerPoint;
    const raw = new Float32Array(ringPoints);
    const audio = this.audio;

    if (audio !== null && this.audioLength > window + 2) {
      // La posición avanza en tiempo real y vuelve a empezar al final.
      const elapsed = Math.floor(this.time * audio.sampleRate);
      const position = this.audioStart + 1 + (elapsed % (this.audioLength - window - 1));
      const channels = audio.left === audio.right ? [audio.left] : [audio.left, audio.right];

      // Nivel de cada punto: un poco de la amplitud (la forma general) y sobre
      // todo el detalle agudo (diferencia con la muestra anterior): batería,
      // voces y platillos hacen los picos irregulares; el bajo, no.
      for (let k = 0; k < ringPoints; ++k) {
        let amplitude = 0, detail = 0;

        for (const data of channels) {
          const base = position + k * samplesPerPoint;

          for (let i = 0; i < samplesPerPoint; ++i) {
            amplitude = Math.max(amplitude, Math.abs(data[base + i]));
            detail = Math.max(detail, Math.abs(data[base + i] - 0.95 * data[base + i - 1]));
          }
        }

        raw[k] = 0.15 * amplitude + 1.3 * detail;
      }
    } else {
      // Sin audio: una señal que se parece a la música (picos irregulares
      // que se desplazan por el círculo).
      const t = this.time;

      for (let k = 0; k < ringPoints; ++k) {
        const noise = (Math.abs(Math.sin(k * 12.9898 + Math.floor(t * 14) * 78.233) * 43758.5453)) % 1;
        const swell = 0.5 + 0.5 * Math.sin(k * 0.035 - t * 1.4);
        raw[k] = swell * swell * (0.35 * noise + 0.65 * Math.abs(Math.sin(k * 0.41 + t * 9)));
      }
    }

    // Como en los visualizadores: un círculo limpio con ráfagas de picos. Las
    // zonas del anillo con más energía que la típica del momento (golpes,
    // consonantes, platillos) se vuelven irregulares; el resto queda liso.
    const neighbourhood = 15;
    const energy = new Float32Array(ringPoints);

    for (let k = 0; k < ringPoints; ++k) {
      let sum = 0, count = 0;

      for (let j = Math.max(0, k - neighbourhood); j <= Math.min(ringPoints - 1, k + neighbourhood); ++j, ++count)
        sum += raw[j];

      energy[k] = sum / count;
    }

    const sorted = Float32Array.from(energy).sort();
    const typical = sorted[ringPoints / 2];
    const strongest = sorted[ringPoints - 1];
    let framePeak = 0;

    for (const v of raw)
      framePeak = Math.max(framePeak, v);

    // Pico reciente (baja poco a poco): una parte más baja de la canción se ve
    // más tranquila, y el silencio deja el círculo liso.
    this.ringPeak = Math.max(framePeak, 0.02, this.ringPeak * Math.exp(-seconds / 1.5));
    const loudness = Math.min(1, Math.max(0, framePeak / this.ringPeak));

    // Subida inmediata y bajada rápida. Los extremos del anillo (abajo, donde
    // se unen) se atenúan para que no haya un salto.
    const release = Math.exp(-seconds / 0.06);
    const calm = this.finished && this.succeeded ? 0.35 : 1;

    for (let k = 0; k < ringPoints; ++k) {
      const seam = Math.pow(Math.sin((Math.PI * (k + 0.5)) / ringPoints), 0.8);
      const region = strongest > typical ? Math.min(1, Math.max(0, (energy[k] - typical) / (strongest - typical))) : 0;
      const detail = framePeak > 0 ? raw[k] / framePeak : 0;
      const target = calm * seam * Math.min(1, 1.8 * Math.sqrt(loudness) * Math.pow(region, 1.1) * (0.25 + 0.75 * detail));
      this.ringLevels[k] = Math.max(target, this.ringLevels[k] * release);
    }
  }

  //============================================================================
  paint(g: CanvasRenderingContext2D, width: number, height: number): void {
    g.fillStyle = Palette.background.toString();
    g.fillRect(0, 0, width, height);

    const cx = width / 2, cy = height / 2;
    const unit = Math.min(width, height);
    const mainRadius = unit * 0.13;
    const orbit = unit * 0.37;
    const stemRadius = unit * 0.085;
    const numStems = this.stems.length;

    // Posición y aparición de cada pista (sale del centro y se coloca en su sitio).
    const placed = this.stems.map((_, i) => {
      const since = this.appearedAt[i];
      const appear = since < 0 ? 0 : Math.min(1, Math.max(0, (this.time - since) / appearSeconds)) * this.presence[i];
      const angle = -Math.PI / 2 + (twoPi * i) / Math.max(1, numStems) + this.time * 0.12;
      const slotX = cx + orbit * Math.cos(angle), slotY = cy + orbit * Math.sin(angle);
      const e = easeOutCubic(appear);
      return { x: cx + (slotX - cx) * e, y: cy + (slotY - cy) * e, appear };
    });

    // Detrás: los haces que unen el anillo con cada pista.
    placed.forEach(({ x, y, appear }, i) => {
      const dx = x - cx, dy = y - cy;
      const distance = Math.hypot(dx, dy);

      // Del anillo al borde de la onda: no cruza el porcentaje.
      if (appear > 0 && distance > mainRadius * 1.32 + stemRadius) {
        const from = mainRadius * 1.32 / distance, to = 1 - (stemRadius * 0.95) / distance;
        this.drawBeam(g, cx + dx * from, cy + dy * from, cx + dx * to, cy + dy * to, this.stems[i].colour, appear, i);
      }
    });

    this.drawCentre(g, cx, cy, mainRadius);

    placed.forEach(({ x, y, appear }, i) => {
      if (appear > 0)
        this.drawStemOrb(g, i, x, y, stemRadius * easeOutBack(appear), Math.min(1, appear * 1.5));
    });
  }

  private drawCentre(g: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
    fillGlow(g, cx, cy, radius * 2.3, this.sourceColour, 0.18);
    this.drawFrequencyRing(g, cx, cy, radius);

    // En el centro, el porcentaje. Mientras no hay porcentaje (cargando el
    // modelo), unos puntos que se van completando.
    const text = this.progress < 0 && !this.finished
      ? '.'.repeat(1 + Math.floor((this.time * 2.5) % 3))
      : Math.round(this.shownProgress * 100) + '%';

    g.font = `bold ${Math.round(radius * 0.7)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // Resplandor del color de la pista detrás del número, y el número en blanco.
    g.fillStyle = this.sourceColour.withAlpha(0.35).toString();

    for (const offset of [3, 1.5]) {
      g.fillText(text, cx - offset, cy);
      g.fillText(text, cx + offset, cy);
      g.fillText(text, cx, cy - offset);
      g.fillText(text, cx, cy + offset);
    }

    g.fillStyle = Palette.white.toString();
    g.fillText(text, cx, cy);
  }

  private drawFrequencyRing(g: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
    // Una línea cerrada: el círculo base más el nivel de cada punto hacia fuera.
    // Empieza y termina abajo (donde los niveles se atenúan) y gira despacio.
    const base = radius * 1.32;
    const reach = radius * 0.72;
    const rotation = Math.PI / 2 + this.time * 0.25;
    const xs = new Float32Array(ringPoints), ys = new Float32Array(ringPoints);

    g.beginPath();

    for (let k = 0; k < ringPoints; ++k) {
      const angle = rotation + (twoPi * k) / ringPoints;
      const r = base + reach * this.ringLevels[k];
      xs[k] = cx + r * Math.cos(angle);
      ys[k] = cy + r * Math.sin(angle);

      if (k === 0)
        g.moveTo(xs[k], ys[k]);
      else
        g.lineTo(xs[k], ys[k]);
    }

    g.closePath();
    g.lineJoin = 'round';
    g.lineCap = 'round';

    // Resplandor del color de la pista y, encima, la línea blanca fina.
    g.strokeStyle = this.sourceColour.withAlpha(0.16).toString();
    g.lineWidth = 8;
    g.stroke();
    g.strokeStyle = this.sourceColour.brighter(0.5).withAlpha(0.45).toString();
    g.lineWidth = 3.5;
    g.stroke();
    g.strokeStyle = Palette.white.withAlpha(0.95).toString();
    g.lineWidth = 1.6;
    g.stroke();

    // Puntos brillantes en los picos: máximos locales altos; el mayor, más grande.
    const dotColour = this.sourceColour.brighter(0.9);
    let highest = -1;

    for (let k = 0; k < ringPoints; ++k) {
      const level = this.ringLevels[k];

      if (highest < 0 || level > this.ringLevels[highest])
        highest = k;

      const previous = this.ringLevels[(k + ringPoints - 3) % ringPoints];
      const next = this.ringLevels[(k + 3) % ringPoints];

      if (level < 0.22 || level < previous || level < next || k % 2 !== 0)
        continue;

      fillGlow(g, xs[k], ys[k], 4 + 8 * level, dotColour, 0.55 * level);
      g.fillStyle = dotColour.withAlpha(0.6 + 0.4 * level).toString();
      g.beginPath();
      g.arc(xs[k], ys[k], (2 + 2.5 * level) / 2, 0, twoPi);
      g.fill();
    }

    if (highest >= 0 && this.ringLevels[highest] > 0.2) {
      fillGlow(g, xs[highest], ys[highest], 18, dotColour, 0.75);
      g.fillStyle = Palette.white.toString();
      g.beginPath();
      g.arc(xs[highest], ys[highest], 3, 0, twoPi);
      g.fill();
    }
  }

  private drawBeam(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number,
                   colour: Colour, alpha: number, index: number): void {
    g.strokeStyle = colour.withAlpha(0.22 * alpha).toString();
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();

    // Partículas que viajan de la canción hacia la pista separada.
    for (let p = 0; p < 3; ++p) {
      const f = (this.time * 0.55 + p / 3 + index * 0.17) % 1;
      const size = 3 + 2 * Math.sin(f * Math.PI);
      g.fillStyle = colour.withAlpha(alpha * (0.35 + 0.65 * Math.sin(f * Math.PI))).toString();
      g.beginPath();
      g.arc(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, size / 2, 0, twoPi);
      g.fill();
    }
  }

  private drawStemOrb(g: CanvasRenderingContext2D, index: number, cx: number, cy: number, radius: number, alpha: number): void {
    if (radius <= 0.5)
      return;

    const colour = this.stems[index].colour;
    const t = this.time + index * 0.7;
    const circle = (r: number) => { g.beginPath(); g.arc(cx, cy, Math.max(0, r), 0, twoPi); };
    const closedCurve = (steps: number, radiusAt: (theta: number) => number, spin: number) => {
      g.beginPath();

      for (let k = 0; k <= steps; ++k) {
        const theta = (twoPi * k) / steps;
        const r = radiusAt(theta);
        const x = cx + r * Math.cos(theta + spin), y = cy + r * Math.sin(theta + spin);

        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }

      g.closePath();
    };

    fillGlow(g, cx, cy, radius * 1.9, colour, 0.3 * alpha);
    g.lineCap = 'round';

    // Cada pista tiene su propia animación.
    switch (index % 6) {
      case 0:     // ondas que se expanden
        for (let j = 0; j < 3; ++j) {
          const f = (t * 0.7 + j / 3) % 1;
          g.strokeStyle = colour.withAlpha(alpha * (1 - f) * 0.9).toString();
          g.lineWidth = 1.8;
          circle(radius * (0.6 + 0.75 * f));
          g.stroke();
        }
        break;

      case 1:     // lunas en órbita
        g.strokeStyle = colour.withAlpha(0.35 * alpha).toString();
        g.lineWidth = 1;
        circle(radius * 0.95);
        g.stroke();

        for (let j = 0; j < 5; ++j) {
          const angle = t * 2.1 + (twoPi * j) / 5;
          const size = radius * (0.14 + 0.06 * Math.sin(t * 3 + j));
          g.fillStyle = colour.brighter(0.5).withAlpha(alpha).toString();
          g.beginPath();
          g.arc(cx + radius * 0.95 * Math.cos(angle), cy + radius * 0.95 * Math.sin(angle), size, 0, twoPi);
          g.fill();
        }
        break;

      case 2: {   // arcos que giran en sentidos contrarios
        g.strokeStyle = colour.brighter(0.3).withAlpha(alpha).toString();
        g.lineWidth = 3;
        const start1 = t * 2.4 - Math.PI / 2, start2 = -t * 1.7 - Math.PI / 2;
        g.beginPath();
        g.arc(cx, cy, radius * 0.78, start1, start1 + 3.8);
        g.stroke();
        g.beginPath();
        g.arc(cx, cy, radius * 0.98, start2, start2 + 3.2);
        g.stroke();
        break;
      }

      case 3:     // oscilador: el borde vibra como una onda
        closedCurve(90, theta => radius * (0.78 + 0.14 * Math.sin(6 * theta + t * 5) + 0.06 * Math.sin(11 * theta - t * 3)), t * 0.8);
        g.fillStyle = colour.withAlpha(0.3 * alpha).toString();
        g.fill();
        g.strokeStyle = colour.brighter(0.4).withAlpha(alpha).toString();
        g.lineWidth = 1.8;
        g.stroke();
        break;

      case 4:     // ecualizador circular
        g.lineWidth = 2;

        for (let k = 0; k < 28; ++k) {
          const theta = (twoPi * k) / 28 + t * 0.6;
          const level = 0.2 + 0.8 * Math.abs(Math.sin(t * 4 + k * 0.9));
          const dx = Math.cos(theta), dy = Math.sin(theta);
          g.strokeStyle = colour.brighter(0.3).withAlpha(alpha * (0.4 + 0.6 * level)).toString();
          g.beginPath();
          g.moveTo(cx + dx * radius * 0.66, cy + dy * radius * 0.66);
          g.lineTo(cx + dx * radius * (0.66 + 0.42 * level), cy + dy * radius * (0.66 + 0.42 * level));
          g.stroke();
        }
        break;

      default:    // pétalos que giran
        closedCurve(120, theta => radius * (0.35 + 0.65 * Math.abs(Math.cos(3 * theta))), t * 1.4);
        g.fillStyle = colour.withAlpha(0.35 * alpha).toString();
        g.fill();
        g.strokeStyle = colour.brighter(0.4).withAlpha(alpha).toString();
        g.lineWidth = 1.5;
        g.stroke();
        break;
    }
  }
}

/** La pantalla que muestra una SeparationView (una a la vez) sobre el proyecto. */
export class SeparationScreen {
  readonly element: HTMLElement;
  private titleLabel = h('div', { className: 'separation-title' });
  private statusLabel = h('div', { className: 'separation-status', role: 'status' });
  private canvas = h('canvas', { className: 'separation-canvas', 'aria-hidden': 'true' });
  private cancelButton = h('button', { className: 'dialog-button', type: 'button', text: 'Cancelar separación' });
  private view: SeparationView | null = null;
  private folderId = '';
  private lastFrame = 0;
  private running = false;
  onCancel: () => void = () => undefined;
  onVisibilityChanged: () => void = () => undefined;

  constructor() {
    const close = h('button', { className: 'separation-close', type: 'button', title: 'Volver al proyecto (Esc). La separación sigue.',
                                'aria-label': 'Volver al proyecto' }, h('span', { text: '×' }), h('span', { text: 'Volver al proyecto' }));
    close.addEventListener('click', () => this.hide());
    this.cancelButton.addEventListener('click', () => this.onCancel());

    this.element = h('div', { className: 'separation-screen', role: 'dialog', 'aria-label': 'Separación de instrumentos' },
      h('header', { className: 'separation-header' }, this.titleLabel, this.statusLabel), close,
      this.canvas,
      h('footer', { className: 'separation-footer' }, this.cancelButton));

    this.element.style.display = 'none';
  }

  isVisible(): boolean {
    return this.element.style.display !== 'none';
  }

  /** Carpeta cuya separación se está mostrando ('' = ninguna). */
  getFolderId(): string {
    return this.isVisible() ? this.folderId : '';
  }

  present(folderId: string, view: SeparationView): void {
    this.folderId = folderId;
    this.view = view;
    this.element.style.display = 'flex';

    if (!this.running) {
      this.running = true;
      this.lastFrame = performance.now();
      requestAnimationFrame(t => this.frame(t));
    }

    this.onVisibilityChanged();
  }

  hide(): void {
    if (!this.isVisible())
      return;

    this.element.style.display = 'none';
    this.onVisibilityChanged();
  }

  /** La separación que se ve ya no existe (su carpeta se eliminó). */
  forget(folderId: string): void {
    if (this.folderId === folderId) {
      this.hide();
      this.view = null;
      this.folderId = '';
    }
  }

  private frame(now: number): void {
    const view = this.view;

    if (!this.isVisible() || view === null) {
      this.running = false;
      return;
    }

    const elapsed = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    view.advance(elapsed);

    this.titleLabel.textContent = view.title();
    this.statusLabel.textContent = view.status;
    this.cancelButton.style.visibility = view.finished ? 'hidden' : 'visible';

    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;

    if (width > 0 && height > 0)
      view.paint(prepareCanvas(this.canvas, width, height, false), width, height);

    requestAnimationFrame(t => this.frame(t));
  }
}
