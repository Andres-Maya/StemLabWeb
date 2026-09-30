import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// SharedArrayBuffer (el audio se comparte sin copiar entre la página, el
// AudioWorklet y el worker de exportación) exige aislamiento de origen.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// La separación por IA la hace el servidor de Python (server/stemlab_server.py).
const api = { '/api': 'http://127.0.0.1:8000' };

// La versión de "Acerca de" sale de package.json (no se repite en el código).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 5173, headers: isolation, proxy: api },
  preview: { headers: isolation, proxy: api },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
