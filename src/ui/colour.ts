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

export type Theme = 'dark' | 'light';

/** Los mismos colores que las variables de styles.css (lo que se pinta en
    lienzos no puede leerlas). El rojo de grabar no cambia con el tema. */
const themeColours = {
  dark: {
    background: Colour.hex('#121419'),
    panel: Colour.hex('#1b1e25'),
    panelLight: Colour.hex('#252932'),
    outline: Colour.hex('#343945'),
    text: Colour.hex('#e4e6eb'),
    textDim: Colour.hex('#8b919c'),
    accent: Colour.hex('#4fc3f7'),
    mute: Colour.hex('#f0b429'),
    solo: Colour.hex('#5ccb7a'),
  },
  // Claro pero sin blancos puros, y con los colores más oscuros que en el
  // tema oscuro: sobre un fondo claro, los tonos vivos distraen.
  light: {
    background: Colour.hex('#e8ebf0'),
    panel: Colour.hex('#f4f5f8'),
    panelLight: Colour.hex('#dbe0e8'),
    outline: Colour.hex('#b9c1ce'),
    text: Colour.hex('#1b1f27'),
    textDim: Colour.hex('#566070'),
    accent: Colour.hex('#0a6aa6'),
    mute: Colour.hex('#c48a0a'),
    solo: Colour.hex('#3a9d5b'),
  },
};

const fixedColours = {
  record: Colour.hex('#e5484d'),
  white: new Colour(255, 255, 255),
  black: new Colour(0, 0, 0),
  transparent: new Colour(0, 0, 0, 0),
};

/** El tema oscuro, siempre: la pantalla de ondas de la separación no cambia. */
export const DarkPalette = { ...themeColours.dark, ...fixedColours } as const;

/** Colores del tema actual (cambian con setPaletteTheme). */
export const Palette = { ...themeColours.dark, ...fixedColours };

let paletteTheme: Theme = 'dark';
let paletteVersion = 0;

export function setPaletteTheme(theme: Theme): void {
  paletteTheme = theme;
  Object.assign(Palette, themeColours[theme]);
  ++paletteVersion;
}

/** Cambia cada vez que cambia el tema: los lienzos que solo se repintan
    cuando cambian sus datos lo comparan para saber si deben repintarse. */
export function getPaletteVersion(): number {
  return paletteVersion;
}

/** El color de una pista tal como se pinta sobre el fondo del tema: los tonos
    pastel del tema oscuro apenas se ven sobre un fondo claro, así que se oscurecen. */
export function onBackground(colour: Colour): Colour {
  return paletteTheme === 'light' && !colour.isTransparent() ? colour.darker(0.75) : colour;
}

// Con el nombre en cualquier idioma de la interfaz (ver core/i18n.ts).
const named: [string[], string][] = [
  [['Voz', 'Vocals'], '#ff6b9d'],
  [['Batería', 'Drums'], '#ffa94d'],
  [['Bajo', 'Bass'], '#b197fc'],
  [['Guitarra', 'Guitar'], '#ff6b6b'],
  [['Piano'], '#ffd43b'],
  [['Otros', 'Other'], '#38d9a9'],
  [['Grabación', 'Recording'], '#748ffc'],     // índigo: el rojo queda solo para "grabando"
];

const fallback = ['#4fc3f7', '#94d82d', '#f783ac', '#74c0fc', '#ffc078', '#63e6be'];

/** Color de una pista según su nombre (stems conocidos) o su posición. */
export function trackColourFor(trackName: string, index: number): Colour {
  for (const [keywords, hex] of named)
    if (keywords.some(keyword => trackName.startsWith(keyword)))
      return Colour.hex(hex);

  return Colour.hex(fallback[Math.max(0, index) % fallback.length]);
}
