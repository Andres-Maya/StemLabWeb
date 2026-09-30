/**
    Decodifica un archivo de audio a la frecuencia del motor (el navegador
    remuestrea al decodificar) y lo convierte en un ClipSource estéreo.
*/
import { createSource, type ClipSource } from '../model/clip.ts';
import { toSharedFloat32 } from './memory.ts';
import { encodeWav } from './wav.ts';

const audioFileExtensions = ['wav', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'webm', 'weba', 'mp4'];

export function isAudioFile(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return file.type.startsWith('audio/') || audioFileExtensions.includes(extension);
}

export function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export async function decodeAudio(context: BaseAudioContext, blob: Blob, name: string): Promise<ClipSource> {
  const bytes = await blob.arrayBuffer();
  let decoded: AudioBuffer;

  try {
    decoded = await context.decodeAudioData(bytes);
  } catch {
    throw new Error('Formato de audio no soportado por este navegador.');
  }

  if (decoded.length === 0)
    throw new Error('El archivo está vacío.');

  // Un archivo mono suena igual por los dos canales (se comparte el array).
  const left = toSharedFloat32(decoded.getChannelData(0));
  const right = decoded.numberOfChannels > 1 ? toSharedFloat32(decoded.getChannelData(1)) : left;

  return createSource(name, left, right, decoded.sampleRate, blob);
}

/** Archivo del audio (el original o, en las grabaciones, un WAV de 24 bits). */
export function sourceBlob(source: ClipSource): Blob {
  if (source.blob === null) {
    const channels = source.left === source.right ? [source.left] : [source.left, source.right];
    source.blob = encodeWav(channels, source.sampleRate, 24);
  }

  return source.blob;
}

export function sourceFileName(source: ClipSource): string {
  const blob = sourceBlob(source);
  const extension = blob instanceof File ? blob.name.split('.').pop() ?? 'wav'
                  : blob.type.includes('flac') ? 'flac' : 'wav';
  return safeFileName(source.name) + '.' + extension;
}

/** Nombre válido para un archivo descargado. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? 'audio' : cleaned.slice(0, 120);
}
