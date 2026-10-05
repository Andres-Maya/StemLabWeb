/** Mensajes · progreso de la IA con "Ver progreso" y "Cancelar" · aviso de que nada se guarda en la nube. */
import type { SeparationManager } from '../ai/separator.ts';
import { L, tr } from '../core/i18n.ts';
import type { ProjectManager } from '../model/project.ts';
import { h, ticker } from './dom.ts';

export class StatusBar {
  readonly element = h('footer', { className: 'status-bar' });
  onCancel: () => void = () => undefined;
  onShowSeparation: () => void = () => undefined;

  private ai: SeparationManager;
  private projects: ProjectManager;
  private message = tr('Listo.');
  private messageLabel = h('div', { className: 'status-message', role: 'status' });
  private sessionLabel = h('div', { className: 'status-session',
    text: L('Sesión en este navegador: nada se guarda en la nube, descarga lo que quieras conservar.') });
  private progress = h('div', { className: 'status-progress' }, h('div', { className: 'status-progress-bar' }));
  private showButton = h('button', { className: 'text-button', type: 'button', text: L('Ver progreso') });
  private cancelButton = h('button', { className: 'text-button', type: 'button', text: L('Cancelar') });

  constructor(ai: SeparationManager, projects: ProjectManager) {
    this.ai = ai;
    this.projects = projects;
    this.showButton.addEventListener('click', () => this.onShowSeparation());
    this.cancelButton.addEventListener('click', () => this.onCancel());
    this.element.append(this.messageLabel, this.sessionLabel, this.progress, this.showButton, this.cancelButton);
    ticker.add(this, null, () => this.update());
    this.update();
  }

  setMessage(message: string): void {
    this.message = message;
    this.update();
  }

  private update(): void {
    const busy = this.ai.isBusy();
    const loading = this.projects.isLoading();
    let text = this.message;

    if (busy) {
      // El progreso de la IA se ve en su propia pantalla (animación); aquí,
      // solo el texto con el porcentaje.
      const value = this.ai.getProgress();
      text = this.ai.getStatus() + (value >= 0 ? `  ·  ${Math.round(value * 100)} %` : '');
    } else if (loading) {
      text = tr('Cargando audio...');
    }

    if (this.messageLabel.textContent !== text) {
      this.messageLabel.textContent = text;
      this.messageLabel.title = text;
    }

    this.progress.style.display = loading && !busy ? 'block' : 'none';
    this.showButton.style.display = busy ? '' : 'none';
    this.cancelButton.style.display = busy ? '' : 'none';
  }
}
