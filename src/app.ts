/**
    Ventana principal tipo DAW:

        MENÚ        Archivo | Editar | Proyecto | Audio | IA | Ayuda
        TRANSPORTE  ⏮ ▶ ⏹ ⏺ · tiempo · BPM · entrada · master
        PISTAS      [cabecera][forma de onda] × N
        MEZCLADOR   canal + efectos de la pista seleccionada
        ESTADO      mensajes · progreso de la IA

    Traduce las acciones del usuario en llamadas a los servicios (motor,
    proyecto, IA). No contiene lógica de audio.
*/
import { MODELS, SeparationManager, type SeparationResult } from './ai/separator.ts';
import { getSeparationServer, isLocalPage } from './ai/serverConfig.ts';
import { decodeAudio, isAudioFile, sourceBlob, sourceFileName } from './audio/decode.ts';
import { AudioEngine } from './audio/engine.ts';
import { formatTime, stemDisplayName } from './core/strings.ts';
import { gainToDecibels } from './core/range.ts';
import { downloadBlob, startExport, type ExportFile } from './export/exporter.ts';
import { ClipEditing, clipContains, createClipId, type AudioClip } from './model/clip.ts';
import { ProjectManager, type NewTrack, type Result } from './model/project.ts';
import type { AudioTrack, TrackFolder } from './model/track.ts';
import { showAudioSettings } from './ui/audioSettings.ts';
import { trackColourFor, type Colour } from './ui/colour.ts';
import { isDialogOpen, openDialog, showConfirm, showMessage } from './ui/dialogs.ts';
import { h, isEditingText } from './ui/dom.ts';
import { ProgressDialog, showExportDialog, type ExportScope } from './ui/exportDialog.ts';
import { showSeparationServerDialog } from './ui/serverDialog.ts';
import { header, item, MenuBar, separator, showMenu, type MenuEntry } from './ui/menu.ts';
import { MixerView } from './ui/mixerView.ts';
import { SeparationScreen, SeparationView } from './ui/separationScreen.ts';
import { StatusBar } from './ui/statusBar.ts';
import { TrackList, type FolderInfo } from './ui/trackList.ts';
import { TransportBar } from './ui/transportBar.ts';

const version = '0.1.0';

export class App {
  readonly engine = new AudioEngine();
  readonly projects = new ProjectManager(this.engine);
  readonly ai = new SeparationManager();

  private transportBar = new TransportBar(this.engine, this.projects);
  private trackList = new TrackList(this.engine, this.projects);
  private mixer = new MixerView(this.engine);
  private statusBar = new StatusBar(this.ai, this.projects);
  private screen = new SeparationScreen();
  private menuBar: MenuBar;
  private fileInput = h('input', { type: 'file', multiple: true, accept: 'audio/*,.flac,.wav,.mp3,.ogg,.opus,.m4a,.aac,.aif,.aiff' });

  // Pantallas de ondas, una por carpeta de separación (la de la separación en
  // curso también, con su id).
  private folderViews = new Map<string, SeparationView>();
  private separatingFolderId = '';
  private loadingStemsFolderId = '';

  private clipboard: AudioClip | null = null;           // fragmento copiado o cortado
  private trackClipboard: AudioTrack | null = null;     // copia de la pista copiada o cortada
  private recordingTarget: AudioTrack | null = null;    // pista donde va la grabación en curso
  private recordingStarting = false;

  constructor(root: HTMLElement) {
    this.menuBar = new MenuBar(['Archivo', 'Editar', 'Proyecto', 'Audio', 'IA', 'Ayuda'], index => this.getMenu(index));

    root.append(
      h('header', { className: 'app-header' }, h('div', { className: 'app-logo', 'aria-hidden': 'true' }), this.menuBar.element),
      this.transportBar.element,
      this.trackList.element,
      this.mixer.element,
      this.statusBar.element,
      this.screen.element);

    this.transportBar.onToStart = () => { if (!this.engine.isRecording()) this.engine.setPosition(0); };
    this.transportBar.onPlayPause = () => this.togglePlayPause();
    this.transportBar.onStop = () => this.stop();
    this.transportBar.onRecord = () => void this.toggleRecording();

    const list = this.trackList;
    list.onSelectionChanged = track => this.mixer.setTrack(track);
    list.onDeleteRequested = track => void this.removeTrack(track);
    list.onClipsEdited = (track, before, name) => this.projects.clipsEdited(track, before, name);
    list.onAddTrack = (index, folderId) => this.addTrack(index, folderId);
    list.onToggleFolder = folderId => {
      const folder = this.projects.findFolder(folderId);

      if (folder !== undefined)
        this.projects.setFolderExpanded(folderId, !folder.expanded);
    };
    list.onToggleFolderWindow = folderId => this.toggleFolderWindow(folderId);
    list.onDeleteFolderRequested = folderId => void this.removeFolder(folderId);
    list.onTrackDropped = (track, folderId, index) => this.projects.moveTrackToFolder(track, folderId, index);
    list.onTracksReordered = (track, from, to) => this.projects.trackMoved(track, from, to);
    list.onTrackRenamed = (track, oldName) => {
      this.projects.trackRenamed(track, oldName);
      this.mixer.updateName();
    };
    list.onCopyTrack = track => this.copyTrack(track);
    list.onCutTrack = track => this.cutTrack(track);
    list.onPasteTrack = index => this.pasteTrack(index);
    list.canPasteTrack = () => this.trackClipboard !== null;
    list.onContextMenu = (track, clipId, seconds, x, y) => this.showClipMenu(track, clipId, seconds, x, y);
    list.onDownloadTrack = track => {
      list.selectTrack(track);
      void this.exportAudio('track');
    };
    list.onDownloadFolder = folderId => void this.exportAudio('folder:' + folderId);

    this.statusBar.onCancel = () => this.ai.cancel();
    this.statusBar.onShowSeparation = () => this.showSeparationWindow();
    this.screen.onCancel = () => this.ai.cancel();
    this.screen.onVisibilityChanged = () => this.updateFolders();

    this.projects.onChange(() => this.projectChanged());
    this.trackList.refresh();

    this.fileInput.addEventListener('change', () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      this.importFiles(files);
    });

