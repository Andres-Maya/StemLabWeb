/**
    Efectos de la cadena de cada pista. Es el mismo DSP que StemLab de
    escritorio (JUCE), portado muestra a muestra:

        Gain → Saturación → EQ → Compresor → Limiter

    Se ejecuta en el AudioWorklet (tiempo real) y en el worker de exportación,
    así que no usa nada del DOM ni reserva memoria en process().
*/
import { EFFECT_DEFS, type EffectsState } from './effectDefs.ts';
import { decibelsToGain } from '../core/range.ts';

/** Rampa lineal de un valor (juce::SmoothedValue). */
export class SmoothedValue {
  private current = 0;
  private target = 0;
  private step = 0;
  private countdown = 0;
  private stepsToTarget = 0;

  reset(sampleRate: number, rampSeconds: number): void {
    this.stepsToTarget = Math.floor(rampSeconds * sampleRate);
    this.setCurrentAndTargetValue(this.target);
  }

  setCurrentAndTargetValue(value: number): void {
    this.current = this.target = value;
    this.countdown = 0;
  }

  setTargetValue(value: number): void {
    if (value === this.target)
      return;

    if (this.stepsToTarget <= 0) {
      this.setCurrentAndTargetValue(value);
      return;
    }

    this.target = value;
    this.countdown = this.stepsToTarget;
    this.step = (this.target - this.current) / this.countdown;
  }

  getNextValue(): number {
    if (this.countdown <= 0)
      return this.target;

    --this.countdown;

    if (this.countdown > 0)
      this.current += this.step;
    else
      this.current = this.target;

    return this.current;
  }

  isSmoothing(): boolean {
    return this.countdown > 0;
  }

  getTargetValue(): number {
    return this.target;
  }
}

/** Filtro biquad (transposed direct form II) para un canal. */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  z1 = 0; z2 = 0;

  /** Recibe [b0, b1, b2, a0, a1, a2] y normaliza por a0. */
  setCoefficients(c: readonly number[]): void {
    const a0Inverse = 1 / c[3];
    this.b0 = c[0] * a0Inverse;
    this.b1 = c[1] * a0Inverse;
    this.b2 = c[2] * a0Inverse;
    this.a1 = c[4] * a0Inverse;
    this.a2 = c[5] * a0Inverse;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = this.z2 = 0;
  }
}

// Coeficientes de juce::dsp::IIR::ArrayCoefficients.
function makeLowShelf(sampleRate: number, cutoff: number, q: number, gainFactor: number): number[] {
  const A = Math.sqrt(Math.max(0, gainFactor));
  const aminus1 = A - 1, aplus1 = A + 1;
  const omega = (2 * Math.PI * Math.max(cutoff, 2)) / sampleRate;
  const coso = Math.cos(omega);
  const beta = (Math.sin(omega) * Math.sqrt(A)) / q;
  const aminus1TimesCoso = aminus1 * coso;

  return [A * (aplus1 - aminus1TimesCoso + beta), A * 2 * (aminus1 - aplus1 * coso), A * (aplus1 - aminus1TimesCoso - beta),
          aplus1 + aminus1TimesCoso + beta, -2 * (aminus1 + aplus1 * coso), aplus1 + aminus1TimesCoso - beta];
}

function makeHighShelf(sampleRate: number, cutoff: number, q: number, gainFactor: number): number[] {
  const A = Math.sqrt(Math.max(0, gainFactor));
  const aminus1 = A - 1, aplus1 = A + 1;
  const omega = (2 * Math.PI * Math.max(cutoff, 2)) / sampleRate;
  const coso = Math.cos(omega);
  const beta = (Math.sin(omega) * Math.sqrt(A)) / q;
  const aminus1TimesCoso = aminus1 * coso;

  return [A * (aplus1 + aminus1TimesCoso + beta), A * -2 * (aminus1 + aplus1 * coso), A * (aplus1 + aminus1TimesCoso - beta),
          aplus1 - aminus1TimesCoso + beta, 2 * (aminus1 - aplus1 * coso), aplus1 - aminus1TimesCoso - beta];
}

