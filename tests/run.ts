/**
    Pruebas automáticas de StemLab Web (sin navegador): DSP, mezclador,
    edición de fragmentos, historial, proyecto y WAV.

        npm test

    Cada comprobación imprime "ok:" o "FALLO:". Al final aparece
    "RESULTADO: n/m" y el código de salida es 0 solo si todo pasó.
*/
import { EffectChain } from '../src/dsp/effects.ts';
import { MixerCore, type TrackState } from '../src/dsp/mixerCore.ts';
import { defaultEffectsState } from '../src/dsp/effectDefs.ts';
import { ClipEditing, createClipId, createSource, type AudioClip } from '../src/model/clip.ts';
import { UndoManager } from '../src/model/undo.ts';
import { ProjectManager } from '../src/model/project.ts';
import type { AudioEngine } from '../src/audio/engine.ts';
import { encodeWav } from '../src/audio/wav.ts';
import { Parameter } from '../src/core/parameter.ts';
import { NormalisableRange } from '../src/core/range.ts';
import { formatTime, stemDisplayName } from '../src/core/strings.ts';
import { getLanguage, languages, setLanguage, tr, trMatching } from '../src/core/i18n.ts';
import { en } from '../src/core/lang/en.ts';
import { trackColourFor } from '../src/ui/colour.ts';
import { normaliseServerUrl } from '../src/ai/serverConfig.ts';
import { detectDesktopPlatform, installerFromRelease, latestInstallerUrl } from '../src/ui/desktopDownload.ts';

let passed = 0, total = 0;

function check(name: string, condition: boolean, detail = ''): void {
  ++total;

  if (condition) {
    ++passed;
    console.log('ok:    ' + name);
  } else {
    console.log('FALLO: ' + name + (detail !== '' ? '  (' + detail + ')' : ''));
  }
}

const near = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const rate = 48000;

function sine(length: number, frequency: number, amplitude: number): Float32Array {
  const data = new Float32Array(length);

  for (let i = 0; i < length; ++i)
    data[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);

  return data;
}

function source(length: number, amplitude = 0.5, frequency = 440) {
  const left = sine(length, frequency, amplitude);
  return createSource('prueba', left, left, rate, null);
}

function clip(src: ReturnType<typeof source>, start: number, offset: number, length: number): AudioClip {
  return { id: createClipId(), source: src, timelineStart: start, sourceOffset: offset, length };
}

//==============================================================================
console.log('--- Edición de fragmentos');
{
  const src = source(10000);
  const clips = [clip(src, 1000, 0, 4000)];
  const right = ClipEditing.split(clips, clips[0].id, 3000);
  check('dividir crea la mitad derecha', right !== 0 && clips.length === 2);
  check('mitades contiguas', clips[0].length === 2000 && clips[1].timelineStart === 3000 && clips[1].sourceOffset === 2000);
  check('no se divide junto al borde', ClipEditing.split(clips, clips[0].id, 1010) === 0);

  const trimmed = { ...clips[1] };
  ClipEditing.trimStart(trimmed, 0);
  check('recortar el principio no pasa del audio original', trimmed.timelineStart === 1000 && trimmed.sourceOffset === 0);
  ClipEditing.trimEnd(trimmed, 100000);
  check('recortar el final no pasa del audio original', trimmed.sourceOffset + trimmed.length === 10000);

  const free = [clip(src, 0, 0, 1000), clip(src, 2000, 0, 1000)];
  check('hueco libre: justo después del audio del cabezal', ClipEditing.findFreeSpace(free, 500, 1) === 1000);
  check('hueco libre: salta si no cabe', ClipEditing.findFreeSpace(free, 500, 1500) === 3000);
  const [gapStart, gapEnd] = ClipEditing.freeGapAt(free, 1200);
  check('hueco alrededor', gapStart === 1200 && gapEnd === 2000);

  // Mover sin solaparse: se detiene, salta y abre espacio.
  const a = clip(src, 0, 0, 1000), b = clip(src, 1500, 0, 1000), c = clip(src, 2600, 0, 1000);
  let moved = ClipEditing.moveWithoutOverlap([a, b, c], a.id, 900);
  check('mover: se detiene contra el vecino', ClipEditing.find(moved, a.id)!.timelineStart === 500);
  moved = ClipEditing.moveWithoutOverlap([a, b, c], a.id, 1700);
  const movedA = ClipEditing.find(moved, a.id)!, movedC = ClipEditing.find(moved, c.id)!;
  check('mover: salta al otro lado del vecino', movedA.timelineStart === 2500, String(movedA.timelineStart));
  check('mover: los de delante se apartan juntos', movedC.timelineStart === 3500, String(movedC.timelineStart));
  check('mover: la lista original no cambia', a.timelineStart === 0 && c.timelineStart === 2600);

  const take = clip(src, 800, 0, 5000);
  check('grabación: se ajusta al hueco libre', ClipEditing.fitIntoFreeSpace(free, take) && take.timelineStart === 1000
        && take.length === 1000 && take.sourceOffset === 200);
}