    window.addEventListener('keydown', e => this.keyPressed(e));
    this.setupFileDrop();

    // Como en la versión de escritorio, los botones y controles no se quedan
    // con el foco del teclado al pulsarlos: así Espacio, R, S... siguen siendo
    // atajos de la aplicación (y no vuelven a pulsar el último botón).
    document.addEventListener('mousedown', event => {
      const target = event.target as HTMLElement;

      if (target.closest('button') !== null && target.closest('.dialog, .popup-menu') === null)
        event.preventDefault();
    });

    // No hay guardado en la nube: al cerrar la pestaña con trabajo se avisa.
    window.addEventListener('beforeunload', event => {
      if (this.projects.hasContent() || this.ai.isBusy() || this.engine.isRecording()) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    void this.engine.ready.then(() => {
      if (this.engine.initError !== '')
        void showMessage('Sin audio', 'Este navegador no puede ejecutar el motor de audio de StemLab (AudioWorklet).\n\n'
                                      + 'Usa una versión reciente de Chrome, Edge, Firefox o Safari.\n\n' + this.engine.initError);
    });
  }

  private projectChanged(): void {
    this.updateFolders();
    this.trackList.refresh();
    this.mixer.updateName();
  }

  //============================================================================
  // Menús

  private getMenu(index: number): MenuEntry[] {
    const hasTracks = this.projects.hasContent();
    const aiBusy = this.ai.isBusy();
    const hasTrack = this.trackList.getSelectedTrack() !== null;
    const hasClip = this.trackList.getSelectedClipId() !== 0;

    switch (index) {
      case 0:
        return [
          item('Nuevo proyecto', () => void this.newProject()),
          separator(),
          item('Importar audio...', () => this.importAudio(), { shortcut: 'Ctrl+I' }),
          item('Exportar / descargar (WAV · MP3 · ZIP)...', () => void this.exportAudio('mix'), { shortcut: 'Ctrl+E', enabled: hasTracks }),
        ];

      case 1:
        return [
          item(this.projects.canUndo() ? 'Deshacer: ' + this.projects.getUndoDescription() : 'Deshacer', () => this.undo(),
               { shortcut: 'Ctrl+Z', enabled: this.projects.canUndo() }),
          item(this.projects.canRedo() ? 'Rehacer: ' + this.projects.getRedoDescription() : 'Rehacer', () => this.redo(),
               { shortcut: 'Ctrl+Y', enabled: this.projects.canRedo() }),
          header('Fragmentos'),
          item('Dividir en el cabezal', () => this.splitAtPlayhead(), { shortcut: 'S', enabled: hasTrack }),
          item('Cortar', () => this.cutSelectedClip(), { shortcut: 'Ctrl+X', enabled: hasClip }),
          item('Copiar', () => this.copySelectedClip(), { shortcut: 'Ctrl+C', enabled: hasClip }),
          item('Pegar en el cabezal', () => this.pasteClip(this.trackList.getSelectedTrack(), this.engine.getPosition()),
               { shortcut: 'Ctrl+V', enabled: hasTrack && this.clipboard !== null }),
          item('Eliminar fragmento', () => this.deleteSelectedClip(), { shortcut: 'Supr', enabled: hasClip }),
          header('Pistas'),
          item('Añadir pista', () => this.addTrack(), { shortcut: 'T' }),
          item('Cambiar nombre de la pista', () => this.trackList.renameSelectedTrack(), { shortcut: 'F2', enabled: hasTrack }),
          item('Subir pista', () => this.trackList.moveSelectedTrack(-1), { shortcut: 'Alt+↑', enabled: hasTrack }),
          item('Bajar pista', () => this.trackList.moveSelectedTrack(1), { shortcut: 'Alt+↓', enabled: hasTrack }),
          item('Copiar pista', () => this.copyTrack(this.trackList.getSelectedTrack()), { shortcut: 'Ctrl+C', enabled: hasTrack }),
          item('Cortar pista', () => this.cutTrack(this.trackList.getSelectedTrack()), { shortcut: 'Ctrl+X', enabled: hasTrack }),
          item('Pegar pista debajo', () => this.pasteTrack(), { shortcut: 'Ctrl+V', enabled: this.trackClipboard !== null }),
          item('Eliminar pista seleccionada', () => this.deleteSelectedTrack(), { shortcut: 'Ctrl+Supr', enabled: hasTrack }),
        ];

      case 2:
        return [
          header('Vista'),
          item('Acercar', () => this.trackList.zoomIn(), { shortcut: 'Ctrl + rueda' }),
          item('Alejar', () => this.trackList.zoomOut(), { shortcut: 'Ctrl + rueda' }),
          item('Ver toda la canción', () => this.trackList.zoomToFit()),
        ];

      case 3:
        return [
          item(this.engine.isPlaying() ? 'Pausa' : 'Reproducir', () => this.togglePlayPause(), { shortcut: 'Espacio' }),
          item('Detener', () => this.stop()),
          item(this.engine.isRecording() ? 'Detener grabación' : 'Grabar', () => void this.toggleRecording(), { shortcut: 'R' }),
          separator(),
          item('Configuración de audio...', () => void showAudioSettings(this.engine, m => this.statusBar.setMessage(m))),
        ];

      case 4:
        return [
          item('Separar instrumentos', () => void this.separateInstruments(), { enabled: hasTracks && !aiBusy }),
          item('Mostrar progreso de la separación', () => this.showSeparationWindow(),
               { enabled: aiBusy && this.folderViews.has(this.separatingFolderId) }),
          item('Cancelar separación', () => this.ai.cancel(), { enabled: aiBusy }),
          separator(),
          item('Servidor de separación...', () => void this.configureServer(), { enabled: !aiBusy }),
          separator(),
          header('Modelo'),
          ...MODELS.map(model => item(model.id + '  -  ' + model.description, () => {
            this.ai.currentModel = model.id;
            this.statusBar.setMessage('Modelo de separación: ' + model.id);
          }, { enabled: !aiBusy, ticked: model.id === this.ai.currentModel })),
        ];

      default:
        return [
          item('Atajos de teclado', () => this.showShortcuts()),
          item('Acerca de StemLab Web', () => this.showAbout()),
        ];
    }
  }

  //============================================================================
  // Teclado

  private keyPressed(event: KeyboardEvent): void {
    if (event.defaultPrevented || isDialogOpen() || isEditingText())
      return;

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const command = event.ctrlKey || event.metaKey;
    const plain = !command && !event.altKey;
    const run = (action: () => void) => {
      event.preventDefault();
      action();
    };

    // Con la pantalla de separación delante solo funcionan el transporte y Esc.
    if (this.screen.isVisible()) {
      if (key === ' ') run(() => this.togglePlayPause());
      else if (key === 'Home') run(() => { if (!this.engine.isRecording()) this.engine.setPosition(0); });
      else if (key === 'Escape') run(() => this.screen.hide());
      return;
    }

    if (key === ' ' && plain)                                        run(() => this.togglePlayPause());
    else if (key === 'Home' && plain)                                run(() => { if (!this.engine.isRecording()) this.engine.setPosition(0); });
    else if (key === 'z' && command && !event.shiftKey)              run(() => this.undo());
    else if (key === 'z' && command && event.shiftKey)               run(() => this.redo());
    else if (key === 'y' && command)                                 run(() => this.redo());
    else if (key === 'Delete' && command)                            run(() => this.deleteSelectedTrack());
    else if ((key === 'Delete' || key === 'Backspace') && plain)     run(() => this.deleteSelection());
    else if (key === 'r' && plain && !event.shiftKey)                run(() => void this.toggleRecording());
    else if (key === 's' && plain && !event.shiftKey)                run(() => this.splitAtPlayhead());
    else if (key === 'x' && command)                                 run(() => this.cutSelection());
    else if (key === 'c' && command)                                 run(() => this.copySelection());
    else if (key === 'v' && command)                                 run(() => this.paste());
    else if (key === 't' && plain && !event.shiftKey)                run(() => this.addTrack());
    else if (key === 'F2')                                           run(() => this.trackList.renameSelectedTrack());
    else if (key === 'ArrowUp' && event.altKey)                      run(() => this.trackList.moveSelectedTrack(-1));
    else if (key === 'ArrowDown' && event.altKey)                    run(() => this.trackList.moveSelectedTrack(1));
    else if (key === 'i' && command)                                 run(() => this.importAudio());
    else if (key === 'e' && command)                                 run(() => void this.exportAudio('mix'));
  }

  //============================================================================
  // Archivos

  private setupFileDrop(): void {
    const overlay = h('div', { className: 'drop-overlay' }, h('div', { text: 'Suelta aquí el audio para importarlo' }));
    document.body.append(overlay);
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') === true;

    window.addEventListener('dragenter', e => {
      if (!hasFiles(e))
        return;

      e.preventDefault();
      ++depth;
      overlay.classList.add('visible');
    });

    window.addEventListener('dragover', e => {
      if (hasFiles(e)) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
      }
    });

    window.addEventListener('dragleave', e => {
      if (hasFiles(e) && --depth <= 0) {
        depth = 0;
        overlay.classList.remove('visible');
      }
    });

    window.addEventListener('drop', e => {
      if (!hasFiles(e))
        return;

      e.preventDefault();
      depth = 0;
      overlay.classList.remove('visible');
      this.importFiles([...(e.dataTransfer?.files ?? [])]);
    });
  }

