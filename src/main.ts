import './styles.css';
import { App } from './app.ts';
import { getLanguage, initLanguage } from './core/i18n.ts';
import { initTheme } from './ui/theme.ts';

// Antes de crear la interfaz: se construye ya con el idioma y el tema elegidos.
initLanguage();
initTheme();
document.documentElement.lang = getLanguage();

const root = document.getElementById('app')!;
const app = new App(root);

// Para depurar desde la consola del navegador.
(window as unknown as { stemlab: App }).stemlab = app;
