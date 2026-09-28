import { defineConfig } from 'vite';

// SharedArrayBuffer (el audio se comparte sin copiar entre la página, el
// AudioWorklet y el worker de exportación) exige aislamiento de origen.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: {
    port: 5173,
    headers: isolation,
    // La separación por IA la hace el servidor de Python (server/stemlab_server.py).
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  preview: {
    headers: isolation,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