  private importAudio(): void {
    this.fileInput.click();
  }

  private importFiles(files: File[]): void {
    const audio = files.filter(isAudioFile);

    if (audio.length === 0) {
      if (files.length > 0)
        void showMessage('Importar audio', 'Ninguno de esos archivos es de audio (WAV, MP3, FLAC, OGG, M4A...).');

      return;
    }

    this.statusBar.setMessage('Importando...');
    void this.projects.importFiles(audio).then(result => this.reportResult(result, 'Audio importado.'));
  }

  private async newProject(): Promise<void> {
    if (!this.ensureIdle('crear un proyecto'))
      return;

    if (this.projects.hasContent()) {
      const choice = await new Promise<number>(resolve => {
        openDialog('Nuevo proyecto',
                   'Se descartará la sesión actual: las pistas, grabaciones y separaciones que no hayas descargado se perderán '
                   + '(StemLab Web no guarda nada en la nube).\n\n¿Quieres descargar algo antes?',
                   [{ label: 'Cancelar', value: 0 }, { label: 'Descargar...', value: 2 }, { label: 'Descartar', value: 1, danger: true, primary: true }],
                   resolve, { icon: 'question' });
      });

      if (choice === 2) {
        void this.exportAudio('mix');
        return;
      }

      if (choice !== 1)
        return;
    }

    this.clearFolderViews();
    this.projects.newProject();
    this.statusBar.setMessage('Proyecto nuevo.');
  }

