/** Menús: la barra de menús de la aplicación y los menús emergentes (clic derecho). */
import type { Localised } from '../core/i18n.ts';
import { h } from './dom.ts';

export type MenuEntry =
  | { kind: 'item'; label: string; shortcut?: string; enabled?: boolean; ticked?: boolean; action: () => void }
  | { kind: 'separator' }
  | { kind: 'header'; label: string }
  | { kind: 'submenu'; label: string; enabled?: boolean; items: MenuEntry[] };

export const item = (label: string, action: () => void,
                     options: { shortcut?: string; enabled?: boolean; ticked?: boolean } = {}): MenuEntry =>
  ({ kind: 'item', label, action, ...options });
export const separator = (): MenuEntry => ({ kind: 'separator' });
export const header = (label: string): MenuEntry => ({ kind: 'header', label });
export const submenu = (label: string, items: MenuEntry[], enabled = true): MenuEntry =>
  ({ kind: 'submenu', label, items, enabled });

let openMenus: HTMLElement[] = [];
let onCloseAll: (() => void) | null = null;

function closeMenus(): void {
  for (const menu of openMenus)
    menu.remove();

  openMenus = [];
  const callback = onCloseAll;
  onCloseAll = null;
  callback?.();
}

function closeFrom(level: number): void {
  for (const menu of openMenus.slice(level))
    menu.remove();

  openMenus = openMenus.slice(0, level);
}

document.addEventListener('pointerdown', event => {
  if (openMenus.length > 0 && !openMenus.some(m => m.contains(event.target as Node))
      && !(event.target as Element).closest?.('.menubar-name'))
    closeMenus();
}, true);

document.addEventListener('keydown', event => {
  if (openMenus.length === 0)
    return;

  const menu = openMenus[openMenus.length - 1];
  const items = [...menu.querySelectorAll<HTMLElement>('.menu-item:not(.disabled)')];
  const current = items.indexOf(document.activeElement as HTMLElement);

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();

    if (openMenus.length > 1)
      closeFrom(openMenus.length - 1);
    else
      closeMenus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
    items[(next + items.length) % items.length]?.focus();
  } else if (event.key === 'Enter' || event.key === ' ') {
    if (current >= 0) {
      event.preventDefault();
      event.stopPropagation();
      items[current].click();
    }
  } else if (event.key === 'ArrowRight' && current >= 0 && items[current].classList.contains('has-submenu')) {
    event.preventDefault();
    items[current].dispatchEvent(new Event('mouseenter'));
    openMenus[openMenus.length - 1]?.querySelector<HTMLElement>('.menu-item:not(.disabled)')?.focus();
  } else if (event.key === 'ArrowLeft' && openMenus.length > 1) {
    event.preventDefault();
    closeFrom(openMenus.length - 1);
  } else {
    // Mientras hay un menú abierto, los atajos de la aplicación no actúan.
    event.stopPropagation();
  }
}, true);

window.addEventListener('blur', () => closeMenus());
window.addEventListener('resize', () => closeMenus());

/** Muestra un menú en (x, y) de la ventana. */
export function showMenu(entries: MenuEntry[], x: number, y: number, onClose?: () => void): void {
  closeMenus();
  onCloseAll = onClose ?? null;
  openMenu(entries, x, y, 0);
}

function openMenu(entries: MenuEntry[], x: number, y: number, level: number, alignRightOf?: DOMRect): HTMLElement {
  closeFrom(level);
  const menu = h('div', { className: 'popup-menu', role: 'menu' });

  for (const entry of entries) {
    if (entry.kind === 'separator') {
      menu.append(h('div', { className: 'menu-separator' }));
      continue;
    }

    if (entry.kind === 'header') {
      menu.append(h('div', { className: 'menu-header', text: entry.label }));
      continue;
    }

    const enabled = entry.enabled !== false && (entry.kind !== 'submenu' || entry.items.length > 0);
    const row = h('div', { className: 'menu-item' + (enabled ? '' : ' disabled'), role: 'menuitem', tabindex: -1 },
                  h('span', { className: 'menu-tick', text: entry.kind === 'item' && entry.ticked === true ? '✓' : '' }),
                  h('span', { className: 'menu-label', text: entry.label }),
                  h('span', { className: 'menu-shortcut', text: entry.kind === 'item' ? entry.shortcut ?? '' : '▸' }));

    if (entry.kind === 'submenu') {
      row.classList.add('has-submenu');
      row.addEventListener('mouseenter', () => {
        if (enabled)
          openMenu(entry.items, 0, 0, level + 1, row.getBoundingClientRect());
      });
    } else {
      row.addEventListener('mouseenter', () => {
        closeFrom(level + 1);
        row.focus({ preventScroll: true });
      });

      if (enabled) {
        row.addEventListener('click', () => {
          closeMenus();
          entry.action();
        });
      }
    }

    menu.append(row);
  }

  document.body.append(menu);
  openMenus.push(menu);

  // Dentro de la ventana.
  const rect = menu.getBoundingClientRect();

  if (alignRightOf !== undefined) {
    x = alignRightOf.right - 2;
    y = alignRightOf.top - 4;

    if (x + rect.width > window.innerWidth - 4)
      x = alignRightOf.left - rect.width + 2;
  }

  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  return menu;
}

/** Barra de menús: cada menú se construye al abrirlo (siempre al día). */
export class MenuBar {
  readonly element = h('nav', { className: 'menubar', role: 'menubar' });
  private buttons: HTMLElement[] = [];
  private open = -1;
  private getMenu: (index: number) => MenuEntry[];

  constructor(names: Localised[], getMenu: (index: number) => MenuEntry[]) {
    this.getMenu = getMenu;

    names.forEach((name, index) => {
      const button = h('button', { className: 'menubar-name', type: 'button', text: name, role: 'menuitem' });
      button.addEventListener('pointerdown', event => {
        event.preventDefault();

        if (this.open === index)
          closeMenus();
        else
          this.show(index);
      });
      button.addEventListener('mouseenter', () => {
        if (this.open >= 0 && this.open !== index)
          this.show(index);
      });
      this.buttons.push(button);
      this.element.append(button);
    });
  }

  private show(index: number): void {
    const rect = this.buttons[index].getBoundingClientRect();
    showMenu(this.getMenu(index), rect.left, rect.bottom, () => {
      this.buttons.forEach(b => b.classList.remove('open'));
      this.open = -1;
    });
    this.open = index;
    this.buttons[index].classList.add('open');
  }
}
