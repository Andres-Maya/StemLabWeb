/**
    Mezclador de la pista seleccionada:

        [Canal: volumen · paneo · medidor] [Gain] [Saturación] [EQ] [Compresor] [Limiter]

    Los paneles de efectos se construyen a partir de sus parámetros: un efecto
    nuevo aparece aquí sin escribir UI específica.
*/
import type { AudioEngine } from '../audio/engine.ts';
import { L, tr } from '../core/i18n.ts';
import type { AudioTrack, EffectModel } from '../model/track.ts';
import { choiceBox, Knob, LevelMeter, LinearSlider, tickBox } from './controls.ts';
import { h } from './dom.ts';

class EffectPanel {
  readonly element: HTMLElement;
  private effect: EffectModel;
  private knobs: Knob[] = [];

  constructor(effect: EffectModel) {
    this.effect = effect;
    const grid = h('div', { className: 'effect-grid' });
    const columns = Math.max(1, Math.ceil(effect.params.length / 2));
    grid.style.gridTemplateColumns = `repeat(${columns}, 68px)`;

    for (const parameter of effect.params) {
      if (parameter.kind === 'choice') {
        grid.append(h('div', { className: 'effect-control' },
          h('div', { className: 'control-label', text: tr(parameter.name) }), choiceBox(parameter)));
      } else {
        const knob = new Knob(parameter, { size: 46, textBox: true, label: tr(parameter.name) });
        this.knobs.push(knob);
        grid.append(h('div', { className: 'effect-control' }, knob.element));
      }
    }

    this.element = h('div', { className: 'effect-panel' },
      h('div', { className: 'effect-header' },
        h('div', { className: 'effect-name', text: tr(effect.name) }),
        tickBox(effect.enabled, tr('Activar / desactivar'))),
      grid);

    this.element.style.width = `${Math.max(110, columns * 68 + 16)}px`;
    effect.enabled.onChange(() => this.updateEnablement());
    this.updateEnablement();
  }

  private updateEnablement(): void {
    const enabled = this.effect.enabled.getBool();
    this.element.classList.toggle('enabled', enabled);

    for (const knob of this.knobs)
      knob.setEnabledLook(enabled);
  }
}

export class MixerView {
  readonly element = h('section', { className: 'mixer', 'aria-label': L('Mezclador') });
  private title = h('div', { className: 'mixer-track-name' });
  private rack = h('div', { className: 'mixer-rack' });
  private track: AudioTrack | null = null;
  private engine: AudioEngine;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    this.element.append(h('div', { className: 'mixer-title' }, h('span', { text: L('MEZCLADOR') }), this.title), this.rack);
    this.setTrack(null);
  }

  /** Vuelve a construir los controles (cambió el idioma o el tema). */
  rebuild(): void {
    this.rack.replaceChildren();
    this.setTrack(this.track);
  }

  setTrack(track: AudioTrack | null): void {
    if (track === this.track && this.rack.childElementCount > 0)
      return;

    this.track = track;
    this.rack.replaceChildren();
    this.updateName();

    if (track === null) {
      this.rack.append(h('div', { className: 'mixer-empty', text: tr('Selecciona una pista para ver su canal y sus efectos.') }));
      return;
    }

    const volume = new LinearSlider(track.volume, { vertical: true, textBox: 'below', textWidth: 64 });
    const pan = new Knob(track.pan, { size: 60, textBox: true });
    const meter = new LevelMeter(ch => this.engine.getAndResetTrackPeak(track.id, ch));
    meter.element.classList.add('strip-meter');

    this.rack.append(h('div', { className: 'channel-strip' },
      h('div', { className: 'strip-column' }, h('div', { className: 'control-label', text: tr('Volumen') }), volume.element),
      h('div', { className: 'strip-column' }, h('div', { className: 'control-label', text: tr('Paneo') }), pan.element),
      meter.element));

    for (const effect of track.effects)
      this.rack.append(new EffectPanel(effect).element);
  }

  /** El nombre de la pista puede haber cambiado (deshacer, F2). */
  updateName(): void {
    this.title.textContent = this.track?.name ?? '';
  }
}
