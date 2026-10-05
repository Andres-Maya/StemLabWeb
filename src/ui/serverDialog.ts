/** IA > Servidor de separación: dónde está el servidor de Python con Demucs. */
import { checkSeparationServer, defaultSeparationServer, getSeparationServer, isLocalPage,
         normaliseServerUrl, setSeparationServer } from '../ai/serverConfig.ts';
import { tr } from '../core/i18n.ts';
import { showDesktopDownloadDialog } from './desktopDownload.ts';
import { openDialog } from './dialogs.ts';
import { h } from './dom.ts';

/** Devuelve true si se guardó una dirección que responde. */
export function showSeparationServerDialog(onMessage: (message: string) => void): Promise<boolean> {
  const input = h('input', { className: 'field', id: 'separation-server', type: 'text', spellcheck: 'false',
                             placeholder: isLocalPage() ? tr('vacío = esta misma web') : 'http://localhost:8000' });
  input.value = getSeparationServer();

  const result = h('p', { className: 'server-check', role: 'status' });
  const test = h('button', { className: 'text-button', type: 'button', text: tr('Probar conexión') });
  const local = h('button', { className: 'text-button', type: 'button', text: tr('Usar este equipo (localhost:8000)') });

  const run = async () => {
    result.className = 'server-check';
    result.textContent = tr('Comprobando...');
    const check = await checkSeparationServer(normaliseServerUrl(input.value));
    result.className = 'server-check ' + (check.ok ? 'ok' : 'error');
    result.textContent = check.message;
    return check.ok;
  };

  test.addEventListener('click', () => void run());
  local.addEventListener('click', () => {
    input.value = 'http://localhost:8000';
    void run();
  });

  const content = h('div', { className: 'form' },
    h('p', { className: 'dialog-hint', text: tr('La separación por IA la hace Demucs en el servidor de StemLab Web '
      + '(server/stemlab_server.py). No puede ejecutarse dentro del navegador ni en Vercel: arráncalo en tu equipo '
      + 'o en un servidor y escribe aquí su dirección.') }),
    h('label', { className: 'form-row', for: 'separation-server' }, h('span', { text: tr('Dirección') }), input),
    h('div', { className: 'form-row' }, h('span'), h('div', { className: 'button-row' }, test, local)),
    result,
    h('p', { className: 'dialog-hint', text: tr('En este equipo:  python server/stemlab_server.py  (con el Python que tiene '
      + 'Demucs; ver README.md). La primera vez, el navegador puede pedir permiso para acceder a la red local. '
      + 'La canción se envía solo a ese servidor, que la borra junto con los stems en cuanto se descargan.') }),
    h('p', { className: 'dialog-hint', text: tr('¿Sin servidor? StemLab para Windows separa en tu equipo: lleva Python y '
      + 'Demucs incluidos.') }));

  return new Promise(resolve => {
    openDialog(tr('Servidor de separación'), content, [
      { label: tr('Cancelar'), value: 0 },
      { label: tr('StemLab para Windows'), value: 2 },
      { label: tr('Guardar'), value: 1, primary: true },
    ], async value => {
      if (value === 2)
        showDesktopDownloadDialog();

      if (value !== 1) {
        resolve(false);
        return;
      }

      const saved = setSeparationServer(input.value);
      const check = await checkSeparationServer(saved);
      onMessage(tr('Servidor de separación: {0}.', saved === '' ? tr('esta misma web') : saved) + ' '
                + (check.ok ? tr('Conectado.') : check.message));
      resolve(check.ok);
    }, { wide: true });

    if (input.value === '' && defaultSeparationServer() === '' && !isLocalPage())
      input.value = 'http://localhost:8000';

    void run();
  });
}

