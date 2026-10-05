/**
    Controles enlazados a un Parameter (como los attachments de JUCE): el
    control cambia el parámetro y se actualiza solo cuando el parámetro cambia
    por otro lado (deshacer, otro control, cargar...).
*/
import { L, tr, type Localised } from '../core/i18n.ts';
import type { Parameter } from '../core/parameter.ts';
import { gainToDecibels } from '../core/range.ts';
import { Colour, getPaletteVersion, Palette } from './colour.ts';
import { h, localise, prepareCanvas, ticker, trackPointer } from './dom.ts';

const rotaryStart = Math.PI * 1.2;
const rotaryEnd = Math.PI * 2.8;
const dragSensitivity = 250;       // píxeles para recorrer todo el rango

/** Burbuja con el valor mientras se arrastra un control sin caja de texto. */
const bubble = h('div', { className: 'value-bubble' });

function showBubble(anchor: Element, text: string): void {
  if (!bubble.isConnected)
    document.body.append(bubble);

  bubble.textContent = text;
  const rect = anchor.getBoundingClientRect();
  bubble.style.display = 'block';
  bubble.style.left = `${rect.left + rect.width / 2}px`;
  bubble.style.top = `${rect.top - 6}px`;
}

function hideBubble(): void {
  bubble.style.display = 'none';
}

/** Escucha el parámetro mientras exista el control: el parámetro solo guarda
    una referencia débil, así un control que sale de la página se libera y deja
    de escuchar solo. */
function bind(element: HTMLElement, parameter: Parameter, update: () => void): void {
  const holder = { update };
  const bindings = (element as unknown as { __bindings?: object[] }).__bindings ??= [];
  bindings.push(holder);

  const ref = new WeakRef(holder);
  const unsubscribe = parameter.onChange(() => {
    const target = ref.deref();

    if (target === undefined)
      unsubscribe();
    else
      target.update();
  });
}

//==============================================================================
export interface KnobOptions {
  size: number;
  textBox?: boolean;          // valor debajo (si no, burbuja al arrastrar)
  fill?: Colour;
  label?: string;
}

/** Control giratorio (arrastrar arriba/abajo o a los lados; doble clic: valor por defecto). */
export class Knob {
  readonly element: HTMLElement;
  private canvas = h('canvas');
  private text: HTMLElement | null = null;
  private parameter: Parameter;
  private options: KnobOptions;
  private enabled = true;

