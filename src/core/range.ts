/**
    Rango de un parámetro con paso y curva (como juce::NormalisableRange):
    los controles trabajan en 0..1 y el parámetro guarda el valor real.
*/
export class NormalisableRange {
  readonly start: number;
  readonly end: number;
  readonly interval: number;
  readonly skew: number;

  constructor(start: number, end: number, interval = 0, skew = 1) {
    this.start = start;
    this.end = end;
    this.interval = interval;
    this.skew = skew;
  }

  /** Rango con el valor `centre` en la mitad del control. */
  static withCentre(start: number, end: number, interval: number, centre: number): NormalisableRange {
    const skew = Math.log(0.5) / Math.log((centre - start) / (end - start));
    return new NormalisableRange(start, end, interval, skew);
  }

  convertTo0to1(value: number): number {
    const proportion = clamp01((value - this.start) / (this.end - this.start));
    return this.skew === 1 ? proportion : Math.pow(proportion, this.skew);
  }

  convertFrom0to1(proportion: number): number {
    let p = clamp01(proportion);

    if (this.skew !== 1 && p > 0)
      p = Math.exp(Math.log(p) / this.skew);

    return this.start + (this.end - this.start) * p;
  }

  snapToLegalValue(value: number): number {
    if (this.interval > 0)
      value = this.start + this.interval * Math.round((value - this.start) / this.interval);

    return Math.min(this.end, Math.max(this.start, value));
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function decibelsToGain(db: number, minusInfinityDb = -100): number {
  return db > minusInfinityDb ? Math.pow(10, db * 0.05) : 0;
}

export function gainToDecibels(gain: number, minusInfinityDb = -100): number {
  return gain > 0 ? Math.max(minusInfinityDb, 20 * Math.log10(gain)) : minusInfinityDb;
}
