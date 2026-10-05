/**
    Tutorial: recorre la aplicación parte por parte. Oscurece la página, deja
    iluminada la zona de la que se habla y pone al lado una tarjeta (con una
    flecha que la señala) que explica qué hace.

    Aparece solo la primera vez que se abre StemLab Web y después desde
    Ayuda > Tutorial. Siguiente: → o Intro. Atrás: ←. Salir: Esc.
*/
import { getLanguage, languages, onLanguageChange, setLanguage, tr, type Localised } from '../core/i18n.ts';
import { isDialogOpen } from './dialogs.ts';
import { h } from './dom.ts';
import { getTheme, setTheme } from './theme.ts';

export interface TourStep {
  /** La zona que se ilumina; null = ninguna (tarjeta en el centro). */
  target: (() => Element | null) | null;
  title: Localised;
  body: Localised;
  /** El primer paso: también deja elegir idioma y tema. */
  settings?: boolean;
}

const seenKey = 'stemlab.tourSeen';
const margin = 12;          // de la tarjeta a los bordes de la ventana
const gap = 14;             // de la tarjeta a la zona iluminada
const padding = 5;          // alrededor de la zona iluminada

let active: Tour | null = null;

export function isTourSeen(): boolean {
  try { return localStorage.getItem(seenKey) === '1'; } catch { return true; }
}

export function isTourOpen(): boolean {
  return active !== null;
}

export function startTour(steps: TourStep[]): void {
  active?.close();
  active = new Tour(steps);
}

class Tour {
  private steps: TourStep[];
  private index = 0;
  private spotlight = h('div', { className: 'tour-spotlight' });
  private arrow = h('div', { className: 'tour-arrow' });
  private card = h('div', { className: 'tour-card', role: 'dialog', 'aria-modal': 'true' });
  private overlay = h('div', { className: 'tour-overlay' }, this.spotlight, this.card, this.arrow);
  private stopListening: () => void;
  private keys = (event: KeyboardEvent) => this.keyPressed(event);
  private reposition = () => this.place();

  constructor(steps: TourStep[]) {
    this.steps = steps;
    document.body.append(this.overlay);
    document.addEventListener('keydown', this.keys, true);
    window.addEventListener('resize', this.reposition);
    this.stopListening = onLanguageChange(() => this.render());
    this.render();
  }

  close(): void {
    this.overlay.remove();
    document.removeEventListener('keydown', this.keys, true);
    window.removeEventListener('resize', this.reposition);
    this.stopListening();

    try { localStorage.setItem(seenKey, '1'); } catch { /* sin almacenamiento */ }

    if (active === this)
      active = null;
  }

  private go(delta: number): void {
    const next = this.index + delta;

    if (next >= this.steps.length) {
      this.close();
    } else if (next >= 0) {
      this.index = next;
      this.render();
    }
  }