  /** Exportar / descargar: la mezcla, una pista, una carpeta o todas las pistas. */
  private async exportAudio(initialScope: string): Promise<void> {
    // La grabación en curso y el audio que se está cargando aún no son clips:
    // no saldrían en el archivo.
    if (!this.ensureIdle('exportar'))
      return;

    const contentLength = this.projects.getContentLength();

    if (contentLength <= 0) {
      void showMessage('Exportar / descargar', 'No hay nada que exportar: importa o graba audio primero.');
      return;
    }

    const tracks = this.projects.tracks.filter(t => t.hasClips());
    const selected = this.trackList.getSelectedTrack();
    const scopes: ExportScope[] = [{ id: 'mix', label: 'Mezcla completa', defaultName: 'Mezcla', zip: false }];

    if (selected !== null && selected.hasClips())
      scopes.push({ id: 'track', label: `Pista seleccionada: "${selected.name}"`, defaultName: selected.name, zip: false });

    for (const folder of this.projects.folders) {
      const members = this.projects.getFolderTracks(folder.id).filter(t => t.hasClips());

      if (members.length > 0)
        scopes.push({ id: 'folder:' + folder.id, label: `Carpeta "${folder.name}" (${members.length} pistas, .zip)`,
                      defaultName: folder.name + ' - pistas', zip: true });
    }

    if (tracks.length > 1)
      scopes.push({ id: 'all', label: `Todas las pistas por separado (${tracks.length}, .zip)`, defaultName: 'Pistas', zip: true });

    const choice = await showExportDialog(scopes, initialScope);

    if (choice === null)
      return;

    const single = (track: AudioTrack, name: string, length: number): ExportFile =>
      ({ name, tracks: [track], forceAudible: true, length });

    let files: ExportFile[];

    if (choice.scope.id === 'mix')
      files = [{ name: choice.name, tracks: this.projects.tracks, forceAudible: false, length: contentLength }];
    else if (choice.scope.id === 'track' && selected !== null)
      files = [single(selected, choice.name, selected.getEndSample())];
    else if (choice.scope.id.startsWith('folder:'))
      files = this.projects.getFolderTracks(choice.scope.id.slice(7)).filter(t => t.hasClips()).map(t => single(t, t.name, contentLength));
    else
      files = tracks.map(t => single(t, t.name, contentLength));

    let cancelTask = () => undefined as void;
    const progress = new ProgressDialog('Exportar / descargar', `Preparando "${choice.name}"...`, () => cancelTask());
    const task = startExport(files, {
      sampleRate: this.engine.sampleRate,
      masterVolume: this.engine.masterVolume.get(),
      format: choice.format,
      mp3Bitrate: choice.mp3Bitrate,
      zipName: choice.scope.zip ? choice.name : '',
    }, value => progress.setProgress(value));

    cancelTask = () => task.cancel();
    const result = await task.promise;
    progress.close();

    if (result.cancelled) {
      this.statusBar.setMessage('Exportación cancelada.');
      return;
    }

    if (!result.ok || result.blob === null) {
      void showMessage('Exportar / descargar', result.error);
      return;
    }

    downloadBlob(result.blob, result.fileName);

    // Por encima de 0 dBFS, WAV entero y MP3 recortan: se avisa (el WAV de
    // 32 bits coma flotante lo conserva).
    if (result.clipped)
      void showMessage('Exportado con recorte', `El audio llega a +${gainToDecibels(result.peak).toFixed(1)} dBFS y se ha recortado al guardarlo.\n\n`
                       + 'Baja el volumen master o de las pistas (o activa el Limiter) y vuelve a exportar.\n\n' + result.fileName);

    this.statusBar.setMessage(`Descargado (${formatTime(result.seconds)}): ${result.fileName}`);
  }

  //============================================================================
  // Pistas

  private deleteSelection(): void {
    if (this.trackList.getSelectedClipId() !== 0)
      this.deleteSelectedClip();
    else if (this.trackList.getSelectedTrack() !== null)
      void this.removeTrack(this.trackList.getSelectedTrack()!);      // pide confirmación
    else
      this.statusBar.setMessage('Selecciona un fragmento o una pista para eliminarlo.');
  }

  private deleteSelectedTrack(): void {
    const track = this.trackList.getSelectedTrack();

    if (track !== null)
      void this.removeTrack(track);
    else
      this.statusBar.setMessage('Selecciona primero la pista que quieres eliminar.');
  }

  private async removeTrack(track: AudioTrack): Promise<void> {
    if (this.engine.isRecording() && track.armed) {
      void showMessage('Eliminar pista', 'No se puede eliminar la pista mientras se graba en ella.');
      return;
    }

    const confirmed = await showConfirm('Eliminar pista',
      `¿Estás seguro de que quieres eliminar esta pista?\n\n"${track.name}"\n\n`
      + 'Sus fragmentos se quitarán del proyecto. Puedes recuperarla con Editar > Deshacer (Ctrl+Z).', 'Eliminar', 'Cancelar', true);

    if (!confirmed || !this.projects.tracks.includes(track))
      return;

    this.projects.removeTrack(track);
    this.statusBar.setMessage(`Pista "${track.name}" eliminada. Ctrl+Z la recupera.`);
  }

  private async removeFolder(folderId: string): Promise<void> {
    const folder = this.projects.findFolder(folderId);

    if (folder === undefined)
      return;

    // Mientras se cargan sus pistas todavía no están dentro.
    if (folderId === this.loadingStemsFolderId) {
      void showMessage('Eliminar carpeta', 'Espera a que terminen de cargarse las pistas de la separación.');
      return;
    }

    const tracks = this.projects.getFolderTracks(folderId);

    if (this.engine.isRecording() && tracks.some(t => t.armed)) {
      void showMessage('Eliminar carpeta', 'No se puede eliminar la carpeta mientras se graba en una de sus pistas.');
      return;
    }

    const count = tracks.length;
    const confirmed = await showConfirm('Eliminar carpeta',
      `¿Estás seguro de que quieres eliminar esta carpeta?\n\n"${folder.name}" (${count} ${count === 1 ? 'pista' : 'pistas'})\n\n`
      + 'Se eliminarán la carpeta y las pistas que tiene dentro. Puedes recuperarla con Editar > Deshacer (Ctrl+Z).',
      'Eliminar', 'Cancelar', true);

    if (!confirmed)
      return;

    this.projects.removeFolder(folderId);
    this.statusBar.setMessage(`Carpeta "${folder.name}" eliminada. Ctrl+Z la recupera.`);
  }

  /** Justo debajo de la pista seleccionada, o -1 (al final) si no hay ninguna. */
  private indexBelowSelectedTrack(): number {
    const index = this.projects.tracks.indexOf(this.trackList.getSelectedTrack()!);
    return index < 0 ? -1 : index + 1;
  }

