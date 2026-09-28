/** Codifica audio en WAV: PCM de 16 o 24 bits, o 32 bits en coma flotante. */
export type WavFormat = 16 | 24 | 32;

export function wavHeader(numChannels: number, sampleRate: number, bits: WavFormat, numFrames: number): ArrayBuffer {
  const bytesPerSample = bits / 8;
  const dataSize = numFrames * numChannels * bytesPerSample;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; ++i)
      view.setUint8(offset + i, value.charCodeAt(i));
  };

  text(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bits === 32 ? 3 : 1, true);           // 3 = IEEE float, 1 = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bits, true);
  text(36, 'data');
  view.setUint32(40, dataSize, true);
  return header;
}

/** Muestras intercaladas de un bloque, ya convertidas al formato. */
export function encodeWavFrames(channels: readonly Float32Array[], start: number, count: number, bits: WavFormat): ArrayBuffer {
  const numChannels = channels.length;
  const bytesPerSample = bits / 8;
  const buffer = new ArrayBuffer(count * numChannels * bytesPerSample);
  const view = new DataView(buffer);
  let offset = 0;

  for (let i = 0; i < count; ++i) {
    for (let ch = 0; ch < numChannels; ++ch) {
      const sample = channels[ch][start + i];

      if (bits === 32) {
        view.setFloat32(offset, sample, true);
      } else {
        const clipped = sample < -1 ? -1 : sample > 1 ? 1 : sample;

        if (bits === 16) {
          view.setInt16(offset, Math.round(clipped * 32767), true);
        } else {
          const value = Math.round(clipped * 8388607);
          view.setUint8(offset, value & 0xff);
          view.setUint8(offset + 1, (value >> 8) & 0xff);
          view.setUint8(offset + 2, (value >> 16) & 0xff);
        }
      }

      offset += bytesPerSample;
    }
  }

  return buffer;
}

export function encodeWav(channels: readonly Float32Array[], sampleRate: number, bits: WavFormat): Blob {
  const numFrames = channels[0]?.length ?? 0;
  const parts: BlobPart[] = [wavHeader(channels.length, sampleRate, bits, numFrames)];
  const block = 65536;

  for (let start = 0; start < numFrames; start += block)
    parts.push(encodeWavFrames(channels, start, Math.min(block, numFrames - start), bits));

  return new Blob(parts, { type: 'audio/wav' });
}
