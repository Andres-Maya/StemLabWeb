/**
    Parámetro compartido entre la interfaz y el motor de audio: la interfaz lo
    cambia con set() y avisa a sus oyentes (controles, motor) para que se
    mantengan sincronizados. Lo usan los efectos y las pistas (volumen, paneo,
    mute, solo), así que la UI funciona igual para todos.
*/
import { NormalisableRange } from './range.ts';
import type { ParamDef, ParamKind } from '../dsp/effectDefs.ts';

export class Parameter {
  readonly id: string;
  readonly name: string;
  readonly kind: ParamKind;
  readonly range: NormalisableRange;
  readonly defaultValue: number;
  readonly unit: string;
  readonly choices: string[];
  private value: number;
  private listeners = new Set<(p: Parameter) => void>();
  textFormatter: ((value: number) => string) | null = null;

  private constructor(id: string, name: string, kind: ParamKind, range: NormalisableRange,
                      defaultValue: number, unit = '', choices: string[] = []) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.range = range;
    this.unit = unit;
    this.choices = choices;
    this.defaultValue = range.snapToLegalValue(defaultValue);
    this.value = this.defaultValue;
  }

  static continuous(id: string, name: string, range: NormalisableRange, defaultValue: number, unit = ''): Parameter {
    return new Parameter(id, name, 'continuous', range, defaultValue, unit);
  }

  static toggle(id: string, name: string, defaultValue: boolean): Parameter {
    return new Parameter(id, name, 'toggle', new NormalisableRange(0, 1, 1), defaultValue ? 1 : 0);
  }

  static choice(id: string, name: string, choices: string[], defaultIndex: number): Parameter {
    return new Parameter(id, name, 'choice', new NormalisableRange(0, Math.max(1, choices.length - 1), 1),
                         defaultIndex, '', choices);
  }

  static fromDef(def: ParamDef): Parameter {
    if (def.kind === 'choice')
      return Parameter.choice(def.id, def.name, def.choices ?? [], def.defaultValue);

    if (def.kind === 'toggle')
      return Parameter.toggle(def.id, def.name, def.defaultValue >= 0.5);

    const range = def.centre !== undefined
      ? NormalisableRange.withCentre(def.min, def.max, def.interval, def.centre)
      : new NormalisableRange(def.min, def.max, def.interval, def.skew ?? 1);

    return Parameter.continuous(def.id, def.name, range, def.defaultValue, def.unit ?? '');
  }

  get(): number            { return this.value; }
  getBool(): boolean       { return this.value >= 0.5; }
  getIndex(): number       { return Math.round(this.value); }

  set(newValue: number): void {
    newValue = this.range.snapToLegalValue(newValue);

    if (newValue === this.value || Number.isNaN(newValue))
      return;

    this.value = newValue;

    for (const listener of [...this.listeners])
      listener(this);
  }

  resetToDefault(): void {
    this.set(this.defaultValue);
  }

  /** Devuelve la función para dejar de escuchar. */
  onChange(listener: (p: Parameter) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  toText(v = this.value): string {
    if (this.textFormatter !== null)
      return this.textFormatter(v);

    if (this.kind === 'toggle')
      return v >= 0.5 ? 'On' : 'Off';

    if (this.kind === 'choice')
      return this.choices[Math.round(v)] ?? '';

    if (this.unit === 'Hz' && v >= 1000)
      return (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz';

    const magnitude = Math.abs(v);
    const decimals = this.range.interval >= 1 ? 0 : magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
    const text = v.toFixed(decimals);

    return this.unit === '' ? text : text + ' ' + this.unit;
  }
}
