/** Diálogo "Exportar / descargar": qué se descarga, en qué formato y con qué nombre. */
import { msg, tr } from '../core/i18n.ts';
import type { ExportFormat } from '../export/exporter.ts';
import { openDialog, type Dialog } from './dialogs.ts';
import { h } from './dom.ts';

export interface ExportScope {
  id: string;
  label: string;
  defaultName: string;
  zip: boolean;               // varias pistas: se descargan juntas en un .zip
}

export interface ExportChoice {
  scope: ExportScope;
  format: ExportFormat;
  mp3Bitrate: number;
  name: string;
}

const formatOptions: { label: string; format: ExportFormat; bitrate: number }[] = [
  { label: msg('WAV 24 bits (recomendado)'), format: 'wav24', bitrate: 0 },
  { label: msg('WAV 16 bits (calidad CD)'), format: 'wav16', bitrate: 0 },
  { label: msg('WAV 32 bits coma flotante'), format: 'wav32', bitrate: 0 },
  { label: 'MP3 320 kbps', format: 'mp3', bitrate: 320 },
  { label: 'MP3 192 kbps', format: 'mp3', bitrate: 192 },
  { label: 'MP3 128 kbps', format: 'mp3', bitrate: 128 },
];

let lastFormat = 0;

export function showExportDialog(scopes: ExportScope[], initialScope: string): Promise<ExportChoice | null> {
  const scopeSelect = h('select', { className: 'field', id: 'export-scope' });
  scopes.forEach(s => scopeSelect.append(h('option', { value: s.id, text: s.label })));
  scopeSelect.value = scopes.some(s => s.id === initialScope) ? initialScope : scopes[0].id;

  const formatSelect = h('select', { className: 'field', id: 'export-format' });
  formatOptions.forEach((f, i) => formatSelect.append(h('option', { value: String(i), text: tr(f.label) })));
  formatSelect.value = String(lastFormat);

  const nameInput = h('input', { className: 'field', id: 'export-name', type: 'text', spellcheck: 'false' });
  const extension = h('span', { className: 'field-suffix' });
  const hint = h('p', { className: 'dialog-hint' });

  const scope = () => scopes.find(s => s.id === scopeSelect.value)!;
  const updateScope = (resetName: boolean) => {
    const current = scope();

    if (resetName)
      nameInput.value = current.defaultName;

    extension.textContent = current.zip ? '.zip' : formatOptions[Number(formatSelect.value)].format === 'mp3' ? '.mp3' : '.wav';
    hint.textContent = current.id === 'mix'
      ? tr('Se descarga la mezcla completa tal como suena: volumen, paneo, mute, solo, efectos y volumen master.')
      : current.zip
        ? tr('Cada pista en su propio archivo, desde el principio hasta el final del proyecto (así quedan alineadas), con sus efectos, volumen y paneo.')
        : tr('La pista sola, desde el principio del proyecto hasta su último fragmento, con sus efectos, volumen y paneo.');
  };

  scopeSelect.addEventListener('change', () => updateScope(true));
  formatSelect.addEventListener('change', () => updateScope(false));
  updateScope(true);

  const content = h('div', { className: 'form' },
    h('label', { className: 'form-row', for: 'export-scope' }, h('span', { text: tr('Qué') }), scopeSelect),
    h('label', { className: 'form-row', for: 'export-format' }, h('span', { text: tr('Formato') }), formatSelect),
    h('label', { className: 'form-row', for: 'export-name' }, h('span', { text: tr('Nombre') }),
      h('div', { className: 'field-with-suffix' }, nameInput, extension)),
    hint,
    h('p', { className: 'dialog-hint', text: tr('El archivo se guarda en la carpeta de descargas del navegador. Nada se sube a la nube.') }));

  return new Promise(resolve => {
    openDialog(tr('Exportar / descargar'), content, [
      { label: tr('Cancelar'), value: 0 },
      { label: tr('Descargar'), value: 1, primary: true },
    ], value => {
      if (value !== 1) {
        resolve(null);
        return;
      }

      const index = Number(formatSelect.value);
      lastFormat = index;
      const option = formatOptions[index];
      resolve({ scope: scope(), format: option.format, mp3Bitrate: option.bitrate, name: nameInput.value.trim() || scope().defaultName });
    }, { wide: true });

    nameInput.select();
  });
}

/** Ventana de progreso con Cancelar. */
export class ProgressDialog {
  private dialog: Dialog;
  private bar = h('div', { className: 'progress-bar-fill' });
  private text = h('div', { className: 'progress-text' });

  constructor(title: string, message: string, onCancel: () => void) {
    const content = h('div', {}, h('p', { text: message }),
      h('div', { className: 'progress-bar' }, this.bar), this.text);
    this.dialog = openDialog(title, content, [{ label: tr('Cancelar'), value: 0 }], value => {
      if (value === 0)
        onCancel();
    });
  }

  setProgress(value: number): void {
    const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
    this.bar.style.width = `${percent}%`;
    this.text.textContent = `${percent} %`;
  }

  close(): void {
    this.dialog.close(-1);
  }
}
