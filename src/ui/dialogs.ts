/** Ventanas modales dentro de la página (avisos, confirmaciones y diálogos propios). */
import { h } from './dom.ts';

export interface DialogButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
  value: number;
}

export interface Dialog {
  element: HTMLElement;
  body: HTMLElement;
  close(value?: number): void;
}

let openDialogs = 0;

export function isDialogOpen(): boolean {
  return openDialogs > 0;
}

/** Diálogo con título, contenido y botones. Esc = el valor 0 (cancelar). */
export function openDialog(title: string, content: Node | string, buttons: DialogButton[],
                           onClose: (value: number) => void, options: { icon?: 'warning' | 'info' | 'question'; wide?: boolean } = {}): Dialog {
  const body = h('div', { className: 'dialog-body' });

  if (typeof content === 'string') {
    for (const paragraph of content.split(/\n{2,}/))
      body.append(h('p', { text: paragraph }));
  } else {
    body.append(content);
  }

  const footer = h('div', { className: 'dialog-buttons' });
  const panel = h('div', { className: 'dialog' + (options.wide === true ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true',
                           'aria-label': title },
                  h('div', { className: 'dialog-title' },
                    options.icon !== undefined ? h('span', { className: 'dialog-icon ' + options.icon, 'aria-hidden': 'true' }) : null,
                    h('span', { text: title })),
                  body, footer);
  const overlay = h('div', { className: 'dialog-overlay' }, panel);
  let closed = false;
  const previousFocus = document.activeElement as HTMLElement | null;

  const close = (value = 0) => {
    if (closed)
      return;

    closed = true;
    --openDialogs;
    overlay.remove();
    document.removeEventListener('keydown', keys, true);
    previousFocus?.focus?.({ preventScroll: true });
    onClose(value);
  };

  const keys = (event: KeyboardEvent) => {
    if (!overlay.isConnected)
      return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(0);
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)
               && !(event.target instanceof HTMLButtonElement)) {
      const primary = buttons.find(b => b.primary);

      if (primary !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        close(primary.value);
      }
    } else {
      // Los atajos de la aplicación no actúan detrás del diálogo.
      event.stopPropagation();
    }
  };

  for (const button of buttons) {
    const element = h('button', { className: 'dialog-button' + (button.primary === true ? ' primary' : '')
                                    + (button.danger === true ? ' danger' : ''), type: 'button', text: button.label });
    element.addEventListener('click', () => close(button.value));
    footer.append(element);
  }

  document.addEventListener('keydown', keys, true);
  document.body.append(overlay);
  ++openDialogs;

  const focusTarget = panel.querySelector<HTMLElement>('input, select, textarea')
                   ?? footer.querySelector<HTMLElement>('.primary') ?? footer.querySelector('button');
  focusTarget?.focus();

  return { element: panel, body, close };
}

export function showMessage(title: string, message: string, icon: 'warning' | 'info' = 'warning'): Promise<void> {
  return new Promise(resolve => {
    openDialog(title, message, [{ label: 'OK', value: 1, primary: true }], () => resolve(), { icon });
  });
}

/** Aceptar / Cancelar. Devuelve true si se acepta. */
export function showConfirm(title: string, message: string, okLabel: string, cancelLabel = 'Cancelar',
                            danger = false): Promise<boolean> {
  return new Promise(resolve => {
    openDialog(title, message, [
      { label: cancelLabel, value: 0 },
      { label: okLabel, value: 1, primary: true, danger },
    ], value => resolve(value === 1), { icon: 'warning' });
  });
}