  private keyPressed(event: KeyboardEvent): void {
    // Un aviso por encima del tutorial (p. ej. "Sin audio") tiene el teclado.
    if (isDialogOpen())
      return;

    // Los atajos de la aplicación no actúan detrás del tutorial.
    event.stopPropagation();

    if (event.key === 'Tab')
      return;

    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' '))
      return;

    event.preventDefault();

    if (event.key === 'Escape')
      this.close();
    else if (event.key === 'ArrowRight' || event.key === 'Enter')
      this.go(1);
    else if (event.key === 'ArrowLeft')
      this.go(-1);
  }

  /** Botones de una opción (idioma, tema): el elegido, resaltado. */
  private choice(label: string, options: { name: string; selected: boolean; choose: () => void }[]): HTMLElement {
    const buttons = options.map(option => {
      const button = h('button', { className: 'tour-option' + (option.selected ? ' selected' : ''), type: 'button',
                                   text: option.name, 'aria-pressed': String(option.selected) });
      button.addEventListener('click', option.choose);
      return button;
    });

    return h('div', { className: 'tour-choice' }, h('span', { text: label }), h('div', { className: 'tour-options' }, ...buttons));
  }

  private render(): void {
    const step = this.steps[this.index];
    const last = this.index === this.steps.length - 1;

    const skip = h('button', { className: 'dialog-button tour-skip', type: 'button', text: tr('Saltar tutorial') });
    const back = h('button', { className: 'dialog-button', type: 'button', text: tr('Atrás') });
    const next = h('button', { className: 'dialog-button primary', type: 'button', text: last ? tr('Empezar') : tr('Siguiente') });
    skip.addEventListener('click', () => this.close());
    back.addEventListener('click', () => this.go(-1));
    next.addEventListener('click', () => this.go(1));
    back.disabled = this.index === 0;
    skip.style.visibility = last ? 'hidden' : 'visible';

    const body = h('div', { className: 'tour-body' });

    for (const paragraph of step.body.toString().split(/\n{2,}/))
      body.append(h('p', { text: paragraph }));

    if (step.settings === true) {
      body.append(
        this.choice(tr('Idioma'), languages.map(language => ({
          name: language.name,
          selected: language.id === getLanguage(),
          choose: () => setLanguage(language.id),          // vuelve a pintar este paso
        }))),
        this.choice(tr('Tema'), [
          { name: tr('Oscuro'), selected: getTheme() === 'dark', choose: () => { setTheme('dark'); this.render(); } },
          { name: tr('Claro'), selected: getTheme() === 'light', choose: () => { setTheme('light'); this.render(); } },
        ]));
    }

    this.card.setAttribute('aria-label', step.title.toString());
    this.card.replaceChildren(
      h('div', { className: 'tour-count', text: tr('Paso {0} de {1}', this.index + 1, this.steps.length) }),
      h('div', { className: 'tour-title', text: step.title.toString() }),
      body,
      h('div', { className: 'tour-buttons' }, skip, back, next));

    next.focus({ preventScroll: true });
    this.place();
  }

  /** Coloca el foco sobre la zona del paso y la tarjeta donde quepa: debajo,
      encima, a la derecha o a la izquierda (en ese orden). */
  private place(): void {
    const target = this.steps[this.index].target?.() ?? null;
    const rect = target?.getBoundingClientRect();
    const width = window.innerWidth, height = window.innerHeight;
    const cardWidth = this.card.offsetWidth, cardHeight = this.card.offsetHeight;
    const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

    // Sin zona (o si en esta pantalla no se ve): todo oscurecido y la tarjeta en el centro.
    if (rect === undefined || rect.width < 2 || rect.height < 2) {
      Object.assign(this.spotlight.style, { left: `${width / 2}px`, top: `${height / 2}px`, width: '0', height: '0' });
      this.spotlight.classList.add('empty');
      this.arrow.style.display = 'none';
      this.card.style.left = `${(width - cardWidth) / 2}px`;
      this.card.style.top = `${(height - cardHeight) / 2}px`;
      return;
    }

    const left = Math.max(2, rect.left - padding), top = Math.max(2, rect.top - padding);
    const right = Math.min(width - 2, rect.right + padding), bottom = Math.min(height - 2, rect.bottom + padding);
    Object.assign(this.spotlight.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    this.spotlight.classList.remove('empty');

    const centreX = (left + right) / 2, centreY = (top + bottom) / 2;
    let x: number, y: number, side: 'top' | 'bottom' | 'left' | 'right';

    if (bottom + gap + cardHeight + margin <= height) {
      side = 'top';
      x = centreX - cardWidth / 2;
      y = bottom + gap;
    } else if (top - gap - cardHeight - margin >= 0) {
      side = 'bottom';
      x = centreX - cardWidth / 2;
      y = top - gap - cardHeight;
    } else if (right + gap + cardWidth + margin <= width) {
      side = 'left';
      x = right + gap;
      y = centreY - cardHeight / 2;
    } else if (left - gap - cardWidth - margin >= 0) {
      side = 'right';
      x = left - gap - cardWidth;
      y = centreY - cardHeight / 2;
    } else {
      // No cabe fuera (una zona que ocupa casi toda la ventana): dentro, abajo.
      side = 'top';
      x = centreX - cardWidth / 2;
      y = bottom - cardHeight - gap - margin;
      this.arrow.style.display = 'none';
      this.card.style.left = `${clamp(x, margin, width - cardWidth - margin)}px`;
      this.card.style.top = `${clamp(y, margin, height - cardHeight - margin)}px`;
      return;
    }

    x = clamp(x, margin, width - cardWidth - margin);
    y = clamp(y, margin, height - cardHeight - margin);
    this.card.style.left = `${x}px`;
    this.card.style.top = `${y}px`;

    // La flecha sale del borde de la tarjeta que mira a la zona, hacia su centro.
    const size = 14;
    const arrowX = side === 'left' ? x - size / 2 : side === 'right' ? x + cardWidth - size / 2
                 : clamp(centreX, x + 18, x + cardWidth - 18) - size / 2;
    const arrowY = side === 'top' ? y - size / 2 : side === 'bottom' ? y + cardHeight - size / 2
                 : clamp(centreY, y + 18, y + cardHeight - 18) - size / 2;
    this.arrow.style.display = 'block';
    this.arrow.style.left = `${arrowX}px`;
    this.arrow.style.top = `${arrowY}px`;
    this.arrow.dataset.side = side;
  }
}
