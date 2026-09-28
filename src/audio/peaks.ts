/**
    Resumen min/max del audio para dibujar las formas de onda sin recorrer
    todas las muestras (como juce::AudioThumbnail). Varios niveles: cada uno
    agrupa 4 veces más muestras que el anterior.
*/
export interface PeakLevel {
  binSize: number;
  min: [Float32Array, Float32Array];
  max: [Float32Array, Float32Array];
}

export interface WaveformPeaks {
  levels: PeakLevel[];
  maxPeak: number;
}

const firstBinSize = 256;

export function computePeaks(left: Float32Array, right: Float32Array): WaveformPeaks {
  const length = left.length;
  const bins = Math.ceil(length / firstBinSize);
  const first: PeakLevel = {
    binSize: firstBinSize,
    min: [new Float32Array(bins), new Float32Array(bins)],
    max: [new Float32Array(bins), new Float32Array(bins)],
  };
  let maxPeak = 0;

  [left, right].forEach((data, ch) => {
    for (let b = 0; b < bins; ++b) {
      let lo = 0, hi = 0;
      const end = Math.min(length, (b + 1) * firstBinSize);

      for (let i = b * firstBinSize; i < end; ++i) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }

      first.min[ch][b] = lo;
      first.max[ch][b] = hi;
      maxPeak = Math.max(maxPeak, hi, -lo);
    }
  });

  const levels = [first];

  while (levels[levels.length - 1].min[0].length > 256) {
    const previous = levels[levels.length - 1];
    const count = Math.ceil(previous.min[0].length / 4);
    const level: PeakLevel = {
      binSize: previous.binSize * 4,
      min: [new Float32Array(count), new Float32Array(count)],
      max: [new Float32Array(count), new Float32Array(count)],
    };

    for (let ch = 0; ch < 2; ++ch) {
      for (let b = 0; b < count; ++b) {
        let lo = 0, hi = 0;

        for (let j = b * 4; j < Math.min(previous.min[ch].length, b * 4 + 4); ++j) {
          lo = Math.min(lo, previous.min[ch][j]);
          hi = Math.max(hi, previous.max[ch][j]);
        }

        level.min[ch][b] = lo;
        level.max[ch][b] = hi;
      }
    }

    levels.push(level);
  }

  return { levels, maxPeak };
}

/** Mínimo y máximo de un canal en [from, to) (muestras). */
export function rangeOf(peaks: WaveformPeaks, samples: Float32Array, channel: number,
                        from: number, to: number): [number, number] {
  from = Math.max(0, Math.floor(from));
  to = Math.min(samples.length, Math.ceil(to));

  if (to <= from)
    return [0, 0];

  const span = to - from;

  // Pocos datos: se leen las muestras directamente.
  if (span <= firstBinSize * 2) {
    let lo = 0, hi = 0;

    for (let i = from; i < to; ++i) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }

    return [lo, hi];
  }

  // El nivel más grueso cuyos bins caben al menos dos veces en el tramo.
  let level = peaks.levels[0];

  for (const candidate of peaks.levels)
    if (candidate.binSize * 2 <= span)
      level = candidate;

  const first = Math.floor(from / level.binSize);
  const last = Math.min(level.min[channel].length, Math.ceil(to / level.binSize));
  let lo = 0, hi = 0;

  for (let b = first; b < last; ++b) {
    lo = Math.min(lo, level.min[channel][b]);
    hi = Math.max(hi, level.max[channel][b]);
  }

  return [lo, hi];
}
