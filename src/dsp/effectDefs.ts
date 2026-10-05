/**
    Definición de los efectos y de sus parámetros. La comparten el motor de
    audio (AudioWorklet y exportación) y la interfaz: un efecto nuevo aparece en
    el mezclador sin escribir UI específica.

    Cadena fija:  Gain → Saturación → EQ → Compresor → Limiter
*/
import { msg } from '../core/i18n.ts';

// Los nombres van en español (msg): la interfaz los traduce al mostrarlos.
export type ParamKind = 'continuous' | 'toggle' | 'choice';

export interface ParamDef {
  id: string;
  name: string;
  kind: ParamKind;
  min: number;
  max: number;
  interval: number;
  skew?: number;          // curva del control (1 = lineal)
  centre?: number;        // alternativa a skew: valor en la mitad del control
  defaultValue: number;
  unit?: string;
  choices?: string[];
}

export interface EffectDef {
  id: string;
  name: string;
  enabledByDefault: boolean;
  params: ParamDef[];
}

const continuous = (id: string, name: string, min: number, max: number, interval: number,
                    defaultValue: number, unit = '', skew = 1): ParamDef =>
  ({ id, name, kind: 'continuous', min, max, interval, skew, defaultValue, unit });

/** Rango de frecuencias con el centro geométrico en la mitad del control. */
const frequency = (id: string, name: string, min: number, max: number, defaultValue: number): ParamDef =>
  ({ id, name, kind: 'continuous', min, max, interval: 1, centre: Math.sqrt(min * max), defaultValue, unit: 'Hz' });

const eqGain = (id: string, name: string) => continuous(id, name, -18, 18, 0.1, 0, 'dB');

export const EFFECT_DEFS: EffectDef[] = [
  {
    id: 'gain', name: 'Gain', enabledByDefault: true,
    params: [continuous('gain', msg('Ganancia'), -24, 24, 0.1, 0, 'dB')],
  },
  {
    id: 'saturation', name: msg('Saturación'), enabledByDefault: false,
    params: [
      continuous('drive', 'Drive', 0, 24, 0.1, 6, 'dB'),
      { id: 'mode', name: msg('Tipo'), kind: 'choice', min: 0, max: 2, interval: 1, defaultValue: 0,
        choices: [msg('Suave'), msg('Dura'), msg('Válvula')] },
      continuous('mix', msg('Mezcla'), 0, 100, 1, 100, '%'),
      continuous('output', msg('Salida'), -24, 12, 0.1, 0, 'dB'),
    ],
  },
  {
    id: 'eq', name: 'EQ', enabledByDefault: false,
    params: [
      eqGain('lowGain', msg('Graves')),
      frequency('lowFreq', msg('Frec. G'), 20, 1000, 120),
      eqGain('midGain', msg('Medios')),
      frequency('midFreq', msg('Frec. M'), 100, 10000, 1000),
      continuous('midQ', 'Q', 0.2, 10, 0.01, 0.7, '', 0.4),
      eqGain('highGain', msg('Agudos')),
      frequency('highFreq', msg('Frec. A'), 1000, 20000, 8000),
    ],
  },
  {
    id: 'compressor', name: msg('Compresor'), enabledByDefault: false,
    params: [
      continuous('threshold', msg('Umbral'), -60, 0, 0.1, -18, 'dB'),
      continuous('ratio', 'Ratio', 1, 20, 0.1, 4, ':1', 0.5),
      continuous('attack', msg('Ataque'), 0.1, 200, 0.1, 10, 'ms', 0.4),
      continuous('release', 'Release', 5, 1000, 1, 120, 'ms', 0.4),
      continuous('makeup', 'Makeup', 0, 24, 0.1, 0, 'dB'),
    ],
  },
  {
    id: 'limiter', name: 'Limiter', enabledByDefault: false,
    params: [
      continuous('input', msg('Entrada'), 0, 24, 0.1, 0, 'dB'),
      continuous('ceiling', msg('Techo'), -12, 0, 0.1, -1, 'dB'),
      continuous('release', 'Release', 1, 500, 1, 60, 'ms', 0.4),
    ],
  },
];

/** Estado de los efectos que recibe el motor: { gain: { enabled, params: { gain: 0 } }, ... } */
export type EffectsState = Record<string, { enabled: boolean; params: Record<string, number> }>;

export function defaultEffectsState(): EffectsState {
  const state: EffectsState = {};

  for (const effect of EFFECT_DEFS) {
    const params: Record<string, number> = {};

    for (const param of effect.params)
      params[param.id] = param.defaultValue;

    state[effect.id] = { enabled: effect.enabledByDefault, params };
  }

  return state;
}