//==============================================================================
console.log('--- Historial');
{
  const undo = new UndoManager();
  let value = 0;
  const add = (n: number) => ({ perform: () => { value += n; return true; }, undo: () => { value -= n; return true; } });

  undo.beginNewTransaction('uno');
  undo.perform(add(1));
  undo.perform(add(2));
  undo.beginNewTransaction('dos');
  undo.perform(add(10));
  check('las acciones se aplican', value === 13);
  check('descripción del deshacer', undo.getUndoDescription() === 'dos');
  undo.undo();
  undo.undo();
  check('deshacer una transacción entera', value === 0 && !undo.canUndo());
  undo.redo();
  check('rehacer', value === 3 && undo.getRedoDescription() === 'dos');
  undo.beginNewTransaction('tres');
  undo.perform(add(100));
  check('una acción nueva borra lo que se podía rehacer', !undo.canRedo() && value === 103);
}

//==============================================================================
console.log('--- Parámetros');
{
  const volume = Parameter.continuous('volume', 'Volumen', new NormalisableRange(-60, 12, 0.1, 2), 0, 'dB');
  volume.set(3.14159);
  check('ajuste al paso', near(volume.get(), 3.1, 1e-9));
  check('skew: ida y vuelta', near(volume.range.convertFrom0to1(volume.range.convertTo0to1(-20)), -20, 1e-9));
  const frequency = Parameter.fromDef({ id: 'f', name: 'F', kind: 'continuous', min: 20, max: 1000, interval: 1,
                                        centre: Math.sqrt(20000), defaultValue: 120, unit: 'Hz' });
  check('centro geométrico en la mitad', near(frequency.range.convertFrom0to1(0.5), Math.sqrt(20000), 1e-6));
  frequency.set(1000);
  check('texto en kHz', frequency.toText() === '1.00 kHz', frequency.toText());
  check('formato de tiempo', formatTime(83.456) === '01:23.456');
}

//==============================================================================
console.log('--- Efectos');
{
  const block = 512;
  const run = (setup: (chain: EffectChain) => void, amplitude: number, frequency = 1000) => {
    const chain = new EffectChain();
    setup(chain);
    chain.prepare(rate);
    const input = sine(block * 40, frequency, amplitude);
    const left = new Float32Array(block), right = new Float32Array(block);
    let peak = 0;

    for (let offset = 0; offset < input.length; offset += block) {
      left.set(input.subarray(offset, offset + block));
      right.set(input.subarray(offset, offset + block));
      chain.process(left, right, block);

      if (offset >= block * 20)
        for (let i = 0; i < block; ++i)
          peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }

    return peak;
  };

  const effects = (chain: EffectChain, id: string, enabled: boolean, params: Record<string, number> = {}) => {
    const state = defaultEffectsState();
    state[id].enabled = enabled;
    Object.assign(state[id].params, params);
    chain.setState(state);
  };

  check('cadena por defecto: transparente', near(run(() => undefined, 0.5), 0.5, 1e-3));
  check('Gain +6 dB duplica', near(run(c => effects(c, 'gain', true, { gain: 6.0206 }), 0.25), 0.5, 2e-3));
  check('EQ a 0 dB: transparente', near(run(c => effects(c, 'eq', true), 0.5), 0.5, 2e-3));
  check('EQ: agudos +12 dB suben 8 kHz', run(c => effects(c, 'eq', true, { highGain: 12, highFreq: 1000 }), 0.1, 8000) > 0.3);
  check('EQ: agudos +12 dB no tocan 100 Hz', near(run(c => effects(c, 'eq', true, { highGain: 12, highFreq: 8000 }), 0.1, 100), 0.1, 3e-3));
  const limited = run(c => effects(c, 'limiter', true, { input: 12, ceiling: -6 }), 0.9);
  check('Limiter: nunca pasa del techo', limited <= 0.5012 + 1e-4, limited.toFixed(4));
  check('Compresor: reduce los picos', run(c => effects(c, 'compressor', true, { threshold: -30, ratio: 8 }), 0.9) < 0.5);
  check('Saturación dura: recorta a 1', run(c => effects(c, 'saturation', true, { mode: 1, drive: 24, mix: 100 }), 0.9) <= 1 + 1e-6);
}