  private addTrack(insertIndex = -1, folderId = ''): void {
    // Sin posición (T, menú): justo debajo de la pista seleccionada.
    if (insertIndex < 0)
      insertIndex = this.indexBelowSelectedTrack();

    const track = this.projects.addEmptyTrack('Pista', insertIndex, folderId);
    this.trackList.refresh();
    this.trackList.selectTrack(track);
    this.statusBar.setMessage('Pista añadida y seleccionada: pulsa R o el botón rojo para grabar en ella (Ctrl+Z la quita).');
  }

  //============================================================================
  // Portapapeles: Ctrl+C / Ctrl+X actúan sobre el fragmento seleccionado o, si
  // no hay (clic en la cabecera), sobre la pista entera. Ctrl+V pega lo último.

  private copySelection(): void {
    if (this.trackList.getSelectedClipId() !== 0)
      this.copySelectedClip();
    else if (this.trackList.getSelectedTrack() !== null)
      this.copyTrack(this.trackList.getSelectedTrack());
    else
      this.statusBar.setMessage('Selecciona un fragmento o una pista (clic en su cabecera) para copiarlo.');
  }

  private cutSelection(): void {
    if (this.trackList.getSelectedClipId() !== 0)
      this.cutSelectedClip();
    else if (this.trackList.getSelectedTrack() !== null)
      this.cutTrack(this.trackList.getSelectedTrack());
    else
      this.statusBar.setMessage('Selecciona un fragmento o una pista (clic en su cabecera) para cortarlo.');
  }

  private paste(): void {
    if (this.trackClipboard !== null)
      this.pasteTrack();
    else
      this.pasteClip(this.trackList.getSelectedTrack(), this.engine.getPosition());
  }

  private copyTrack(track: AudioTrack | null): void {
    if (track === null) {
      this.statusBar.setMessage('Selecciona la pista que quieres copiar.');
      return;
    }

    // Una copia en el momento de copiar: lo que se edite después en la pista
    // original no cambia lo que se pegará.
    this.trackClipboard = track.createCopy(track.name);
    this.clipboard = null;
    this.statusBar.setMessage(`Pista "${track.name}" copiada. Ctrl+V la pega debajo de la pista seleccionada.`);
  }

  private cutTrack(track: AudioTrack | null): void {
    if (track === null) {
      this.statusBar.setMessage('Selecciona la pista que quieres cortar.');
      return;
    }

    if (this.engine.isRecording() && track.armed) {
      void showMessage('Cortar pista', 'No se puede cortar la pista mientras se graba en ella.');
      return;
    }

    this.copyTrack(track);
    this.projects.removeTrack(track, 'Cortar pista');
    this.statusBar.setMessage(`Pista "${track.name}" cortada. Ctrl+V la pega; Ctrl+Z la devuelve a su sitio.`);
  }

  private pasteTrack(insertIndex = -1): void {
    if (this.trackClipboard === null) {
      this.statusBar.setMessage('No hay ninguna pista copiada.');
      return;
    }

    if (insertIndex < 0)
      insertIndex = this.indexBelowSelectedTrack();

    const track = this.projects.pasteTrack(this.trackClipboard, insertIndex);
    this.trackList.refresh();
    this.trackList.selectTrack(track);
    this.statusBar.setMessage(`Pista pegada: "${track.name}".`);
  }

  //============================================================================
  // Edición de fragmentos

  private undo(): void {
    // Durante una grabación, la pista en la que se graba recibirá la toma al
    // terminar: se deshace después, para no mezclar las dos cosas.
    if (this.engine.isRecording()) {
      this.statusBar.setMessage('Termina la grabación antes de deshacer.');
      return;
    }

    const description = this.projects.getUndoDescription();
    this.statusBar.setMessage(this.projects.undo() ? 'Deshecho: ' + description : 'No hay nada que deshacer.');
  }

  private redo(): void {
    if (this.engine.isRecording()) {
      this.statusBar.setMessage('Termina la grabación antes de rehacer.');
      return;
    }

    const description = this.projects.getRedoDescription();
    this.statusBar.setMessage(this.projects.redo() ? 'Rehecho: ' + description : 'No hay nada que rehacer.');
  }

  /** Clip sobre el que actúa "Dividir": el seleccionado si contiene la
      posición; si no, el de más arriba que la contenga. */
  private static clipAt(clips: AudioClip[], preferredId: number, position: number): AudioClip | undefined {
    return clips.find(c => c.id === preferredId && clipContains(c, position))
        ?? [...clips].reverse().find(c => clipContains(c, position));
  }

  private splitAtPlayhead(): void {
    const track = this.trackList.getSelectedTrack();

    if (track === null) {
      this.statusBar.setMessage('Selecciona una pista para dividir.');
      return;
    }

    const clips = track.getClips();
    const position = Math.round(this.engine.getPosition());
    const target = App.clipAt(clips, this.trackList.getSelectedClipId(), position);

    if (target === undefined) {
      this.statusBar.setMessage('El cabezal no está sobre ningún fragmento de la pista seleccionada.');
      return;
    }

    const rightHalf = ClipEditing.split(clips, target.id, position);

    if (rightHalf === 0) {
      this.statusBar.setMessage('Demasiado cerca del borde del fragmento para dividir.');
      return;
    }

    this.projects.editClips(track, clips, 'Dividir fragmento');
    this.trackList.selectClip(track, rightHalf);
    this.statusBar.setMessage('Fragmento dividido en el cabezal.');
  }

  private copySelectedClip(): void {
    const track = this.trackList.getSelectedTrack();
    const clip = track !== null ? ClipEditing.find(track.getClips(), this.trackList.getSelectedClipId()) : undefined;

    if (clip !== undefined) {
      this.clipboard = clip;
      this.trackClipboard = null;
      this.statusBar.setMessage('Fragmento copiado. Ctrl+V lo pega en el cabezal.');
    }
  }

