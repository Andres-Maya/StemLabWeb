/** Audio > Configuración de audio: micrófono, salida y datos del dispositivo. */
import type { AudioEngine } from '../audio/engine.ts';
import { tr } from '../core/i18n.ts';
import { openDialog } from './dialogs.ts';
import { h } from './dom.ts';

export async function showAudioSettings(engine: AudioEngine, onMessage: (message: string) => void): Promise<void> {
  const inputSelect = h('select', { className: 'field', id: 'audio-input' });
  const outputSelect = h('select', { className: 'field', id: 'audio-output' });
  const info = h('p', { className: 'dialog-hint' });
  const permission = h('button', { className: 'text-button', type: 'button', text: tr('Permitir el micrófono') });

  const fill = async () => {
    const { inputs, outputs } = await engine.listDevices();
    const labelled = inputs.some(d => d.label !== '');

    inputSelect.replaceChildren(h('option', { value: '', text: tr('Micrófono predeterminado del sistema') }));
    inputs.forEach((d, i) => inputSelect.append(h('option', { value: d.deviceId, text: d.label || tr('Entrada {0}', i + 1) })));
    inputSelect.value = inputs.some(d => d.deviceId === engine.inputDeviceId) ? engine.inputDeviceId : '';
    permission.style.display = engine.hasMicrophone() || labelled ? 'none' : '';

    // "Predeterminada": el navegador sigue a la salida del sistema (cambia sola
    // a los audífonos al conectarlos, como el resto de programas).
    outputSelect.replaceChildren(h('option', { value: '', text: tr('Usar la salida predeterminada del sistema') }));
    outputs.forEach((d, i) => outputSelect.append(h('option', { value: d.deviceId, text: d.label || tr('Salida {0}', i + 1) })));
    outputSelect.value = outputs.some(d => d.deviceId === engine.outputDeviceId) ? engine.outputDeviceId : '';
    outputSelect.disabled = !engine.canChooseOutput();

    const latency = Math.round(((engine.context.baseLatency || 0) + (engine.context.outputLatency || 0)) * 1000);
    info.textContent = tr('Frecuencia: {0} Hz · latencia de salida: ~{1} ms', engine.sampleRate, latency) + ' · '
                     + (engine.hasMicrophone() ? tr('entrada: {0}', engine.getInputName() || tr('micrófono')) : tr('micrófono sin abrir'));
  };

  inputSelect.addEventListener('change', async () => {
    try {
      await engine.enableMicrophone(inputSelect.value);
      onMessage(tr('Entrada: {0}', engine.getInputName() || tr('micrófono predeterminado')));
    } catch {
      onMessage(tr('No se pudo abrir ese micrófono.'));
    }

    await fill();
  });

  outputSelect.addEventListener('change', async () => {
    try {
      await engine.setOutputDevice(outputSelect.value);
      onMessage(tr('Salida: {0}', tr(engine.outputName)));
    } catch {
      onMessage(tr('No se pudo cambiar la salida de audio.'));
    }

    await fill();
  });

  permission.addEventListener('click', async () => {
    try {
      await engine.enableMicrophone();
    } catch {
      onMessage(tr('El navegador no dio permiso para usar el micrófono.'));
    }

    await fill();
  });

  const content = h('div', { className: 'form' },
    h('label', { className: 'form-row', for: 'audio-input' }, h('span', { text: tr('Entrada') }), inputSelect),
    h('div', { className: 'form-row' }, h('span'), permission),
    h('label', { className: 'form-row', for: 'audio-output' }, h('span', { text: tr('Salida') }), outputSelect),
    h('p', { className: 'dialog-hint', text: engine.canChooseOutput()
      ? tr('Con la salida predeterminada, StemLab cambia solo a los audífonos al conectarlos. Si eliges otra, se mantiene mientras esté conectada.')
      : tr('Este navegador no permite elegir la salida: se usa la predeterminada del sistema.') }),
    h('p', { className: 'dialog-hint', text: tr('Se graba sin supresión de ruido, cancelación de eco ni control automático de ganancia, '
      + 'y la grabación se compensa por la latencia del dispositivo. La ganancia del micrófono está en "Entrada", en la barra superior.') }),
    info);

  openDialog(tr('Configuración de audio'), content, [{ label: tr('Cerrar'), value: 1, primary: true }], () => undefined, { wide: true });
  await fill();
}
