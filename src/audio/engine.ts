/**
    Núcleo de audio en la página: crea el AudioContext y el AudioWorklet (el
    hilo de audio), le envía las pistas y el audio, refleja el transporte y
    gestiona el micrófono y la grabación.
*/
import workletUrl from './engine.worklet.ts?worker&url';
import { msg, tr } from '../core/i18n.ts';
import { Parameter } from '../core/parameter.ts';
import { NormalisableRange } from '../core/range.ts';
import type { ClipSource } from '../model/clip.ts';
import type { AudioTrack } from '../model/track.ts';
import { allocFloat32 } from './memory.ts';
import type { FromWorklet, Tick, ToWorklet } from './protocol.ts';

/** Datos de una grabación terminada, para convertirla en fragmento. */
export interface RecordingInfo {
  channels: Float32Array[];
  timelineStart: number;       // posición del primer sample grabado (-1: no se grabó nada)
  latencySamples: number;      // latencia de ida y vuelta entrada + salida
  sampleRate: number;
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };

const defaultOutputName = msg('predeterminada del sistema');     // se traduce al mostrarla

export class AudioEngine {
  readonly context: SinkContext;
  readonly sampleRate: number;
  private node: AudioWorkletNode | null = null;
  readonly ready: Promise<void>;
  initError = '';

  readonly inputGain = Parameter.continuous('inputGain', msg('Entrada'), new NormalisableRange(0, 40, 0.5), 18, 'dB');
  readonly masterVolume = Parameter.continuous('masterVolume', 'Master', new NormalisableRange(-60, 6, 0.1, 2), 0, 'dB');

  // Transporte (reflejo del hilo de audio)
  private playing = false;
  private recording = false;
  private tickPosition = 0;
  private tickTime = 0;
  contentLength = 0;

  // Medidores: pico desde la última lectura.
  private trackPeaks = new Map<number, [number, number]>();
  private masterPeaks: [number, number] = [0, 0];
  private inputPeaks: [number, number] = [0, 0];

  // Grabación
  private previewPeaks: number[] = [];
  private recordStart = -1;
  private recordLatency = 0;
  private recordChunks: Float32Array[][] = [];
  private recordDone: ((startPosition: number) => void) | null = null;

  // Micrófono y salida
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  inputDeviceId = '';
  outputDeviceId = '';            // '' = la salida predeterminada del sistema
  /** Nombre de la salida que suena (se actualiza al cambiarla). */
  outputName = defaultOutputName;

  private uploaded = new Set<number>();
  private listeners = new Set<() => void>();

  constructor() {
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.sampleRate = this.context.sampleRate;
    this.inputGain.textFormatter = db => '+' + db.toFixed(1) + ' dB';

    this.ready = this.init().catch(error => {
      this.initError = String(error instanceof Error ? error.message : error);
      console.error(error);
    });

    this.inputGain.onChange(p => this.post({ type: 'inputGain', db: p.get() }));
    this.masterVolume.onChange(p => this.post({ type: 'master', volume: p.get() }));

    // El navegador solo deja sonar audio después de un gesto del usuario.
    const resume = () => { void this.resume(); };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);