//==============================================================================
console.log('--- Mezclador');
{
  const length = rate;
  const song = sine(length, 220, 0.3);
  const stemA = new Float32Array(length), stemB = new Float32Array(length);

  for (let i = 0; i < length; ++i) {
    stemA[i] = song[i] * 0.7;
    stemB[i] = song[i] * 0.3;
  }

  const core = new MixerCore();
  core.prepare(rate, 128);
  core.sources.set(1, { left: song, right: song, length });
  core.sources.set(2, { left: stemA, right: stemA, length });
  core.sources.set(3, { left: stemB, right: stemB, length });

  const track = (id: number, sourceId: number, extra: Partial<TrackState> = {}): TrackState => ({
    id, volume: 0, pan: 0, mute: false, solo: false, effects: defaultEffectsState(),
    clips: [{ sourceId, timelineStart: 0, sourceOffset: 0, length }], ...extra,
  });

  const render = (tracks: TrackState[]) => {
    const mixer = new MixerCore();
    mixer.prepare(rate, 128);
    mixer.sources.set(1, core.sources.get(1)!);
    mixer.sources.set(2, core.sources.get(2)!);
    mixer.sources.set(3, core.sources.get(3)!);
    mixer.setTracks(tracks);
    const out = new Float32Array(length);
    const l = new Float32Array(128), r = new Float32Array(128);

    for (let position = -2048; position < length; position += 128) {
      mixer.render(l, r, 128, position, true);

      if (position >= 0)
        out.set(l.subarray(0, Math.min(128, length - position)), position);
    }

    return { out, mixer };
  };

  const original = render([track(1, 1)]).out;
  const stems = render([track(2, 2), track(3, 3)]).out;
  let maxDiff = 0;

  for (let i = 1000; i < length - 1000; ++i)
    maxDiff = Math.max(maxDiff, Math.abs(original[i] - stems[i]));

  check('la suma de los stems reproduce la canción', maxDiff < 1e-5, maxDiff.toExponential(2));
  check('el paneo centrado deja ganancia unidad', near(Math.max(...original.subarray(1000, 5000)), 0.3, 2e-3));
  check('mute silencia', Math.max(...render([track(1, 1, { mute: true })]).out.subarray(4000).map(Math.abs)) < 1e-6);
  const solo = render([track(2, 2, { solo: true }), track(3, 3)]).out;
  check('solo: solo suena la pista en solo', near(Math.max(...solo.subarray(4000, 20000)), 0.21, 2e-3));
  check('fundido en el borde del clip', Math.abs(original[0]) < 1e-9);
  const { mixer } = render([track(1, 1)]);
  check('duración del contenido', mixer.contentLength === length);
}

