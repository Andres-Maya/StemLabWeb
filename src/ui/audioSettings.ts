/** Audio > Configuración de audio: micrófono, salida y datos del dispositivo. */
import type { AudioEngine } from '../audio/engine.ts';
import { openDialog } from './dialogs.ts';
import { h } from './dom.ts';

export async function showAudioSettings(engine: AudioEngine, onMessage: (message: string) => void): Promise<void> {
  const inputSelect = h('select', { className: 'field', id: 'audio-input' });
  const outputSelect = h('select', { className: 'field', id: 'audio-output' });
  const info = h('p', { className: 'dialog-hint' });
  const permission = h('button', { className: 'text-button', type: 'button', text: 'Permitir el micrófono' });

  const fill = async () => {
    const { inputs, outputs } = await engine.listDevices();
    const labelled = inputs.some(d => d.label !== '');

    inputSelect.replaceChildren(h('option', { value: '', text: 'Micrófono predeterminado del sistema' }));
    inputs.forEach((d, i) => inputSelect.append(h('option', { value: d.deviceId, text: d.label || `Entrada ${i + 1}` })));
    inputSelect.value = inputs.some(d => d.deviceId === engine.inputDeviceId) ? engine.inputDeviceId : '';
    permission.style.display = engine.hasMicrophone() || labelled ? 'none' : '';

    // "Predeterminada": el navegador sigue a la salida del sistema (cambia sola
    // a los audífonos al conectarlos, como el resto de programas).
    outputSelect.replaceChildren(h('option', { value: '', text: 'Usar la salida predeterminada del sistema' }));
    outputs.forEach((d, i) => outputSelect.append(h('option', { value: d.deviceId, text: d.label || `Salida ${i + 1}` })));
    outputSelect.value = outputs.some(d => d.deviceId === engine.outputDeviceId) ? engine.outputDeviceId : '';
    outputSelect.disabled = !engine.canChooseOutput();

    const latency = Math.round(((engine.context.baseLatency || 0) + (engine.context.outputLatency || 0)) * 1000);
    info.textContent = `Frecuencia: ${engine.sampleRate} Hz · latencia de salida: ~${latency} ms`
                     + (engine.hasMicrophone() ? ` · entrada: ${engine.getInputName() || 'micrófono'}` : ' · micrófono sin abrir');
  };

  inputSelect.addEventListener('change', async () => {
    try {
      await engine.enableMicrophone(inputSelect.value);
      onMessage('Entrada: ' + (engine.getInputName() || 'micrófono predeterminado'));
    } catch {
      onMessage('No se pudo abrir ese micrófono.');
    }

    await fill();
  });

  outputSelect.addEventListener('change', async () => {
    try {
      await engine.setOutputDevice(outputSelect.value);
      onMessage('Salida: ' + engine.outputName);
    } catch {
      onMessage('No se pudo cambiar la salida de audio.');
    }

    await fill();
  });

  permission.addEventListener('click', async () => {
    try {
      await engine.enableMicrophone();
    } catch {
      onMessage('El navegador no dio permiso para usar el micrófono.');
    }

    await fill();
  });

  const content = h('div', { className: 'form' },
    h('label', { className: 'form-row', for: 'audio-input' }, h('span', { text: 'Entrada' }), inputSelect),
    h('div', { className: 'form-row' }, h('span'), permission),
    h('label', { className: 'form-row', for: 'audio-output' }, h('span', { text: 'Salida' }), outputSelect),
    h('p', { className: 'dialog-hint', text: engine.canChooseOutput()
      ? 'Con la salida predeterminada, StemLab cambia solo a los audífonos al conectarlos. Si eliges otra, se mantiene mientras esté conectada.'
      : 'Este navegador no permite elegir la salida: se usa la predeterminada del sistema.' }),
    h('p', { className: 'dialog-hint', text: 'Se graba sin supresión de ruido, cancelación de eco ni control automático de ganancia, '
      + 'y la grabación se compensa por la latencia del dispositivo. La ganancia del micrófono está en "Entrada", en la barra superior.' }),
    info);

  openDialog('Configuración de audio', content, [{ label: 'Cerrar', value: 1, primary: true }], () => undefined, { wide: true });
  await fill();
}