  private cutSelectedClip(): void {
    const track = this.trackList.getSelectedTrack();

    if (track === null)
      return;

    const clips = track.getClips();
    const clip = ClipEditing.find(clips, this.trackList.getSelectedClipId());

    if (clip !== undefined) {
      this.clipboard = { ...clip };
      this.trackClipboard = null;
      ClipEditing.remove(clips, clip.id);
      this.projects.editClips(track, clips, 'Cortar fragmento');
      this.trackList.selectClip(track, 0);
      this.statusBar.setMessage('Fragmento cortado. Ctrl+V lo pega en el cabezal.');
    }
  }

  private pasteClip(track: AudioTrack | null, position: number): void {
    if (this.clipboard === null) {
      this.statusBar.setMessage('No hay nada copiado.');
      return;
    }

    if (track === null) {
      this.statusBar.setMessage('Selecciona la pista donde pegar.');
      return;
    }

    const clips = track.getClips();
    const clip: AudioClip = { ...this.clipboard, id: createClipId() };

    // Nunca encima de otro audio de la pista: si el cabezal está sobre un
    // fragmento, se pega justo después (en el primer hueco donde quepa).
    position = Math.max(0, Math.round(position));
    clip.timelineStart = ClipEditing.findFreeSpace(clips, position, clip.length);

    clips.push(clip);
    this.projects.editClips(track, clips, 'Pegar fragmento');
    this.trackList.selectClip(track, clip.id);

    const rate = this.engine.sampleRate;
    this.statusBar.setMessage(clip.timelineStart === position ? 'Fragmento pegado.'
      : `Fragmento pegado a continuación del audio que había en ${formatTime(position / rate)}, en ${formatTime(clip.timelineStart / rate)}.`);
  }

  private deleteSelectedClip(): void {
    const track = this.trackList.getSelectedTrack();
    const clipId = this.trackList.getSelectedClipId();

    if (track === null || clipId === 0) {
      this.statusBar.setMessage('Selecciona un fragmento (clic sobre él) para eliminarlo.');
      return;
    }

    const clips = track.getClips();

    if (ClipEditing.remove(clips, clipId)) {
      this.projects.editClips(track, clips, 'Eliminar fragmento');
      this.trackList.selectClip(track, 0);
      this.statusBar.setMessage('Fragmento eliminado. Ctrl+Z lo recupera.');
    }
  }

  private showClipMenu(track: AudioTrack, clipId: number, seconds: number, x: number, y: number): void {
    const position = Math.round(seconds * this.engine.sampleRate);
    const hasClip = clipId !== 0;

    showMenu([
      item('Dividir en el cabezal', () => this.splitAtPlayhead(), { shortcut: 'S' }),
      item('Cortar', () => this.cutSelectedClip(), { shortcut: 'Ctrl+X', enabled: hasClip }),
      item('Copiar', () => this.copySelectedClip(), { shortcut: 'Ctrl+C', enabled: hasClip }),
      item('Pegar aquí', () => this.pasteClip(track, position), { enabled: this.clipboard !== null }),
      item('Eliminar fragmento', () => this.deleteSelectedClip(), { shortcut: 'Supr', enabled: hasClip }),
      separator(),
      item('Descargar pista...', () => void this.exportAudio('track'), { enabled: track.hasClips() }),
    ], x, y);
  }

  //============================================================================
  // Transporte y grabación

  private togglePlayPause(): void {
    if (this.engine.isRecording()) {
      this.finishRecording();
      return;
    }

    this.engine.togglePlayPause();
  }

  private stop(): void {
    if (this.engine.isRecording())
      this.finishRecording();

    this.engine.stop();
  }

  private async toggleRecording(): Promise<void> {
    if (this.engine.isRecording()) {
      this.finishRecording();
      return;
    }

    if (this.recordingStarting)
      return;

    // Se graba en la pista seleccionada. Sin pistas no se arranca nada (ni la
    // grabación ni el cabezal): primero hay que añadir una.
    const target = this.trackList.getSelectedTrack();

    if (target === null) {
      this.askToAddTrackForRecording();
      return;
    }

    // En una pista los fragmentos no se solapan: si el cabezal está sobre
    // audio grabado, la toma empieza justo después (para grabar encima se usa
    // otra pista).
    const playhead = Math.round(this.engine.getPosition());
    const start = ClipEditing.findFreeSpace(target.getClips(), playhead, 1);

    if (start !== playhead)
      this.engine.setPosition(start);

    this.recordingStarting = true;
    const error = await this.engine.startRecording();
    this.recordingStarting = false;

    if (error !== '') {
      void showMessage('No se puede grabar', error);
      return;
    }

    // "Armada" solo mientras se graba: pinta la franja roja y la vista previa
    // en directo sobre esa pista.
    this.recordingTarget = target;
    this.projects.setArmedTrack(target);
    const rate = this.engine.sampleRate;
    this.statusBar.setMessage(`Grabando en "${target.name}"`
      + (start !== playhead ? ` a continuación del audio que ya tiene, desde ${formatTime(start / rate)}` : '')
      + '... pulsa R para pausar y R para seguir en la misma pista.');
  }

  private askToAddTrackForRecording(): void {
    const noTracks = this.projects.tracks.length === 0;
    this.statusBar.setMessage(noTracks ? 'No hay ninguna pista: añade una (+ o T) y pulsa R para grabar en ella.'
                                       : 'Selecciona la pista en la que quieres grabar (clic en ella) y pulsa R.');

    if (!noTracks)
      return;

    openDialog('Grabar', 'No hay ninguna pista donde grabar.\n\nAñade una pista (con + o la tecla T), '
                         + 'déjala seleccionada y pulsa R o el botón rojo para empezar a grabar en ella.',
               [{ label: 'Cancelar', value: 0 }, { label: 'Añadir pista', value: 1, primary: true }],
               value => {
                 if (value === 1)
                   this.addTrack();
               }, { icon: 'info' });
  }