function makePeakFilter(sampleRate: number, frequency: number, q: number, gainFactor: number): number[] {
  const A = Math.sqrt(Math.max(0, gainFactor));
  const omega = (2 * Math.PI * Math.max(frequency, 2)) / sampleRate;
  const alpha = Math.sin(omega) / (q * 2);
  const c2 = -2 * Math.cos(omega);
  const alphaTimesA = alpha * A;
  const alphaOverA = alpha / A;

  return [1 + alphaTimesA, c2, 1 - alphaTimesA, 1 + alphaOverA, c2, 1 - alphaOverA];
}

//==============================================================================
/** Interfaz común de los efectos. */
export abstract class AudioEffect {
  readonly id: string;
  enabled: boolean;
  readonly params: Record<string, number> = {};

  constructor(id: string) {
    this.id = id;
    const def = EFFECT_DEFS.find(e => e.id === id)!;
    this.enabled = def.enabledByDefault;

    for (const param of def.params)
      this.params[param.id] = param.defaultValue;
  }

  abstract prepare(sampleRate: number): void;
  abstract process(left: Float32Array, right: Float32Array, n: number): void;
  abstract reset(): void;
}

/** Ganancia de entrada de la pista (primer eslabón de la cadena). */
class GainEffect extends AudioEffect {
  private gain = new SmoothedValue();

  constructor() { super('gain'); }

  prepare(sampleRate: number): void {
    this.gain.reset(sampleRate, 0.02);
    this.gain.setCurrentAndTargetValue(decibelsToGain(this.params.gain));
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    this.gain.setTargetValue(decibelsToGain(this.params.gain));

    for (let i = 0; i < n; ++i) {
      const g = this.gain.getNextValue();
      left[i] *= g;
      right[i] *= g;
    }
  }

  reset(): void {
    this.gain.setCurrentAndTargetValue(this.gain.getTargetValue());
  }
}

/**
    Saturación por waveshaping.
      Suave   → tanh: redondea los picos, cálido.
      Dura    → recorte duro: agresivo, tipo fuzz.
      Válvula → tanh asimétrica: añade armónicos pares (con filtro anti-DC).
*/
class SaturationEffect extends AudioEffect {
  private driveGain = new SmoothedValue();
  private mixAmount = new SmoothedValue();
  private outputGain = new SmoothedValue();
  private dcCoefficient = 0.999;
  private dcX1 = [0, 0];
  private dcY1 = [0, 0];

  constructor() { super('saturation'); }

  prepare(sampleRate: number): void {
    for (const smoothed of [this.driveGain, this.mixAmount, this.outputGain])
      smoothed.reset(sampleRate, 0.02);

    this.driveGain.setCurrentAndTargetValue(decibelsToGain(this.params.drive));
    this.mixAmount.setCurrentAndTargetValue(this.params.mix * 0.01);
    this.outputGain.setCurrentAndTargetValue(decibelsToGain(this.params.output));

    // Filtro paso alto de un polo a ~10 Hz para quitar el DC del modo Válvula.
    this.dcCoefficient = Math.exp((-2 * Math.PI * 10) / sampleRate);
    this.reset();
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    this.driveGain.setTargetValue(decibelsToGain(this.params.drive));
    this.mixAmount.setTargetValue(this.params.mix * 0.01);
    this.outputGain.setTargetValue(decibelsToGain(this.params.output));

    const mode = Math.round(this.params.mode);
    const channels = [left, right];

    for (let i = 0; i < n; ++i) {
      const d = this.driveGain.getNextValue();
      const m = this.mixAmount.getNextValue();
      const g = this.outputGain.getNextValue();

      for (let ch = 0; ch < 2; ++ch) {
        const data = channels[ch];
        const dry = data[i];
        let wet = SaturationEffect.shape(dry * d, mode);

        if (mode === 2) {
          const y = wet - this.dcX1[ch] + this.dcCoefficient * this.dcY1[ch];
          this.dcX1[ch] = wet;
          this.dcY1[ch] = y;
          wet = y;
        }

        data[i] = (dry + m * (wet - dry)) * g;
      }
    }
  }