  constructor(parameter: Parameter, options: KnobOptions) {
    this.parameter = parameter;
    this.options = options;
    this.element = h('div', { className: 'knob' });
    this.element.title = options.label ?? tr(parameter.name);

    if (options.label !== undefined)
      this.element.append(h('div', { className: 'control-label', text: options.label }));

    this.element.append(this.canvas);

    if (options.textBox === true) {
      this.text = h('div', { className: 'knob-text' });
      this.element.append(this.text);
    }

    this.canvas.addEventListener('pointerdown', e => this.pointerDown(e));
    this.canvas.addEventListener('dblclick', () => parameter.resetToDefault());
    this.canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });

    bind(this.element, parameter, () => this.draw());
    this.draw();
  }

  setEnabledLook(enabled: boolean): void {
    this.enabled = enabled;
    this.draw();
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0)
      return;

    event.preventDefault();
    const range = this.parameter.range;
    const startProportion = range.convertTo0to1(this.parameter.get());
    const startX = event.clientX, startY = event.clientY;
    const withBubble = this.options.textBox !== true;

    if (withBubble)
      showBubble(this.canvas, this.parameter.toText());

    trackPointer(event, e => {
      const delta = (e.clientX - startX - (e.clientY - startY)) / dragSensitivity * (e.shiftKey ? 0.2 : 1);
      this.parameter.set(range.convertFrom0to1(startProportion + delta));

      if (withBubble)
        showBubble(this.canvas, this.parameter.toText());
    }, () => hideBubble());
  }

  private wheel(event: WheelEvent): void {
    if (event.ctrlKey)
      return;

    event.preventDefault();
    const range = this.parameter.range;
    const step = (event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? 0.01 : 0.03);
    this.parameter.set(range.convertFrom0to1(range.convertTo0to1(this.parameter.get()) + step));
  }

  private draw(): void {
    const size = this.options.size;
    const g = prepareCanvas(this.canvas, size, size);
    g.clearRect(0, 0, size, size);

    const radius = size / 2 - 4;
    const cx = size / 2, cy = size / 2;
    const lineWidth = Math.max(2, radius * 0.16);
    const arcRadius = radius - lineWidth / 2;
    const range = this.parameter.range;
    const proportion = range.convertTo0to1(this.parameter.get());
    const angle = rotaryStart + proportion * (rotaryEnd - rotaryStart);

    // Controles bipolares (paneo, ganancias de EQ): el arco nace en el cero.
    let fromAngle = rotaryStart;

    if (range.start < 0 && range.end > 0)
      fromAngle = rotaryStart + range.convertTo0to1(0) * (rotaryEnd - rotaryStart);

    const toCanvas = (a: number) => a - Math.PI / 2;   // 0 = arriba, en el sentido de las agujas

    g.lineCap = 'round';
    g.lineWidth = lineWidth;
    g.strokeStyle = Palette.outline.toString();
    g.beginPath();
    g.arc(cx, cy, arcRadius, toCanvas(rotaryStart), toCanvas(rotaryEnd));
    g.stroke();

    const fill = this.options.fill ?? Palette.accent;
    g.strokeStyle = fill.withAlpha(this.enabled ? 1 : 0.4).toString();
    g.beginPath();
    g.arc(cx, cy, arcRadius, toCanvas(Math.min(fromAngle, angle)), toCanvas(Math.max(fromAngle, angle)));
    g.stroke();

    const pointerLength = arcRadius * 0.6;
    g.strokeStyle = Palette.text.withAlpha(this.enabled ? 0.9 : 0.4).toString();
    g.lineWidth = lineWidth * 0.8;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + pointerLength * Math.sin(angle), cy - pointerLength * Math.cos(angle));
    g.stroke();

    if (this.text !== null)
      this.text.textContent = this.parameter.toText();
  }
}

//==============================================================================
export interface SliderOptions {
  vertical?: boolean;
  colour?: Colour;
  textBox?: 'right' | 'below' | 'none';
  textWidth?: number;
}

/** Deslizador lineal: clic o arrastre llevan el valor a esa posición; doble clic: valor por defecto. */
export class LinearSlider {
  readonly element: HTMLElement;
  private track: HTMLElement;
  private fillBar: HTMLElement;
  private thumb: HTMLElement;
  private text: HTMLElement | null = null;
  private parameter: Parameter;
  private vertical: boolean;

  constructor(parameter: Parameter, options: SliderOptions = {}) {
    this.parameter = parameter;
    this.vertical = options.vertical === true;
    this.fillBar = h('div', { className: 'slider-fill' });

    // Sin color propio usa el de acento del tema (styles.css).
    if (options.colour !== undefined)
      this.fillBar.style.background = options.colour.toString();

    this.thumb = h('div', { className: 'slider-thumb' });
    this.track = h('div', { className: 'slider-track' }, h('div', { className: 'slider-rail' }), this.fillBar, this.thumb);
    this.element = h('div', { className: 'slider ' + (this.vertical ? 'vertical' : 'horizontal') }, this.track);
    localise(this.element, 'title', L(parameter.name));

    if (options.textBox !== undefined && options.textBox !== 'none') {
      this.text = h('div', { className: 'slider-text', title: L('Doble clic para escribir un valor') });
      this.text.style.width = `${options.textWidth ?? 64}px`;
      this.element.classList.add('text-' + options.textBox);
      this.element.append(this.text);
      this.text.addEventListener('dblclick', () => this.editText());
    }

    this.track.addEventListener('pointerdown', e => this.pointerDown(e, this.text === null));
    this.track.addEventListener('dblclick', () => parameter.resetToDefault());
    this.track.addEventListener('wheel', e => this.wheel(e), { passive: false });

    bind(this.element, parameter, () => this.update());
    this.update();
  }

