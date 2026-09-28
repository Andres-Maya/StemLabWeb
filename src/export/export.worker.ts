/**
    Exportación fuera de tiempo real (Web Worker): renderiza una copia de la
    mezcla con el mismo MixerCore que suena en el AudioWorklet, así que el
    archivo refleja exactamente lo que se oye. Nunca toca el motor de audio: se
    puede seguir escuchando o editando mientras exporta.
*/
import { Mp3Encoder } from '@breezystack/lamejs';
import { zipSync } from 'fflate';
import { MixerCore, type SourceData } from '../dsp/mixerCore.ts';
import { encodeWavFrames, wavHeader, type WavFormat } from '../audio/wav.ts';
import { fileExtension, mp3SampleRate, type ExportJob, type ExportRequest, type ExportResult,
         type FromExportWorker, type ToExportWorker } from './exportTypes.ts';

const renderBlockSize = 1024;
let cancelled = false;

const post = (message: FromExportWorker) => (self as unknown as Worker).postMessage(message);
const yieldToMessages = () => new Promise<void>(resolve => setTimeout(resolve, 0));

self.onmessage = (event: MessageEvent<ToExportWorker>) => {
  if (event.data.type === 'cancel') {
    cancelled = true;
    return;
  }

  cancelled = false;
  void run(event.data.request);
};

class Cancelled extends Error {}

/** Ruido triangular de ±1 bit menos significativo: al reducir a 16 bits, el
    error de cuantización se convierte en un siseo muy bajo en vez de
    distorsión en los pasajes suaves y las colas. */
class Dither {
  private seed = 0x5713;

  private next(): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return this.seed / 4294967296;
  }

  apply(data: Float32Array, n: number): void {
    const lsb = 1 / 32768;

    for (let i = 0; i < n; ++i)
      data[i] += (this.next() - this.next()) * lsb;
  }
}

function toInt16(data: Float32Array, n: number): Int16Array {
  const out = new Int16Array(n);

  for (let i = 0; i < n; ++i) {
    const s = data[i] < -1 ? -1 : data[i] > 1 ? 1 : data[i];
    out[i] = Math.round(s * 32767);
  }

  return out;
}

/** Remuestreo lineal (solo para MP3 por encima de 48 kHz). */
function resample(data: Float32Array, ratio: number): Float32Array {
  const length = Math.ceil(data.length / ratio);
  const out = new Float32Array(length);

  for (let i = 0; i < length; ++i) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = data[index] ?? 0;
    const b = data[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }

  return out;
}

interface Rendered {
  parts: BlobPart[];
  peak: number;
}

