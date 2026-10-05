# StemLab Web

Versión web de [StemLab](https://github.com/Andres-Maya/StemLab): mini-DAW en el navegador para **cargar una canción,
separarla en instrumentos con IA, editar cada pista, grabar nuevas pistas, aplicar efectos, mezclar y descargar el resultado**.

- **TypeScript + Web Audio (AudioWorklet)**: interfaz, motor de audio en tiempo real, DSP y edición. Es el mismo diseño
  que la versión de escritorio (C++/JUCE), portado muestra a muestra.
- **Python + PyTorch + Demucs**: solo la separación de fuentes, en un servidor pequeño que usa el mismo script que la
  versión de escritorio.

```
Archivo/Grabación → Gain → Saturación → EQ → Compresor → Limiter → Mixer → Salida
```

### Diferencias con StemLab de escritorio

| | Escritorio | Web |
|---|---|---|
| Guardar | proyectos `.stemlab` en disco | **no se guarda nada en la nube**: la sesión vive en la pestaña y el trabajo se **descarga** |
| Descargar | Exportar mezcla (WAV / MP3) | **Exportar / descargar**: la mezcla, una pista, las pistas de una carpeta o todas por separado (WAV 16/24/32 bits, MP3 320/192/128 kbps, varias pistas en `.zip`) |
| Ventana de la separación | ventana aparte | **pantalla dentro de la misma pestaña**, encima del proyecto; se cierra con **Esc** o **Volver al proyecto** y la separación sigue |
| MP3 | Python (LAME) | en el navegador (LAME en JavaScript) |
| Añadir pista | Ctrl+T | **T** (el navegador reserva Ctrl+T) |
| Micrófono | modo RAW de WASAPI | sin supresión de ruido, cancelación de eco ni control automático de ganancia (lo mismo, pedido al navegador) |

Al cerrar o recargar la pestaña con pistas, el navegador pide confirmación: lo que no se haya descargado se pierde.

**StemLab para Windows** (botón de la barra superior, o **Ayuda → Descargar StemLab para Windows**) descarga el
instalador de la versión de escritorio: guarda proyectos y separa en el propio equipo, sin servidor (lleva Python y
Demucs). El `.exe` no está en esta web: lo publica el repositorio de StemLab en sus
[releases](https://github.com/Andres-Maya/StemLab/releases/latest) y la web muestra siempre la última versión.

---

## Arquitectura

```
src/
  main.ts · app.ts        arranque y ventana principal (menús, atajos, grabar, separar, exportar)
  audio/  engine.ts       AudioContext + AudioWorklet; transporte, micrófono y grabación (página)
          engine.worklet  hilo de audio: cabezal, mezcla, entrada con ganancia y grabación
          decode.ts       decodifica archivos (el navegador remuestrea a la frecuencia del motor)
          peaks.ts        resumen min/max para dibujar las ondas · wav.ts  WAV 16/24/32 bits
          memory.ts       audio en SharedArrayBuffer (sin copias entre página, worklet y worker)
  dsp/    effects.ts      Gain · Saturation · Equalizer · Compressor · Limiter · EffectChain
          mixerCore.ts    pistas + bus master: lo usan el AudioWorklet y la exportación
          effectDefs.ts   parámetros de cada efecto (la interfaz se genera a partir de ellos)
  model/  clip.ts         clips y edición no destructiva (dividir, recortar, mover sin solaparse)
          track.ts        pista (clips, volumen, paneo, mute, solo, efectos) y carpeta
          project.ts      sesión: pistas, carpetas, grabaciones, deshacer/rehacer
          undo.ts         historial por transacciones
  ai/     separator.ts    cliente del servidor de separación (subir, progreso, descargar stems)
          serverConfig.ts dirección del servidor de separación (misma web, este equipo u otro)
  export/ export.worker   render fuera de tiempo real en un Web Worker (WAV, MP3, ZIP)
  ui/     trackList · trackRow · waveformLane · timeRuler · mixerView · transportBar · statusBar
          separationScreen (pantalla de ondas) · exportDialog · audioSettings · serverDialog · menu · dialogs · controls
          desktopDownload (StemLab para Windows: la última release del instalador)
server/
  stemlab_server.py       sirve la aplicación compilada y separa con Demucs (solo biblioteca estándar)
  stemlab_separate.py     copia idéntica del script de StemLab de escritorio (la web usa --format flac)
tests/run.ts              pruebas automáticas (ver "Pruebas")
```

### Hilos (como en la versión de escritorio)

| Hilo | Qué hace | Qué **no** hace nunca |
|---|---|---|
| **Audio** (`engine.worklet.ts`) | mezclar, aplicar efectos, ganancia y limitador suave de la entrada, copiar la grabación a la página | reservar memoria en cada bloque, esperar a la página |
| **Página** (interfaz) | interfaz, crear/quitar pistas, decodificar archivos | procesar audio en tiempo real |
| **Exportación** (`export.worker.ts`) | renderizar una copia de la mezcla y codificar WAV / MP3 / ZIP | tocar el motor de audio (se puede seguir escuchando) |
| **IA** (servidor) | Demucs en un proceso de Python | — |

- **Cabezal único**: todas las pistas leen la misma posición en el hilo de audio, así que los stems están alineados a nivel de muestra. Los saltos se aplican al empezar el siguiente bloque.
- **Audio en memoria**: cada archivo se decodifica completo a la frecuencia del dispositivo. Con aislamiento de origen (COOP/COEP, que ponen el servidor y Vite) vive en `SharedArrayBuffer` y lo leen la página, el worklet y el worker sin copiarlo.
- **Exportación**: el worker usa el mismo `MixerCore` que el hilo de audio, así que el archivo suena exactamente como lo que se oye.
- **Deshacer/rehacer**: se guarda la lista de clips de antes y de después de cada edición; los clips comparten el audio, así que cada paso ocupa muy poco.

### Navegador ↔ servidor de separación

```
POST   /api/separations?model=htdemucs&name=cancion.mp3    cuerpo = el archivo  → {"id": ...}
GET    /api/separations/<id>/events                        progreso (Server-Sent Events)
GET    /api/separations/<id>/stems/vocals                  descargar un stem (FLAC 24 bits)
DELETE /api/separations/<id>                               cancelar y borrar sus archivos
```

El servidor ejecuta `python -u -X utf8 stemlab_separate.py --input X --output DIR --model M --format flac` y traduce su
protocolo (`@@STATUS`, `@@PROGRESS`, `@@STEM`, `@@DONE`, `@@ERROR`) a eventos. Cada separación trabaja en una carpeta
temporal que se borra en cuanto el navegador descarga los stems (o al cancelar, a los 30 minutos si nadie los pide, o al
cerrar el servidor). Se hace una separación a la vez; las demás esperan en cola.

---

## Poner en marcha

Requisitos: **Node.js 22.18 o posterior** (las pruebas se ejecutan con el TypeScript nativo de Node) y **Python 3.11 o 3.12** con Demucs (el mismo entorno que StemLab de escritorio).

### Entorno de IA (Python)

Si ya tienes el de StemLab de escritorio (`python/.venv`), sirve tal cual. Si no:

```powershell
py -3.12 -m venv server\.venv
server\.venv\Scripts\python -m pip install --upgrade pip
# PyTorch: versión CPU. Para GPU NVIDIA, usa el comando de https://pytorch.org/get-started/locally/
server\.venv\Scripts\python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
server\.venv\Scripts\python -m pip install -r server\requirements.txt
server\.venv\Scripts\python server\stemlab_separate.py --check
```

La primera separación descarga el modelo (unos 80 MB para `htdemucs`). **FFmpeg** es opcional: solo para formatos que
libsndfile no lee (m4a, aac...). El servidor usa el Python con el que se ejecuta; otro se elige con `--python` o con la
variable `STEMLAB_PYTHON`.

### Usarla (una sola orden)

```powershell
npm install
npm run build
server\.venv\Scripts\python server\stemlab_server.py
```

Abre **http://localhost:8000**. Con `--host 0.0.0.0` se abre a la red local (el micrófono solo funciona en
`localhost` o con HTTPS).

### Desarrollo

```powershell
npm install
server\.venv\Scripts\python server\stemlab_server.py     # en una terminal: la separación
npm run dev                                              # en otra: http://localhost:5173
```

Vite recarga la página al guardar y reenvía `/api` al servidor de Python.

### Desplegar en Vercel

Vercel sirve solo la web (Demucs y PyTorch no caben en sus funciones). La separación la hace el servidor de Python en
otro sitio, y la web se conecta a él:

| Campo en Vercel | Valor |
|---|---|
| Framework Preset | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js Version | 22.x |
| Variable `VITE_SEPARATION_URL` (opcional) | dirección pública del servidor de separación, p. ej. `https://separacion.midominio.com` |

`vercel.json` ya añade las cabeceras de aislamiento de origen. Dónde puede estar el servidor de separación:

- **En tu equipo**: arranca `python server/stemlab_server.py` y en la web elige **IA → Servidor de separación… → Usar
  este equipo (localhost:8000)**. La dirección se recuerda en ese navegador. La primera vez, Chrome o Edge pueden pedir
  permiso para acceder a la red local.
- **En un servidor propio** (VPS, Render, Railway, Fly.io…; conviene 4 GB de RAM o más, y GPU para que sea rápido):
  `python server/stemlab_server.py --host 0.0.0.0 --allow-origin https://tu-web.vercel.app`, detrás de HTTPS (una web
  HTTPS no puede usar un servidor HTTP que no sea `localhost`). Su dirección va en `VITE_SEPARATION_URL` o en **IA →
  Servidor de separación…**. El puerto se toma de `--port` o de la variable `PORT`.

La API admite peticiones de otros orígenes (CORS); `--allow-origin` (se puede repetir) la limita a tus webs.

Navegadores: Chrome, Edge, Firefox o Safari recientes (AudioWorklet). Elegir la salida de audio solo es posible en
los navegadores basados en Chromium (Chrome, Edge); en el resto se usa la del sistema.

---

## Uso

1. **Archivo → Importar audio…** (**Ctrl+I**), o arrastra archivos a la página (WAV, MP3, FLAC, OGG, M4A... lo que decodifique el navegador).
2. **IA → Separar instrumentos**. Se abre la **pantalla de la separación**, dentro de la misma pestaña:
   - En el centro, el **porcentaje**. Lo rodea el **anillo de frecuencias** del color de la pista que se separa: dibuja la propia canción en tiempo real, con picos donde hay golpes, voces o platillos.
   - Según avanza, sale del centro la **onda** de cada pista que se va a generar (Voz, Batería, Bajo…). Con 4 pistas aparecen al 20, 40, 60 y 80 %.
   - **Cancelar separación** la detiene. **Volver al proyecto** (o **Esc**) solo oculta la pantalla: la separación sigue, con el porcentaje y **Ver progreso** en la barra de estado (también en **IA → Mostrar progreso de la separación**). Mientras se ve la pantalla, **Espacio** reproduce o pausa.
   - Al terminar aparecen todas las ondas y la pantalla **se queda abierta**. Las pistas nuevas quedan dentro de una **carpeta** con el nombre de la canción y la pista original se silencia.
   - El botón **Ondas** de la carpeta abre y cierra esa pantalla mientras exista alguna pista de la separación. Si eliminas una pista, su onda desaparece; si lo deshaces, vuelve.
   - Modelo, en el mismo menú: `htdemucs` (4 pistas), `htdemucs_ft` (4 pistas, más calidad y más lento), `htdemucs_6s` (6 pistas, añade guitarra y piano).
3. Cada pista tiene Mute, Solo, volumen y paneo. Al seleccionarla, el mezclador muestra su canal y su cadena de efectos.
4. **Grabar:** selecciona una pista y pulsa ⏺ o **R**. Si no hay ninguna pista no se graba nada (ni corre el cabezal): StemLab ofrece añadir una, y la grabación empieza al pulsar **R** sobre ella. La primera vez el navegador pide permiso para el micrófono.
   - La toma empieza en el cabezal; si hay audio ahí, justo después. En una pista los fragmentos **nunca se solapan**: para grabar encima, usa otra pista (**+** o **T**).
   - Pausar (**R** o Espacio) y volver a pulsar **R** sigue grabando en la misma pista. Mientras se graba, el cabezal no se mueve.
   - **Entrada** (barra superior): ganancia del micrófono, +18 dB por defecto, con su medidor y un limitador suave. La grabación se compensa por la latencia del dispositivo.
   - **Audio → Configuración de audio**: micrófono y salida.
5. **Editar fragmentos** (no destructivo): clic para seleccionar y mover el cabezal, arrastrar el centro para desplazar (el fragmento se levanta, se detiene contra su vecino, salta al otro lado y abre espacio), arrastrar un borde para recortar, **S** divide, **Ctrl+X / C / V** cortan, copian y pegan, **Supr** elimina, clic derecho (o pulsación larga) abre el menú. Todo se deshace con **Ctrl+Z** y se rehace con **Ctrl+Y**.
6. **Pistas y carpetas:** el **+** del borde de cada pista añade otra debajo; arrastra la cabecera para moverla (o **Alt+↑ / Alt+↓**), para meterla en una carpeta o sacarla; doble clic o **F2** para el nombre; la **×** la elimina (con confirmación). La cabecera de la carpeta se pliega con un clic; su menú (clic derecho) permite abrir las ondas, descargar sus pistas y eliminarla.
7. **Zoom:** **Ctrl + rueda** alrededor del ratón, **Shift + rueda** a los lados, o **Proyecto → Vista**. Al reproducir, la vista sigue al cabezal.
8. **Archivo → Exportar / descargar…** (**Ctrl+E**), también en el menú de cada pista y de cada carpeta:
   - **Mezcla completa**, tal como suena (volumen, paneo, mute, solo, efectos y master), desde el principio hasta el final del último fragmento.
   - **Pista seleccionada** (una grabación, un stem...), con sus efectos, volumen y paneo.
   - **Carpeta** o **todas las pistas por separado**, en un `.zip`: cada pista en su archivo, todas de la misma duración para que queden alineadas en otro programa.
   - Formatos: WAV de 24 bits (recomendado), 16 bits o 32 bits en coma flotante, y MP3 a 320, 192 o 128 kbps. Se guarda en la carpeta de descargas del navegador. **Cancelar** no deja nada a medias. Si el audio pasa de 0 dBFS se avisa del recorte (el WAV de 32 bits no recorta).
9. **Archivo → Nuevo proyecto** descarta la sesión (antes ofrece descargar).
10. **Ver → Tema** cambia entre el tema **oscuro** y el **claro**, y **Ver → Idioma** entre **español** e **inglés** (también con los botones de la esquina superior derecha). El cambio es inmediato, no toca la sesión y se recuerda en el navegador; la primera vez se usa el idioma del navegador.
11. **Ayuda → Tutorial** recorre la aplicación parte por parte: ilumina cada zona y explica al lado qué hace (→ o Intro: siguiente; ←: atrás; Esc: salir). Se abre solo la primera vez que entras, y en su primer paso deja elegir idioma y tema.

Para añadir un idioma: un diccionario como `src/core/lang/en.ts` (la clave es el texto en español del código) y su entrada en `languages` de `src/core/i18n.ts`. `npm test` avisa de los textos que falten.

| Tecla | Acción |
|---|---|
| Espacio | reproducir / pausa |
| Inicio | ir al principio |
| R | grabar / pausar la grabación (en la pista seleccionada) |
| S | dividir el fragmento en el cabezal |
| Ctrl+Z | deshacer |
| Ctrl+Y / Ctrl+Shift+Z | rehacer |
| Ctrl+X / C / V | cortar / copiar / pegar el fragmento seleccionado, o la pista entera si no hay fragmento seleccionado |
| Supr / Retroceso | eliminar el fragmento seleccionado, o la pista si no hay fragmento seleccionado (pide confirmación) |
| T | añadir pista (debajo de la seleccionada) |
| F2 | cambiar el nombre de la pista seleccionada |
| Alt+↑ / Alt+↓ | subir / bajar la pista seleccionada |
| Ctrl+Supr | eliminar la pista seleccionada |
| Ctrl+I | importar audio |
| Ctrl+E | exportar / descargar |
| Esc | cerrar la pantalla de la separación (sigue separando) |

---

## Pruebas

```powershell
npm test          # DSP, mezclador, clips, historial, proyecto, carpetas, grabación, WAV, servidor, instalador e idiomas (Node)
npm run build     # comprueba los tipos y compila
```

Cada comprobación imprime `ok:` o `FALLO:`. Al final aparece `RESULTADO: n/m`, y el código de salida es 0 solo si todo pasó.

## Limitaciones conocidas

- **Memoria**: el audio se guarda en memoria como float estéreo (unos 23 MB por minuto y pista a 48 kHz). En móviles, las canciones largas con muchas pistas pueden agotar la memoria de la pestaña.
- **Sin proyectos**: la sesión no se guarda; si se cierra la pestaña se pierde lo que no se haya descargado.
- **Separación**: necesita el servidor de Python (Demucs no cabe en el navegador) o StemLab para Windows. En CPU puede tardar varios minutos por canción; con una GPU NVIDIA y PyTorch con CUDA, mucho menos.
- **Saturación sin sobremuestreo** y **deshacer** que aún no cubre volumen, paneo, mute, solo ni efectos, como en la versión de escritorio.