  reset(): void {
    this.dcX1[0] = this.dcX1[1] = this.dcY1[0] = this.dcY1[1] = 0;
  }

  private static shape(x: number, mode: number): number {
    if (mode === 1)
      return x < -1 ? -1 : x > 1 ? 1 : x;

    if (mode === 2) {
      // tanh desplazada: los semiciclos positivos y negativos saturan
      // distinto. Se resta tanh(bias) para que el silencio siga siendo 0.
      const bias = 0.25, tanhOfBias = 0.24491866;
      return Math.tanh(x + bias) - tanhOfBias;
    }

    return Math.tanh(x);
  }
}

/** Ecualizador de 3 bandas: low shelf, campana (peak) y high shelf. */
class EqualizerEffect extends AudioEffect {
  private sampleRate = 44100;
  private filters = [0, 1].map(() => ({ low: new Biquad(), mid: new Biquad(), high: new Biquad() }));
  private lastValues: number[] = [];

  constructor() { super('eq'); }

  prepare(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.updateCoefficients();
    this.reset();
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    const p = this.params;
    const values = [p.lowGain, p.lowFreq, p.midGain, p.midFreq, p.midQ, p.highGain, p.highFreq];

    // Recalcular solo si algún parámetro cambió desde el bloque anterior.
    if (values.some((v, i) => v !== this.lastValues[i]))
      this.updateCoefficients();

    const channels = [left, right];

    for (let ch = 0; ch < 2; ++ch) {
      const data = channels[ch];
      const { low, mid, high } = this.filters[ch];

      for (let i = 0; i < n; ++i)
        data[i] = high.process(mid.process(low.process(data[i])));
    }
  }

  reset(): void {
    for (const f of this.filters) {
      f.low.reset();
      f.mid.reset();
      f.high.reset();
    }
  }

  private updateCoefficients(): void {
    const p = this.params;
    this.lastValues = [p.lowGain, p.lowFreq, p.midGain, p.midFreq, p.midQ, p.highGain, p.highFreq];

    // Mantener las frecuencias por debajo de Nyquist aunque el dispositivo
    // funcione a una frecuencia de muestreo baja.
    const nyquistLimit = this.sampleRate * 0.45;
    const shelfQ = 0.707;

    const low = makeLowShelf(this.sampleRate, Math.min(p.lowFreq, nyquistLimit), shelfQ, decibelsToGain(p.lowGain));
    const mid = makePeakFilter(this.sampleRate, Math.min(p.midFreq, nyquistLimit), p.midQ, decibelsToGain(p.midGain));
    const high = makeHighShelf(this.sampleRate, Math.min(p.highFreq, nyquistLimit), shelfQ, decibelsToGain(p.highGain));

    for (const f of this.filters) {
      f.low.setCoefficients(low);
      f.mid.setCoefficients(mid);
      f.high.setCoefficients(high);
    }
  }
}

/** Compresor (juce::dsp::Compressor: seguidor de picos por canal) con ganancia de compensación. */
class CompressorEffect extends AudioEffect {
  private sampleRate = 44100;
  private threshold = 1;
  private thresholdInverse = 1;
  private ratioInverse = 1;
  private cteAttack = 0;
  private cteRelease = 0;
  private envelope = [0, 0];
  private makeupGain = new SmoothedValue();

  constructor() { super('compressor'); }

  prepare(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.makeupGain.reset(sampleRate, 0.02);
    this.makeupGain.setCurrentAndTargetValue(decibelsToGain(this.params.makeup));
    this.updateSettings();
    this.reset();
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    this.updateSettings();
    const channels = [left, right];

    for (let ch = 0; ch < 2; ++ch) {
      const data = channels[ch];
      let env = this.envelope[ch];

      for (let i = 0; i < n; ++i) {
        const x = data[i];
        const input = Math.abs(x);
        const cte = input > env ? this.cteAttack : this.cteRelease;
        env = input + cte * (env - input);

        const gain = env < this.threshold ? 1 : Math.pow(env * this.thresholdInverse, this.ratioInverse - 1);
        data[i] = gain * x;
      }

      this.envelope[ch] = env;
    }

    for (let i = 0; i < n; ++i) {
      const g = this.makeupGain.getNextValue();
      left[i] *= g;
      right[i] *= g;
    }
  }

