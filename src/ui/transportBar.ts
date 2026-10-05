/** ⏮ ▶ ⏹ ⏺ · tiempo · BPM · entrada · salida · master. */
import type { AudioEngine } from '../audio/engine.ts';
import { L, tr } from '../core/i18n.ts';
import { formatTime } from '../core/strings.ts';
import type { ProjectManager } from '../model/project.ts';
import { Palette } from './colour.ts';
import { IconButton, LevelMeter, LinearSlider } from './controls.ts';
import { h, localise, ticker } from './dom.ts';

export class TransportBar {
  readonly element = h('div', { className: 'transport-bar' });
  onToStart: () => void = () => undefined;
  onPlayPause: () => void = () => undefined;
  onStop: () => void = () => undefined;
  onRecord: () => void = () => undefined;

  private engine: AudioEngine;
  private projects: ProjectManager;
  private playButton = new IconButton(L('Reproducir / Pausa (Espacio)'), 'play');
  private recordButton = new IconButton(L('Grabar en la pista seleccionada (R)'), 'record', Palette.record);
  private timeLabel = h('div', { className: 'time-label' });
  private bpmLabel = h('div', { className: 'bpm-label', title: L('Doble clic para editar') });
  private deviceLabel = h('div', { className: 'device-label', title: L('Salida de audio actual (Audio > Configuración de audio)') });
  private blinkCounter = 0;

  constructor(engine: AudioEngine, projects: ProjectManager) {
    this.engine = engine;
    this.projects = projects;

    const toStart = new IconButton(L('Ir al inicio'), 'toStart');
    const stop = new IconButton(L('Detener'), 'stop');
    toStart.element.addEventListener('click', () => this.onToStart());
    this.playButton.element.addEventListener('click', () => this.onPlayPause());
    stop.element.addEventListener('click', () => this.onStop());
    this.recordButton.element.addEventListener('click', () => this.onRecord());

    this.bpmLabel.addEventListener('dblclick', () => this.editBpm());

    // Ganancia del micrófono antes de grabar, con su medidor (se mueve aunque no
    // se esté grabando, para ajustar el nivel antes).
    const input = new LinearSlider(engine.inputGain, { colour: Palette.record, textBox: 'right', textWidth: 64 });
    localise(input.element, 'title', L('Ganancia de la entrada al grabar. Ajústala para que el medidor quede en verde/amarillo '
                                       + 'al hablar o tocar; un limitador suave evita que recorte.'));
    const inputMeter = new LevelMeter(ch => engine.getAndResetInputPeak(ch));
    inputMeter.element.classList.add('horizontal-meter');
    localise(inputMeter.element, 'title', L('Nivel de la entrada (micrófono)'));

    const master = new LinearSlider(engine.masterVolume, { textBox: 'right', textWidth: 64 });
    const masterMeter = new LevelMeter(ch => engine.getAndResetMasterPeak(ch));
    masterMeter.element.classList.add('horizontal-meter');

    this.element.append(
      h('div', { className: 'transport-buttons' }, toStart.element, this.playButton.element, stop.element, this.recordButton.element),
      this.timeLabel,
      h('div', { className: 'caption bpm-caption', text: 'BPM' }), this.bpmLabel,
      h('div', { className: 'caption input-caption', text: L('Entrada') }),
      h('div', { className: 'transport-input' }, input.element, inputMeter.element),
      this.deviceLabel,
      h('div', { className: 'caption', text: 'Master' }),
      h('div', { className: 'transport-master' }, master.element, masterMeter.element),
    );

    ticker.add(this, null, () => this.tick());
    this.tick();
  }

  private editBpm(): void {
    const field = h('input', { type: 'text', className: 'bpm-input', value: this.projects.bpm.toFixed(1) });
    this.bpmLabel.replaceChildren(field);
    field.focus();
    field.select();

    field.addEventListener('keydown', e => {
      e.stopPropagation();

      if (e.key === 'Enter') field.blur();
      if (e.key === 'Escape') { field.value = ''; field.blur(); }
    });

    field.addEventListener('blur', () => {
      const value = parseFloat(field.value.replace(',', '.'));

      if (value > 0)
        this.projects.setBpm(value);

      this.bpmLabel.textContent = this.projects.bpm.toFixed(1);
    });
  }

  private tick(): void {
    const rate = this.engine.sampleRate;
    const position = this.engine.getPosition() / rate;
    const length = this.projects.getContentLength() / rate;
    this.timeLabel.textContent = formatTime(position) + '  /  ' + formatTime(length);

    this.playButton.setIcon(this.engine.isPlaying() ? 'pause' : 'play');

    // El botón de grabar parpadea mientras se graba.
    const recording = this.engine.isRecording();
    this.blinkCounter = recording ? (this.blinkCounter + 1) % 30 : 0;
    this.recordButton.setToggleState(recording && this.blinkCounter < 18);

    if (!(this.bpmLabel.firstChild instanceof HTMLInputElement))
      this.bpmLabel.textContent = this.projects.bpm.toFixed(1);

    // Qué salida está sonando; en rojo si el audio no funciona.
    const running = this.engine.isRunning();
    const text = this.engine.initError !== '' ? tr('Sin audio: este navegador no admite AudioWorklet')
               : running ? tr('Salida: {0}', tr(this.engine.outputName))
               : tr('Audio en pausa: haz clic en la página para activarlo');

    if (this.deviceLabel.textContent !== text) {
      this.deviceLabel.textContent = text;
      this.deviceLabel.classList.toggle('error', !running);
    }
  }
}