  private finishRecording(): void {
    const done = this.engine.stopRecording();
    this.engine.pause();
    this.projects.setArmedTrack(null);

    // La grabación se añade como un fragmento más de la misma pista (que sigue
    // seleccionada); al volver a pulsar R se sigue grabando en ella, justo después.
    this.statusBar.setMessage('Procesando la grabación...');
    const finishLoading = this.projects.beginLoading();

    void done.then(recording => {
      finishLoading();
      const result = this.projects.addRecording(recording, this.recordingTarget);
      this.reportResult(result, 'Fragmento grabado. Pulsa R para seguir grabando en la misma pista.');
    });
  }

  //============================================================================
  // Separación por IA

  private async separateInstruments(): Promise<void> {
    if (this.ai.isBusy())
      return;

    const source = this.trackList.getSelectedTrack() ?? this.projects.tracks[0] ?? null;

    if (source === null || !source.hasClips()) {
      void showMessage('Separar instrumentos', 'Primero importa una canción (Archivo > Importar audio...) y selecciona su pista.');
      return;
    }

    // Web desplegada sin servidor de separación (Vercel...): primero hay que
    // decir dónde está (en este equipo o en otro servidor).
    if (getSeparationServer() === '' && !isLocalPage() && !await showSeparationServerDialog(m => this.statusBar.setMessage(m)))
      return;

    if (this.ai.isBusy() || !this.projects.tracks.includes(source) || !source.hasClips())
      return;

    // Se envía el audio del primer fragmento de la pista (el archivo entero).
    const firstClip = source.getClips()[0];
    const blob = sourceBlob(firstClip.source);

    // La separación, su carpeta de pistas y su pantalla de ondas comparten un id.
    const folderId = crypto.randomUUID();
    const expected = this.ai.getExpectedStems();

    const started = this.ai.start(blob, sourceFileName(firstClip.source), result => {
      void this.separationFinished(result, source, folderId, expected);
    });

    if (!started)
      return;

    this.statusBar.setMessage(`Separando "${source.name}" con ${this.ai.getName()}...`);
    this.separatingFolderId = folderId;

    // Pantalla con la animación: el anillo del color de la pista original y,
    // según avanza, la onda de cada pista que se va a generar.
    const index = this.projects.tracks.indexOf(source);
    const view = this.createFolderView(folderId, source.name, trackColourFor(source.name, index), expected);

    // El anillo de frecuencias dibuja la propia canción.
    view.setSourceAudio(firstClip.source, firstClip.sourceOffset, firstClip.length);
    view.getProgress = () => this.ai.getProgress();
    view.getStatus = () => this.ai.getStatus();
    this.screen.present(folderId, view);
  }

  private async configureServer(): Promise<void> {
    await showSeparationServerDialog(message => this.statusBar.setMessage(message));
  }

  private showSeparationWindow(): void {
    const view = this.folderViews.get(this.separatingFolderId);

    if (view !== undefined)
      this.screen.present(this.separatingFolderId, view);
  }

  private createFolderView(folderId: string, name: string, colour: Colour, stemIds: string[]): SeparationView {
    const stems = stemIds.map(id => {
      const stemName = stemDisplayName(id);
      return { name: stemName, colour: trackColourFor(stemName, 0) };
    });

    const view = new SeparationView(name, colour, stems);

    // Cada onda sigue a su pista: si se elimina desaparece; si se deshace, vuelve.
    view.isStemPresent = index => index >= 0 && index < stemIds.length && this.isStemPresent(folderId, stemIds[index]);
    this.folderViews.set(folderId, view);
    return view;
  }

  private isStemPresent(folderId: string, stemId: string): boolean {
    // Mientras separa o carga las pistas todavía no existen: se ven todas.
    if (folderId === this.separatingFolderId || folderId === this.loadingStemsFolderId)
      return true;

    return this.projects.tracks.some(t => t.stemGroup === folderId && t.stemId === stemId);
  }

  private toggleFolderWindow(folderId: string): void {
    if (this.screen.getFolderId() === folderId) {
      this.screen.hide();
      return;
    }

    let view = this.folderViews.get(folderId);

    if (view === undefined) {
      const folder = this.projects.findFolder(folderId);

      if (folder === undefined || this.projects.getStemTracks(folderId).length === 0)
        return;

      view = this.createFolderView(folderId, folder.name, folder.colour, folder.stems);
      view.setFinished(true);

      // El anillo, con el audio de la canción separada (si sigue en el proyecto).
      const stillUsed = folder.source !== null && this.projects.tracks.some(t => t.getSources().includes(folder.source!));

      if (stillUsed)
        view.setSourceAudio(folder.source, folder.sourceStart, folder.sourceLength);
    }

    this.screen.present(folderId, view);
  }

  private clearFolderViews(): void {
    for (const id of this.folderViews.keys())
      this.screen.forget(id);

    this.folderViews.clear();
  }

  /** Pasa las carpetas a la lista de pistas y olvida las pantallas de ondas de
      las que ya no tienen pistas de su separación. */
  private updateFolders(): void {
    for (const id of [...this.folderViews.keys()]) {
      const keep = id === this.separatingFolderId || id === this.loadingStemsFolderId
                || (this.projects.findFolder(id) !== undefined && this.projects.getStemTracks(id).length > 0);

      if (!keep) {
        this.folderViews.delete(id);
        this.screen.forget(id);
      }
    }

    const shown = this.screen.getFolderId();
    const infos: FolderInfo[] = this.projects.folders.map(folder => ({
      id: folder.id,
      name: folder.name,
      colour: folder.colour,
      expanded: folder.expanded,
      canShowWaves: this.projects.getStemTracks(folder.id).length > 0,
      wavesOpen: shown === folder.id,
    }));

    this.trackList.setFolders(infos);
  }