  reset(): void {
    this.envelope[0] = this.envelope[1] = 0;
    this.makeupGain.setCurrentAndTargetValue(this.makeupGain.getTargetValue());
  }

  private updateSettings(): void {
    const p = this.params;
    this.threshold = decibelsToGain(p.threshold, -200);
    this.thresholdInverse = 1 / this.threshold;
    this.ratioInverse = 1 / p.ratio;

    const expFactor = (-2 * Math.PI * 1000) / this.sampleRate;
    const cte = (timeMs: number) => (timeMs < 1e-3 ? 0 : Math.exp(expFactor / timeMs));
    this.cteAttack = cte(p.attack);
    this.cteRelease = cte(p.release);
    this.makeupGain.setTargetValue(decibelsToGain(p.makeup));
  }
}

/**
    Limitador de picos con techo garantizado: detección estéreo enlazada,
    ataque instantáneo y release exponencial, sin lookahead.
*/
class LimiterEffect extends AudioEffect {
  private sampleRate = 44100;
  private inputSmoothed = new SmoothedValue();
  private envelope = 1;
  private lastReleaseMs = -1;
  private releaseCoefficient = 0;

  constructor() { super('limiter'); }

  prepare(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.inputSmoothed.reset(sampleRate, 0.02);
    this.inputSmoothed.setCurrentAndTargetValue(decibelsToGain(this.params.input));
    this.lastReleaseMs = -1;
    this.reset();
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    this.inputSmoothed.setTargetValue(decibelsToGain(this.params.input));
    const ceilingGain = decibelsToGain(this.params.ceiling);
    const releaseMs = this.params.release;

    if (releaseMs !== this.lastReleaseMs) {
      this.lastReleaseMs = releaseMs;
      this.releaseCoefficient = Math.exp(-1 / (releaseMs * 0.001 * this.sampleRate));
    }

    for (let i = 0; i < n; ++i) {
      const gainIn = this.inputSmoothed.getNextValue();
      const l = left[i] * gainIn;
      const r = right[i] * gainIn;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      const target = peak > ceilingGain ? ceilingGain / peak : 1;

      // Ataque instantáneo (nunca se supera el techo), release suave.
      this.envelope = target < this.envelope ? target : target + this.releaseCoefficient * (this.envelope - target);

      left[i] = l * this.envelope;
      right[i] = r * this.envelope;
    }
  }

  reset(): void {
    this.envelope = 1;
  }
}

//==============================================================================
/** Cadena de efectos de una pista. Los desactivados no consumen CPU. */
export class EffectChain {
  readonly effects: AudioEffect[] = [
    new GainEffect(), new SaturationEffect(), new EqualizerEffect(), new CompressorEffect(), new LimiterEffect(),
  ];

  // Estado "activo" del bloque anterior: al reactivar un efecto se reinicia
  // para que no arrastre envolventes o filtros de hace minutos.
  private wasEnabled = this.effects.map(() => false);

  prepare(sampleRate: number): void {
    this.effects.forEach((effect, i) => {
      effect.prepare(sampleRate);
      this.wasEnabled[i] = effect.enabled;
    });
  }

  setState(state: EffectsState | undefined): void {
    if (state === undefined)
      return;

    for (const effect of this.effects) {
      const s = state[effect.id];

      if (s === undefined)
        continue;

      effect.enabled = s.enabled;

      for (const key of Object.keys(effect.params))
        if (typeof s.params[key] === 'number')
          effect.params[key] = s.params[key];
    }
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    for (let i = 0; i < this.effects.length; ++i) {
      const effect = this.effects[i];
      const enabled = effect.enabled;

      if (enabled && !this.wasEnabled[i])
        effect.reset();

      this.wasEnabled[i] = enabled;

      if (enabled)
        effect.process(left, right, n);
    }
  }

  reset(): void {
    for (const effect of this.effects)
      effect.reset();
  }
}
