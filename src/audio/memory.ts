/**
    Con aislamiento de origen (COOP/COEP) el audio vive en SharedArrayBuffer:
    la página, el AudioWorklet y el worker de exportación lo leen sin copiarlo.
    Sin aislamiento se usa memoria normal y cada uno recibe una copia.
*/
export const canShareMemory = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;

export function allocFloat32(length: number): Float32Array {
  return canShareMemory ? new Float32Array(new SharedArrayBuffer(length * 4)) : new Float32Array(length);
}

export function toSharedFloat32(data: Float32Array): Float32Array {
  const copy = allocFloat32(data.length);
  copy.set(data);
  return copy;
}
