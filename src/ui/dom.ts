/** Utilidades mínimas de DOM. */
type Attributes = Record<string, string | number | boolean | undefined | ((event: never) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {},
                                                          ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false)
      continue;

    if (typeof value === 'function')
      element.addEventListener(key.replace(/^on/, '').toLowerCase(), value as EventListener);
    else if (key === 'className')
      element.className = String(value);
    else if (key === 'text')
      element.textContent = String(value);
    else
      element.setAttribute(key, value === true ? '' : String(value));
  }

  for (const child of children)
    if (child !== null && child !== undefined)
      element.append(child);

  return element;
}

/** Temporizador compartido de la interfaz (~30 veces por segundo). Los
    elementos que ya no están en la página dejan de recibirlo solos. */
class Ticker {
  private callbacks = new Map<object, { element: Element | null; fn: () => void }>();
  private handle = 0;

  add(owner: object, element: Element | null, fn: () => void): void {
    this.callbacks.set(owner, { element, fn });

    if (this.handle === 0)
      this.handle = window.setInterval(() => this.run(), 33);
  }

  remove(owner: object): void {
    this.callbacks.delete(owner);
  }

  private run(): void {
    for (const [owner, { element, fn }] of [...this.callbacks]) {
      if (element !== null && !element.isConnected) {
        // Todavía no insertado: se le da un margen; si se quitó, se olvida.
        if ((element as HTMLElement).dataset.tickerSeen === '1')
          this.callbacks.delete(owner);

        continue;
      }

      if (element !== null)
        (element as HTMLElement).dataset.tickerSeen = '1';

      fn();
    }
  }
}

export const ticker = new Ticker();

/** Lienzo con la resolución de la pantalla (nítido en pantallas HiDPI). */
export function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number, setStyle = true): CanvasRenderingContext2D {
  const ratio = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(width * ratio));
  const hgt = Math.max(1, Math.round(height * ratio));

  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
  }

  // Los lienzos que mide el CSS (medidores, pantalla de separación) no se fijan.
  if (setStyle) {
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
  }

  const g = canvas.getContext('2d')!;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  return g;
}

export function roundedRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, hgt: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, hgt / 2));
  g.beginPath();
  g.roundRect(x, y, w, hgt, r);
}

/** Arrastre con el puntero: onMove recibe el desplazamiento desde el principio. */
export function trackPointer(event: PointerEvent, onMove: (e: PointerEvent) => void, onUp?: (e: PointerEvent) => void): void {
  const target = event.currentTarget as Element | null;
  const id = event.pointerId;

  try { target?.setPointerCapture?.(id); } catch { /* sin captura */ }

  const move = (e: PointerEvent) => { if (e.pointerId === id) onMove(e); };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== id)
      return;

    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onUp?.(e);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** ¿El foco está en un campo de texto? (los atajos de teclado no se aplican). */
export function isEditingText(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement
      || (active instanceof HTMLElement && active.isContentEditable);
}
