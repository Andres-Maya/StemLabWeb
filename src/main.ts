import './styles.css';
import { App } from './app.ts';

const root = document.getElementById('app')!;
const app = new App(root);

// Para depurar desde la consola del navegador.
(window as unknown as { stemlab: App }).stemlab = app;