async function renderJob(request: ExportRequest, job: ExportJob, sources: Map<number, SourceData>,
                         progress: (value: number) => void): Promise<Rendered> {
  const { sampleRate, format } = request;
  const core = new MixerCore();
  core.masterVolume = request.masterVolume;
  core.prepare(sampleRate, renderBlockSize);

  for (const [id, data] of sources)
    core.sources.set(id, data);

  core.setTracks(job.tracks);

  const left = new Float32Array(renderBlockSize);
  const right = new Float32Array(renderBlockSize);

  // Precalentamiento en silencio (antes del 0): las rampas de volumen de las
  // pistas parten de 0 y así llegan a su valor antes de la primera muestra.
  const preRoll = Math.round(0.05 * sampleRate);

  for (let done = 0; done < preRoll;) {
    const count = Math.min(renderBlockSize, preRoll - done);
    core.render(left, right, count, done - preRoll, true);
    done += count;
  }

  const total = job.length;
  const dither = new Dither();
  const parts: BlobPart[] = [];
  const outputRate = format === 'mp3' ? mp3SampleRate(sampleRate) : sampleRate;
  const needsResampling = outputRate !== sampleRate;
  const encoder = format === 'mp3' ? new Mp3Encoder(2, outputRate, request.mp3Bitrate) : null;
  const bits: WavFormat = format === 'wav16' ? 16 : format === 'wav24' ? 24 : 32;
  const fullLeft = needsResampling ? new Float32Array(total) : null;
  const fullRight = needsResampling ? new Float32Array(total) : null;
  let peak = 0;
  let lastYield = performance.now();

  if (encoder === null)
    parts.push(wavHeader(2, sampleRate, bits, total));

  for (let written = 0; written < total;) {
    const count = Math.min(renderBlockSize, total - written);
    core.render(left, right, count, written, true);

    for (let i = 0; i < count; ++i)
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));

    if (fullLeft !== null && fullRight !== null) {
      fullLeft.set(left.subarray(0, count), written);
      fullRight.set(right.subarray(0, count), written);
    } else if (encoder !== null) {
      dither.apply(left, count);
      dither.apply(right, count);
      const mp3 = encoder.encodeBuffer(toInt16(left, count), toInt16(right, count));

      if (mp3.length > 0)
        parts.push(new Uint8Array(mp3));
    } else {
      if (bits === 16) {
        dither.apply(left, count);
        dither.apply(right, count);
      }

      parts.push(encodeWavFrames([left, right], 0, count, bits));
    }

    written += count;

    if (performance.now() - lastYield > 50) {
      progress(written / total);
      await yieldToMessages();
      lastYield = performance.now();

      if (cancelled)
        throw new Cancelled();
    }
  }

  if (encoder !== null && fullLeft !== null && fullRight !== null) {
    const ratio = sampleRate / outputRate;
    const l = resample(fullLeft, ratio);
    const r = resample(fullRight, ratio);
    dither.apply(l, l.length);
    dither.apply(r, r.length);

    for (let i = 0; i < l.length; i += 1152 * 16) {
      const n = Math.min(1152 * 16, l.length - i);
      const mp3 = encoder.encodeBuffer(toInt16(l.subarray(i, i + n), n), toInt16(r.subarray(i, i + n), n));

      if (mp3.length > 0)
        parts.push(new Uint8Array(mp3));
    }
  }

  if (encoder !== null) {
    const tail = encoder.flush();

    if (tail.length > 0)
      parts.push(new Uint8Array(tail));
  }

  progress(1);
  return { parts, peak };
}

async function run(request: ExportRequest): Promise<void> {
  const extension = fileExtension(request.format);
  const mime = request.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  const sources = new Map(request.sources);
  const seconds = Math.max(0, ...request.jobs.map(j => j.length)) / request.sampleRate;
  const result: ExportResult = { ok: false, cancelled: false, error: '', blob: null, fileName: '', peak: 0, clipped: false, seconds };

  try {
    if (request.jobs.length === 0 || request.jobs.every(j => j.length <= 0))
      throw new Error('No hay nada que exportar: el proyecto no tiene audio.');

    const files: { name: string; blob: Blob }[] = [];
    const count = request.jobs.length;

    for (let i = 0; i < count; ++i) {
      const job = request.jobs[i];
      const rendered = await renderJob(request, job, sources, value => post({ type: 'progress', value: (i + value) / count }));
      result.peak = Math.max(result.peak, rendered.peak);
      files.push({ name: job.name + extension, blob: new Blob(rendered.parts, { type: mime }) });
    }

    if (request.zipName === '') {
      result.blob = files[0].blob;
      result.fileName = files[0].name;
    } else {
      const entries: Record<string, Uint8Array> = {};

      for (const file of files) {
        let name = file.name;

        for (let n = 2; name in entries; ++n)
          name = file.name.replace(extension, ` (${n})${extension}`);

        entries[name] = new Uint8Array(await file.blob.arrayBuffer());
      }

      // Sin compresión: el audio ya está comprimido (MP3) o apenas se comprime (WAV).
      result.blob = new Blob([zipSync(entries, { level: 0 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
      result.fileName = request.zipName + '.zip';
    }

    result.ok = true;
    result.clipped = result.peak > 1 && request.format !== 'wav32';
  } catch (error) {
    if (error instanceof Cancelled) {
      result.cancelled = true;
      result.error = 'Exportación cancelada.';
    } else {
      result.error = error instanceof Error ? error.message : String(error);
    }
  }

  post({ type: 'done', result });
}
