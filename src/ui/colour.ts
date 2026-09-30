/** Color con las mismas operaciones que juce::Colour (brighter, darker, withAlpha...). */
export class Colour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;

  constructor(r: number, g: number, b: number, a = 1) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }

  static hex(hex: string): Colour {
    const value = parseInt(hex.replace('#', ''), 16);
    return new Colour((value >> 16) & 255, (value >> 8) & 255, value & 255);
  }

  withAlpha(a: number): Colour {
    return new Colour(this.r, this.g, this.b, Math.min(1, Math.max(0, a)));
  }

  brighter(amount = 0.4): Colour {
    const k = 1 / (1 + amount);
    return new Colour(255 - k * (255 - this.r), 255 - k * (255 - this.g), 255 - k * (255 - this.b), this.a);
  }

  darker(amount = 0.4): Colour {
    const k = 1 / (1 + amount);
    return new Colour(this.r * k, this.g * k, this.b * k, this.a);
  }

  interpolatedWith(other: Colour, proportion: number): Colour {
    const p = Math.min(1, Math.max(0, proportion));
    const mix = (x: number, y: number) => x + (y - x) * p;
    return new Colour(mix(this.r, other.r), mix(this.g, other.g), mix(this.b, other.b), mix(this.a, other.a));
  }

  isTransparent(): boolean {
    return this.a <= 0;
  }

  equals(other: Colour): boolean {
    return this.r === other.r && this.g === other.g && this.b === other.b && this.a === other.a;
  }

  toString(): string {
    return `rgba(${Math.round(this.r)}, ${Math.round(this.g)}, ${Math.round(this.b)}, ${+this.a.toFixed(3)})`;
  }
}

export const Palette = {
  background: Colour.hex('#121419'),
  panel: Colour.hex('#1b1e25'),
  panelLight: Colour.hex('#252932'),
  outline: Colour.hex('#343945'),
  text: Colour.hex('#e4e6eb'),
  textDim: Colour.hex('#8b919c'),
  accent: Colour.hex('#4fc3f7'),
  mute: Colour.hex('#f0b429'),
  solo: Colour.hex('#5ccb7a'),
  record: Colour.hex('#e5484d'),
  white: new Colour(255, 255, 255),
  black: new Colour(0, 0, 0),
  transparent: new Colour(0, 0, 0, 0),
};

const named: [string, string][] = [
  ['Voz', '#ff6b9d'],
  ['Batería', '#ffa94d'],
  ['Bajo', '#b197fc'],
  ['Guitarra', '#ff6b6b'],
  ['Piano', '#ffd43b'],
  ['Otros', '#38d9a9'],
  ['Grabación', '#748ffc'],     // índigo: el rojo queda solo para "grabando"
];

const fallback = ['#4fc3f7', '#94d82d', '#f783ac', '#74c0fc', '#ffc078', '#63e6be'];

/** Color de una pista según su nombre (stems conocidos) o su posición. */
export function trackColourFor(trackName: string, index: number): Colour {
  for (const [keyword, hex] of named)
    if (trackName.startsWith(keyword))
      return Colour.hex(hex);

  return Colour.hex(fallback[Math.max(0, index) % fallback.length]);
}