  private proportionAt(event: PointerEvent): number {
    const rect = this.track.getBoundingClientRect();
    return this.vertical ? 1 - (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
  }

  private pointerDown(event: PointerEvent, withBubble: boolean): void {
    if (event.button !== 0)
      return;

    event.preventDefault();
    const range = this.parameter.range;
    const apply = (e: PointerEvent) => {
      this.parameter.set(range.convertFrom0to1(this.proportionAt(e)));

      if (withBubble)
        showBubble(this.thumb, this.parameter.toText());
    };

    apply(event);
    trackPointer(event, apply, () => hideBubble());
  }

  private wheel(event: WheelEvent): void {
    if (event.ctrlKey)
      return;

    event.preventDefault();
    const range = this.parameter.range;
    const step = (event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? 0.005 : 0.02);
    this.parameter.set(range.convertFrom0to1(range.convertTo0to1(this.parameter.get()) + step));
  }

  private editText(): void {
    if (this.text === null)
      return;

    const input = h('input', { type: 'text', className: 'slider-input', value: String(this.parameter.get()) });
    this.text.replaceChildren(input);
    input.focus();
    input.select();

    const commit = (apply: boolean) => {
      const value = parseFloat(input.value.replace(',', '.'));

      if (apply && Number.isFinite(value))
        this.parameter.set(value);

      this.update();
    };

    input.addEventListener('keydown', e => {
      e.stopPropagation();

      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = ''; input.blur(); }
    });
    input.addEventListener('blur', () => commit(input.value !== ''));
  }

  private update(): void {
    const proportion = this.parameter.range.convertTo0to1(this.parameter.get());
    const percent = `${proportion * 100}%`;

    if (this.vertical) {
      this.fillBar.style.height = percent;
      this.thumb.style.bottom = percent;
    } else {
      this.fillBar.style.width = percent;
      this.thumb.style.left = percent;
    }

    if (this.text !== null && !(this.text.firstChild instanceof HTMLInputElement))
      this.text.textContent = this.parameter.toText();
  }
}

//==============================================================================
/** Botón de texto que activa o desactiva un parámetro (M, S...). */
export function toggleButton(parameter: Parameter, text: string, onColour: Colour, tooltip: string): HTMLButtonElement {
  const button = h('button', { className: 'text-button toggle', text, title: tooltip, type: 'button' });
  button.style.setProperty('--on-colour', onColour.toString());
  const update = () => button.classList.toggle('on', parameter.getBool());
  button.addEventListener('click', () => parameter.set(parameter.getBool() ? 0 : 1));
  bind(button, parameter, update);
  update();
  return button;
}

/** Casilla (activar / desactivar un efecto). */
export function tickBox(parameter: Parameter, tooltip: string): HTMLElement {
  const box = h('button', { className: 'tick-box', title: tooltip, type: 'button', 'aria-label': tooltip });
  const update = () => {
    box.classList.toggle('on', parameter.getBool());
    box.setAttribute('aria-pressed', String(parameter.getBool()));
  };
  box.addEventListener('click', () => parameter.set(parameter.getBool() ? 0 : 1));
  bind(box, parameter, update);
  update();
  return box;
}

/** Lista desplegable de un parámetro de tipo "choice". */
export function choiceBox(parameter: Parameter): HTMLSelectElement {
  const select = h('select', { className: 'choice-box', title: tr(parameter.name) });

  parameter.choices.forEach((choice, i) => select.append(h('option', { value: String(i), text: tr(choice) })));
  select.addEventListener('change', () => {
    parameter.set(Number(select.value));
    select.blur();      // los atajos de teclado vuelven a la aplicación
  });
  select.addEventListener('keydown', e => e.stopPropagation());
  const update = () => { select.value = String(parameter.getIndex()); };
  bind(select, parameter, update);
  update();
  return select;
}