//==============================================================================
console.log('--- Proyecto');
{
  const fakeEngine = {
    sampleRate: rate,
    syncTracks: () => undefined,
    sendTrackParams: () => undefined,
    stop: () => undefined,
    masterVolume: Parameter.continuous('m', 'Master', new NormalisableRange(-60, 6, 0.1, 2), 0, 'dB'),
  } as unknown as AudioEngine;

  const project = new ProjectManager(fakeEngine);
  const src = source(rate * 2);
  project.addTracks([{ name: 'Canción', source: src, startSample: 0 }], 'Importar audio');
  check('importar crea la pista', project.tracks.length === 1 && project.getContentLength() === rate * 2);

  const empty = project.addEmptyTrack('Pista');
  check('nombres numerados', empty.name === 'Pista 1');
  project.removeTrack(empty);
  project.undo();
  check('deshacer devuelve la pista eliminada', project.tracks.includes(empty));

  const copy = project.pasteTrack(project.tracks[0]);
  check('pegar pista: nombre "(copia)" y clips con ids nuevos', copy.name === 'Canción (copia)'
        && copy.getClips()[0].id !== project.tracks[0].getClips()[0].id);

  // Carpeta de una separación.
  project.addFolder({ id: 'f1', name: 'Canción', colour: null as never, expanded: true, stems: ['vocals', 'drums'],
                      source: src, sourceStart: 0, sourceLength: src.length });
  project.addTracks([
    { name: 'Voz', source: source(rate), startSample: 0, folderId: 'f1', stemGroup: 'f1', stemId: 'vocals' },
    { name: 'Batería', source: source(rate), startSample: 0, folderId: 'f1', stemGroup: 'f1', stemId: 'drums' },
  ], 'Separar instrumentos');
  check('las pistas de la separación quedan en su carpeta', project.getFolderTracks('f1').length === 2);
  project.undo();
  check('la separación se deshace en un paso', project.getFolderTracks('f1').length === 0);
  project.redo();

  const voice = project.getFolderTracks('f1')[0];
  project.moveTrackToFolder(voice, '', 0);
  check('sacar de la carpeta', voice.folderId === '' && project.getStemTracks('f1').length === 2);
  project.undo();
  check('deshacer vuelve a meterla', voice.folderId === 'f1');

  project.removeFolder('f1');
  check('eliminar carpeta quita sus pistas', project.findFolder('f1') === undefined && !project.tracks.includes(voice));
  project.undo();
  check('deshacer devuelve la carpeta entera', project.findFolder('f1') !== undefined && project.getFolderTracks('f1').length === 2);

  // Grabación: nunca tapa el audio que ya tiene la pista (se recorta al hueco
  // libre donde empieza) y se compensa por la latencia.
  const target = project.tracks[0];
  const hidden = project.addRecording({ channels: [sine(rate, 330, 0.2)], timelineStart: rate, latencySamples: 480, sampleRate: rate }, target);
  check('una toma que cae entera sobre audio no se añade', !hidden.ok && target.getClips().length === 1);
  const recorded = sine(rate * 2, 330, 0.2);
  const result = project.addRecording({ channels: [recorded], timelineStart: rate, latencySamples: 480, sampleRate: rate }, target);
  const clips = target.getClips();
  check('la grabación se añade a la pista', result.ok && clips.length === 2);
  check('la toma empieza donde acaba el audio', clips[1].timelineStart === rate * 2 && clips[1].sourceOffset === rate + 480,
        `${clips[1].timelineStart} ${clips[1].sourceOffset}`);
  check('grabar se deshace', project.undo() && target.getClips().length === 1);
}

//==============================================================================
console.log('--- WAV');
{
  const data = sine(1000, 440, 0.5);
  const sizes = await Promise.all(([16, 24, 32] as const).map(bits => encodeWav([data, data], rate, bits).arrayBuffer()));
  check('tamaños de WAV 16 / 24 / 32 bits', sizes[0].byteLength === 44 + 4000 && sizes[1].byteLength === 44 + 6000
        && sizes[2].byteLength === 44 + 8000);
  const view = new DataView(sizes[2]);
  check('WAV 32 bits en coma flotante', view.getUint16(20, true) === 3 && near(view.getFloat32(44 + 8 * 10, true), data[10], 1e-7));
}