    navigator.mediaDevices?.addEventListener?.('devicechange', () => { void this.handleDeviceChange(); });
  }

  private async init(): Promise<void> {
    await this.context.audioWorklet.addModule(workletUrl);

    this.node = new AudioWorkletNode(this.context, 'stemlab-engine', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });

    this.node.port.onmessage = (event: MessageEvent<FromWorklet>) => this.handle(event.data);
    this.node.connect(this.context.destination);
    this.post({ type: 'inputGain', db: this.inputGain.get() });
    this.post({ type: 'master', volume: this.masterVolume.get() });

    // Si el micrófono ya estaba permitido, se abre para que el medidor de
    // entrada funcione desde el principio (como en la versión de escritorio).
    try {
      const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });

      if (status?.state === 'granted')
        await this.enableMicrophone();
    } catch {
      // Sin la API de permisos: se pide al grabar.
    }
  }

  async resume(): Promise<void> {
    if (this.context.state === 'suspended')
      await this.context.resume().catch(() => undefined);
  }

  isRunning(): boolean {
    return this.context.state === 'running' && this.node !== null;
  }

  /** Avisa en cada tic del hilo de audio (~30 veces por segundo). */
  onTick(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private post(message: ToWorklet): void {
    this.node?.port.postMessage(message);
  }

  private handle(message: FromWorklet): void {
    switch (message.type) {
      case 'tick':
        this.applyTick(message);
        break;

      case 'recChunk':
        this.recordChunks.push(message.channels);
        break;

      case 'recDone':
        this.recordDone?.(message.startPosition);
        this.recordDone = null;
        break;
    }
  }

  private applyTick(tick: Tick): void {
    this.playing = tick.playing;
    this.tickPosition = tick.position;
    this.tickTime = this.context.currentTime;
    this.contentLength = tick.contentLength;

    if (this.recording || tick.recording) {
      this.recordStart = tick.recordStart;

      for (const peak of tick.preview)
        this.previewPeaks.push(peak);
    }

    for (const [id, l, r] of tick.trackPeaks) {
      const peaks = this.trackPeaks.get(id) ?? [0, 0];
      this.trackPeaks.set(id, [Math.max(peaks[0], l), Math.max(peaks[1], r)]);
    }

    this.masterPeaks = [Math.max(this.masterPeaks[0], tick.master[0]), Math.max(this.masterPeaks[1], tick.master[1])];
    this.inputPeaks = [Math.max(this.inputPeaks[0], tick.input[0]), Math.max(this.inputPeaks[1], tick.input[1])];

    for (const listener of [...this.listeners])
      listener();
  }

  getAndResetTrackPeak(trackId: number, channel: number): number {
    const peaks = this.trackPeaks.get(trackId);

    if (peaks === undefined)
      return 0;

    const value = peaks[channel];
    peaks[channel] = 0;
    return value;
  }

  getAndResetMasterPeak(channel: number): number {
    const value = this.masterPeaks[channel];
    this.masterPeaks[channel] = 0;
    return value;
  }

  getAndResetInputPeak(channel: number): number {
    const value = this.inputPeaks[channel];
    this.inputPeaks[channel] = 0;
    return value;
  }

  //============================================================================
  // Pistas y audio

  /** Envía al hilo de audio la lista de pistas (y el audio que aún no tiene). */
  syncTracks(tracks: readonly AudioTrack[]): void {
    const used = new Set<number>();

    for (const track of tracks) {
      for (const source of track.getSources()) {
        used.add(source.id);
        this.upload(source);
      }
    }

    this.post({ type: 'tracks', tracks: tracks.map(t => t.engineState()) });

    // El audio que ya no usa ninguna pista se libera en el hilo de audio (si
    // vuelve con Deshacer, se envía otra vez: la página lo conserva).
    for (const id of [...this.uploaded]) {
      if (!used.has(id)) {
        this.uploaded.delete(id);
        this.post({ type: 'removeSource', id });
      }
    }

    this.contentLength = tracks.reduce((end, t) => Math.max(end, t.getEndSample()), 0);
  }

  private upload(source: ClipSource): void {
    if (this.uploaded.has(source.id))
      return;

    this.uploaded.add(source.id);
    this.post({ type: 'source', id: source.id, left: source.left, right: source.right, length: source.length });
  }

  sendTrackParams(track: AudioTrack): void {
    this.post({ type: 'trackParams', id: track.id, params: track.params() });
  }

  //============================================================================
  // Transporte

  isPlaying(): boolean {
    return this.playing;
  }

  isRecording(): boolean {
    return this.recording;
  }

  /** Posición del cabezal (interpolada entre los tics del hilo de audio). */
  getPosition(): number {
    if (!this.playing)
      return this.tickPosition;

    const elapsed = Math.max(0, (this.context.currentTime - this.tickTime) * this.sampleRate);
    return this.tickPosition + Math.min(elapsed, this.sampleRate * 0.25);
  }

  play(): void {
    void this.resume();
    this.playing = true;
    this.tickTime = this.context.currentTime;
    this.post({ type: 'play' });
  }

  pause(): void {
    this.tickPosition = Math.round(this.getPosition());
    this.playing = false;
    this.post({ type: 'pause' });
  }

  togglePlayPause(): void {
    if (this.playing)
      this.pause();
    else
      this.play();
  }

  stop(): void {
    this.playing = false;
    this.tickPosition = 0;
    this.post({ type: 'stop' });
  }

  setPosition(position: number): void {
    position = Math.max(0, Math.round(position));
    this.tickPosition = position;
    this.tickTime = this.context.currentTime;
    this.post({ type: 'seek', position });
  }

  //============================================================================
  // Micrófono y salida

  hasMicrophone(): boolean {
    return this.micStream !== null;
  }

  /** Abre el micrófono sin supresión de ruido, cancelación de eco ni control
      automático de ganancia (el equivalente al modo RAW de la versión de
      escritorio: esos efectos atenúan o silencian los sonidos constantes). */
  async enableMicrophone(deviceId = this.inputDeviceId): Promise<void> {
    await this.ready;

    const constraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
    };

    if (deviceId !== '')
      constraints.deviceId = { exact: deviceId };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    this.disconnectMicrophone();
    this.micStream = stream;
    this.inputDeviceId = deviceId;
    this.micSource = this.context.createMediaStreamSource(stream);

    if (this.node !== null)
      this.micSource.connect(this.node);
  }

  private disconnectMicrophone(): void {
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach(t => t.stop());
    this.micSource = null;
    this.micStream = null;
  }

  getInputName(): string {
    return this.micStream?.getAudioTracks()[0]?.label ?? '';
  }

  private inputChannelCount(): number {
    const settings = this.micStream?.getAudioTracks()[0]?.getSettings();
    return Math.min(2, Math.max(1, settings?.channelCount ?? 1));
  }

  canChooseOutput(): boolean {
    return typeof this.context.setSinkId === 'function';
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    if (!this.canChooseOutput())
      return;

    await this.context.setSinkId!(deviceId);
    this.outputDeviceId = deviceId;
    this.outputName = deviceId === '' ? defaultOutputName
      : (await this.listDevices()).outputs.find(d => d.deviceId === deviceId)?.label || msg('dispositivo elegido');
  }

  async listDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
    const devices = await navigator.mediaDevices?.enumerateDevices?.() ?? [];
    return {
      inputs: devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'),
      outputs: devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'),
    };
  }

  /** Al conectar o desconectar dispositivos: si el elegido ya no está, se
      vuelve al predeterminado (el navegador sigue solo al del sistema). */
  private async handleDeviceChange(): Promise<void> {
    const { inputs, outputs } = await this.listDevices();

    if (this.outputDeviceId !== '' && !outputs.some(d => d.deviceId === this.outputDeviceId))
      await this.setOutputDevice('').catch(() => undefined);

    const micTrack = this.micStream?.getAudioTracks()[0];

    if (this.micStream !== null && (micTrack?.readyState === 'ended'
        || (this.inputDeviceId !== '' && !inputs.some(d => d.deviceId === this.inputDeviceId))))
      await this.enableMicrophone('').catch(() => this.disconnectMicrophone());
  }

  //============================================================================
  // Grabación

  /** Latencia de ida y vuelta (entrada + salida) en muestras. */
  private latencySamples(): number {
    const settings = this.micStream?.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    const inputLatency = typeof settings?.latency === 'number' ? settings.latency : 0;
    const outputLatency = (this.context.outputLatency || 0) + (this.context.baseLatency || 0);
    return Math.round((inputLatency + outputLatency) * this.sampleRate);
  }

  /** Empieza a grabar (y a reproducir). Devuelve un mensaje de error o ''. */
  async startRecording(): Promise<string> {
    await this.ready;

    if (this.node === null)
      return tr('El motor de audio no está disponible en este navegador.');

    if (this.micStream === null) {
      try {
        await this.enableMicrophone();
      } catch (error) {
        const name = error instanceof DOMException ? error.name : '';
        return name === 'NotAllowedError' || name === 'SecurityError'
          ? tr('El navegador no tiene permiso para usar el micrófono.\n\nPermítelo en el icono del candado de la barra de direcciones y vuelve a pulsar R.')
          : tr('No se encontró ningún micrófono.\n\nConecta uno o elígelo en Audio > Configuración de audio.');
      }
    }

    await this.resume();
    this.recordLatency = this.latencySamples();
    this.recordChunks = [];
    this.previewPeaks = [];
    this.recordStart = -1;
    this.recording = true;
    this.playing = true;
    this.tickTime = this.context.currentTime;
    this.post({ type: 'recordStart', channels: this.inputChannelCount() });
    return '';
  }

  /** Termina la grabación; el audio llega cuando el hilo de audio vacía lo que le queda. */
  stopRecording(): Promise<RecordingInfo> {
    const done = new Promise<number>(resolve => { this.recordDone = resolve; });
    this.post({ type: 'recordStop' });
    this.recording = false;

    return done.then(startPosition => {
      const numChannels = this.recordChunks[0]?.length ?? 1;
      const total = this.recordChunks.reduce((sum, chunk) => sum + chunk[0].length, 0);
      const channels = Array.from({ length: numChannels }, () => allocFloat32(total));
      let offset = 0;

      for (const chunk of this.recordChunks) {
        chunk.forEach((data, ch) => channels[ch].set(data, offset));
        offset += chunk[0].length;
      }

      this.recordChunks = [];
      this.previewPeaks = [];

      return { channels, timelineStart: total > 0 ? startPosition : -1, latencySamples: this.recordLatency, sampleRate: this.sampleRate };
    });
  }

  /** Posición donde quedará la grabación en curso (compensada por latencia),
      o null si todavía no ha llegado audio. Puede ser negativa. */
  getRecordingClipStart(): number | null {
    return this.recordStart < 0 ? null : this.recordStart - this.recordLatency;
  }

  /** Picos nuevos de la grabación en curso desde la última lectura. */
  readRecordingPeaks(): number[] {
    const peaks = this.previewPeaks;
    this.previewPeaks = [];
    return peaks;
  }
}