//==============================================================================
/** Medidor de nivel de dos canales (escala en dB: -60 abajo, 0 arriba). */
export class LevelMeter {
  readonly element = h('canvas', { className: 'level-meter' });
  private levels = [0, 0];
  private paletteVersion = getPaletteVersion();
  private readPeak: (channel: number) => number;

  constructor(readPeak: (channel: number) => number) {
    this.readPeak = readPeak;
    ticker.add(this, this.element, () => this.tick());
  }

  private tick(): void {
    let changed = false;

    for (let ch = 0; ch < 2; ++ch) {
      const peak = this.readPeak(ch);
      const level = Math.max(peak, this.levels[ch] * 0.85);

      if (Math.abs(level - this.levels[ch]) > 0.001) {
        this.levels[ch] = level < 0.001 ? 0 : level;
        changed = true;
      }
    }

    // También al cambiar de tema: el fondo del medidor es de otro color.
    if (changed || this.element.width === 0 || this.paletteVersion !== getPaletteVersion()) {
      this.paletteVersion = getPaletteVersion();
      this.draw();
    }
  }

  private draw(): void {
    const width = this.element.clientWidth, height = this.element.clientHeight;

    if (width === 0 || height === 0)
      return;

    const g = prepareCanvas(this.element, width, height, false);
    const vertical = height > width;
    const gap = 1;

    for (let ch = 0; ch < 2; ++ch) {
      const x = vertical ? ch * (width + gap) / 2 : 0;
      const y = vertical ? 0 : ch * (height + gap) / 2;
      const w = vertical ? (width - gap) / 2 : width;
      const hgt = vertical ? height : (height - gap) / 2;

      g.fillStyle = Palette.panelLight.toString();
      g.fillRect(x, y, w, hgt);

      const db = gainToDecibels(this.levels[ch], -60);
      const proportion = Math.min(1, Math.max(0, (db + 60) / 60));

      if (proportion <= 0)
        continue;

      g.fillStyle = (db > -3 ? Palette.record : db > -12 ? Palette.mute : Palette.solo).toString();

      if (vertical)
        g.fillRect(x, y + hgt * (1 - proportion), w, hgt * proportion);
      else
        g.fillRect(x, y, w * proportion, hgt);
    }
  }
}

//==============================================================================
export type Icon = 'play' | 'pause' | 'stop' | 'record' | 'toStart' | 'close';

const iconPaths: Record<Icon, string> = {
  play: '<path d="M0 0 L0 10 L10 5 Z"/>',
  pause: '<rect x="0" y="0" width="3.5" height="10"/><rect x="6.5" y="0" width="3.5" height="10"/>',
  stop: '<rect x="0.5" y="0.5" width="9" height="9"/>',
  record: '<circle cx="5" cy="5" r="5"/>',
  toStart: '<rect x="0" y="0" width="1.8" height="10"/><path d="M10 0 L10 10 L2 5 Z"/>',
  close: '<path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" stroke-width="1.8" fill="none"/>',
};

/** Botón con icono (transporte, eliminar pista). */
export class IconButton {
  readonly element: HTMLButtonElement;
  private icon: Icon;

  constructor(tooltip: string | Localised, icon: Icon, activeColour?: Colour) {
    this.icon = icon;
    this.element = h('button', { className: 'icon-button', title: tooltip, type: 'button', 'aria-label': tooltip });

    // Sin color propio usa el de acento del tema (styles.css).
    if (activeColour !== undefined)
      this.element.style.setProperty('--active-colour', activeColour.toString());

    if (icon === 'record')
      this.element.classList.add('record');

    this.render();
  }

  setIcon(icon: Icon): void {
    if (icon !== this.icon) {
      this.icon = icon;
      this.render();
    }
  }

  setToggleState(on: boolean): void {
    this.element.classList.toggle('on', on);
  }

  private render(): void {
    this.element.innerHTML = `<svg viewBox="-0.5 -0.5 11 11" aria-hidden="true">${iconPaths[this.icon]}</svg>`;
  }
}