//==============================================================================
console.log('--- Servidor de separación y StemLab de escritorio');
{
  check('dirección local sin protocolo: http', normaliseServerUrl(' localhost:8000/ ') === 'http://localhost:8000');
  check('dirección pública sin protocolo: https, sin /api', normaliseServerUrl('separacion.example.com/api/') === 'https://separacion.example.com');
  check('vacía: esta misma web', normaliseServerUrl('') === '');

  const release = {
    tag_name: 'v0.2.0',
    assets: [
      { name: 'notas.txt', browser_download_url: 'https://example.com/notas.txt', size: 10 },
      { name: 'StemLab-Setup.exe', browser_download_url: 'https://example.com/StemLab-Setup.exe', size: 314572800 },
    ],
  };
  const installer = installerFromRelease(release);
  check('release con instalador: versión, enlace y tamaño', installer?.version === '0.2.0'
        && installer.url === 'https://example.com/StemLab-Setup.exe' && installer.sizeBytes === 314572800);
  check('release sin instalador: nada que descargar', installerFromRelease({ tag_name: 'v0.2.0', assets: [release.assets[0]] }) === null);
  check('respuesta inesperada de la API: nada que descargar', installerFromRelease(null) === null
        && installerFromRelease({ message: 'Not Found' }) === null);

  // Linux: el mismo criterio con su archivo.
  check('release sin paquete de Linux (la 0.1.0): solo Windows', installerFromRelease(release, 'linux') === null);
  const both = { ...release, assets: [...release.assets, { name: 'StemLab-Linux-x86_64.tar.gz', browser_download_url: 'https://example.com/linux.tar.gz', size: 400000000 }] };
  check('release con las dos descargas', installerFromRelease(both, 'linux')?.url === 'https://example.com/linux.tar.gz'
        && installerFromRelease(both, 'windows')?.url === 'https://example.com/StemLab-Setup.exe');
  check('enlaces a la última release', latestInstallerUrl('windows').endsWith('/releases/latest/download/StemLab-Setup.exe')
        && latestInstallerUrl('linux').endsWith('/releases/latest/download/StemLab-Linux-x86_64.tar.gz'));
  check('se ofrece primero la descarga de la plataforma de quien visita',
        detectDesktopPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36') === 'windows'
        && detectDesktopPlatform('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0') === 'linux'
        && detectDesktopPlatform('Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36') === 'linux');
  check('y ninguna en macOS, Android o iPhone (no hay StemLab de escritorio para ellos)',
        detectDesktopPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15') === null
        && detectDesktopPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36') === null
        && detectDesktopPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148') === null);
}

//==============================================================================
console.log('--- Idiomas');
{
  // Los textos de la interfaz salen del propio código: tr('...'), L('...') y msg('...').
  const specifier = './i18nKeys.mjs';
  const { collectInterfaceTexts } = await import(specifier) as { collectInterfaceTexts(directory: string): string[] };
  const texts = collectInterfaceTexts(decodeURIComponent(new URL('../src', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
  const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(m => m[0]).sort().join();

  check('se encuentran los textos de la interfaz', texts.length > 300, String(texts.length));

  for (const [name, dictionary] of [['en', en]] as const) {
    const missing = texts.filter(text => dictionary[text] === undefined);
    check(`${name}: todos los textos tienen traducción`, missing.length === 0, missing.slice(0, 5).join(' | '));

    const unused = Object.keys(dictionary).filter(key => !texts.includes(key));
    check(`${name}: no sobran traducciones de textos que ya no existen`, unused.length === 0, unused.slice(0, 5).join(' | '));

    const different = Object.entries(dictionary).filter(([key, value]) => placeholders(key) !== placeholders(value)).map(([key]) => key);
    check(`${name}: cada traducción usa los mismos {n} que su texto`, different.length === 0, different.slice(0, 3).join(' | '));

    const lines = Object.entries(dictionary).filter(([key, value]) => key.split('\n').length !== value.split('\n').length).map(([key]) => key);
    check(`${name}: mismos saltos de línea (párrafos de los diálogos)`, lines.length === 0, lines.slice(0, 3).join(' | '));
  }

  check('por defecto, español: el texto del código', getLanguage() === 'es' && tr('Añadir pista') === 'Añadir pista');
  check('datos variables', tr('Pista "{0}" eliminada. Ctrl+Z la recupera.', 'Voz') === 'Pista "Voz" eliminada. Ctrl+Z la recupera.');

  setLanguage('en');
  check('inglés', tr('Añadir pista') === 'Add track' && tr('{0} pistas', 4) === '4 tracks');
  check('un texto sin traducción se queda como está', tr('Mi canción') === 'Mi canción');
  check('los stems, en el idioma elegido', stemDisplayName('vocals') === 'Vocals' && stemDisplayName('drums') === 'Drums');
  check('los mensajes del servidor se traducen por su plantilla',
        trMatching('Cargando modelo htdemucs en cpu (la primera vez se descarga)...',
                   ['Leyendo {0}...', 'Cargando modelo {0} en {1} (la primera vez se descarga)...'])
          === 'Loading model htdemucs on cpu (it is downloaded the first time)...'
        && trMatching('Algo que el servidor no avisó', ['Leyendo {0}...']) === 'Algo que el servidor no avisó');
  check('las pistas conservan su color en cualquier idioma',
        trackColourFor('Vocals', 3).equals(trackColourFor('Voz', 0)) && trackColourFor('Recording 2', 1).equals(trackColourFor('Grabación', 0)));

  setLanguage('es');
  check('todos los idiomas tienen nombre', languages.every(language => language.name !== ''));
}

console.log(`\nRESULTADO: ${passed}/${total}`);
// Node: el código de salida indica si todo pasó.
(globalThis as unknown as { process: { exit(code: number): void } }).process.exit(passed === total ? 0 : 1);