  private async separationFinished(result: SeparationResult, source: AudioTrack, folderId: string, expected: string[]): Promise<void> {
    this.separatingFolderId = '';
    const view = this.folderViews.get(folderId);

    // Bien: la pantalla se queda (con todas las ondas) y ya pertenece a la
    // carpeta de las pistas nuevas. Cancelada o con error: se cierra.
    if (view !== undefined) {
      if (result.ok) {
        view.setFinished(true);
      } else {
        this.folderViews.delete(folderId);
        this.screen.forget(folderId);
      }
    }

    if (result.cancelled) {
      this.statusBar.setMessage('Separación cancelada.');
      this.updateFolders();
      return;
    }

    if (!result.ok) {
      this.updateFolders();
      this.statusBar.setMessage('La separación no se pudo hacer.');

      if (result.serverUnavailable === true) {
        openDialog('Error en la separación', result.error,
                   [{ label: 'Cerrar', value: 0 }, { label: 'Servidor de separación...', value: 1, primary: true }],
                   value => { if (value === 1) void this.configureServer(); }, { icon: 'warning' });
      } else {
        void showMessage('Error en la separación', result.error);
      }

      return;
    }

    // Los stems se alinean con el archivo original: su muestra 0 va donde
    // estaría la muestra 0 del primer clip de la pista.
    const clips = this.projects.tracks.includes(source) ? source.getClips() : [];
    const first = clips[0];
    const startSample = first !== undefined ? first.timelineStart - first.sourceOffset : 0;

    // Carpeta con las pistas nuevas (antes de cargarlas, para que aparezcan ya
    // dentro). Guarda lo que necesita su pantalla de ondas.
    const index = Math.max(0, this.projects.tracks.indexOf(source));
    const folder: TrackFolder = {
      id: folderId,
      name: source.name,
      colour: trackColourFor(source.name, index),
      expanded: true,
      stems: expected,
      source: first?.source ?? null,
      sourceStart: first?.sourceOffset ?? 0,
      sourceLength: first?.length ?? 0,
    };

    // Antes de añadir la carpeta: sus pistas aún no existen, pero su pantalla
    // de ondas debe quedarse abierta mientras se cargan.
    this.loadingStemsFolderId = folderId;
    this.projects.addFolder(folder);
    const finishLoading = this.projects.beginLoading();
    const errors: string[] = [];
    const tracks: NewTrack[] = [];

    for (const stem of result.stems) {
      try {
        const name = stemDisplayName(stem.name);
        const decoded = await decodeAudio(this.engine.context, stem.blob, name);
        tracks.push({ name, source: decoded, startSample, folderId, stemGroup: folderId, stemId: stem.name });
      } catch (error) {
        errors.push(stem.name + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    finishLoading();
    this.projects.addTracks(tracks, 'Separar instrumentos');
    this.loadingStemsFolderId = '';
    this.updateFolders();

    if (errors.length > 0) {
      void showMessage('Separación', 'No se pudieron cargar algunas pistas:\n\n' + errors.join('\n'));
      return;
    }

    // La suma de los stems ya reproduce la canción: se silencia el original
    // para no oírlo dos veces (sigue disponible para comparar).
    if (this.projects.tracks.includes(source))
      source.mute.set(1);

    this.statusBar.setMessage(`Separación completada: ${tracks.length} pistas. La pista original se ha silenciado.`);
  }

  //============================================================================
  private showAbout(): void {
    void showMessage('Acerca de StemLab Web',
      `StemLab Web ${version}\n\n`
      + 'Mini-DAW en el navegador para separar, editar, grabar y mezclar instrumentos. Es la versión web de StemLab de escritorio.\n\n'
      + 'El audio se procesa en tu navegador. La separación de fuentes la hace Demucs (Python + PyTorch) en el servidor de StemLab Web, '
      + 'que borra la canción y los stems en cuanto se descargan: nada se guarda en la nube.', 'info');
  }

  private showShortcuts(): void {
    const rows: [string, string][] = [
      ['Espacio', 'reproducir / pausa'],
      ['Inicio', 'ir al principio'],
      ['R', 'grabar / pausar la grabación (en la pista seleccionada)'],
      ['S', 'dividir el fragmento en el cabezal'],
      ['Ctrl+Z', 'deshacer'],
      ['Ctrl+Y / Ctrl+Shift+Z', 'rehacer'],
      ['Ctrl+X / C / V', 'cortar / copiar / pegar el fragmento seleccionado, o la pista entera si no hay fragmento seleccionado'],
      ['Supr / Retroceso', 'eliminar el fragmento seleccionado, o la pista si no hay fragmento seleccionado (pide confirmación)'],
      ['T', 'añadir pista (debajo de la seleccionada)'],
      ['F2', 'cambiar el nombre de la pista seleccionada'],
      ['Alt+↑ / Alt+↓', 'subir / bajar la pista seleccionada'],
      ['Ctrl+Supr', 'eliminar la pista seleccionada'],
      ['Ctrl+I', 'importar audio'],
      ['Ctrl+E', 'exportar / descargar (WAV / MP3 / ZIP)'],
      ['Ctrl + rueda', 'acercar / alejar alrededor del ratón'],
      ['Shift + rueda', 'desplazar a los lados'],
      ['Esc', 'cerrar la pantalla de separación (la separación sigue)'],
    ];

    const table = h('table', { className: 'shortcuts' },
      h('tbody', {}, ...rows.map(([key, action]) => h('tr', {}, h('td', {}, h('kbd', { text: key })), h('td', { text: action })))));

    openDialog('Atajos de teclado', table, [{ label: 'Cerrar', value: 1, primary: true }], () => undefined, { wide: true });
  }

  private ensureIdle(action: string): boolean {
    if (this.ai.isBusy() || this.projects.isLoading() || this.engine.isRecording()) {
      void showMessage('Espera un momento',
        `No se puede ${action} mientras hay una separación, una carga de audio o una grabación en curso.`);
      return false;
    }

    return true;
  }

  private reportResult(result: Result, successMessage: string): void {
    if (result.ok)
      this.statusBar.setMessage(successMessage);
    else
      void showMessage('StemLab', result.error);
  }
}
