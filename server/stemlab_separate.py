#!/usr/bin/env python3
"""StemLab: separación de instrumentos con Demucs.

StemLab (C++) y el servidor de StemLab Web ejecutan este mismo script como
un proceso externo (los dos proyectos llevan una copia idéntica):

    python -u -X utf8 stemlab_separate.py --input cancion.mp3 --output stems/cancion

El script solo hace la parte de IA: cargar el modelo, preprocesar, inferir y
escribir un archivo por instrumento: WAV float 32 (por defecto) o, con
--format flac, FLAC de 24 bits (la mitad de tamaño: la web los descarga así).
Un stem que pase de 0 dBFS se escribe siempre en WAV float para no recortarlo.
Se comunica por stdout con líneas que empiezan por "@@":

    @@STATUS <texto>          mensaje para la barra de estado
    @@PROGRESS <0..1>         progreso global
    @@STEM <nombre>\t<ruta>   stem escrito
    @@DONE                    terminado correctamente
    @@ERROR <mensaje>         error (el código de salida será distinto de 0)

Cualquier otra línea (avisos de PyTorch, etc.) se trata como log.

Diagnóstico del entorno:
    python stemlab_separate.py --check
"""

from __future__ import annotations

import argparse
import importlib
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"]


def emit(tag: str, message: str = "") -> None:
    print(f"@@{tag} {message}".rstrip(), flush=True)


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Separación de instrumentos para StemLab (Demucs).")
    parser.add_argument("--input", type=Path, help="archivo de audio de entrada")
    parser.add_argument("--output", type=Path, help="carpeta donde se escriben los stems")
    parser.add_argument("--model", default="htdemucs", help="htdemucs | htdemucs_ft | htdemucs_6s")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "mps"])
    parser.add_argument("--shifts", type=int, default=1,
                        help="pasadas con desplazamiento aleatorio: más calidad, más lento")
    parser.add_argument("--overlap", type=float, default=0.25)
    parser.add_argument("--format", default="wav", choices=["wav", "flac"],
                        help="wav (float 32) o flac (24 bits; WAV float si el stem pasa de 0 dBFS)")
    parser.add_argument("--ffmpeg", default="ffmpeg",
                        help="FFmpeg para formatos que libsndfile no lee (m4a, aac...)")
    parser.add_argument("--check", action="store_true", help="comprueba el entorno y termina")

    args = parser.parse_args(argv)

    if not args.check and (args.input is None or args.output is None):
        parser.error("--input y --output son obligatorios")

    return args


def pick_device(torch, requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def load_audio(path: Path, ffmpeg: str):
    """Devuelve (audio [canales, muestras] float32, sample rate).

    Primero intenta con libsndfile (WAV, FLAC, OGG, MP3). Si el formato no es
    compatible, convierte con FFmpeg a un WAV temporal.
    """
    import numpy as np
    import soundfile as sf

    try:
        data, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
        return np.ascontiguousarray(data.T), sample_rate
    except Exception as error:  # formato no soportado por libsndfile
        if shutil.which(ffmpeg) is None:
            raise RuntimeError(
                f"No se pudo leer '{path.name}' ({error}). Instala FFmpeg o convierte el archivo a WAV/FLAC."
            ) from error

    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "input.wav"
        command = [ffmpeg, "-v", "error", "-y", "-i", str(path), "-vn", "-c:a", "pcm_f32le", str(wav_path)]
        completed = subprocess.run(command, capture_output=True, text=True)

        if completed.returncode != 0:
            raise RuntimeError(f"FFmpeg no pudo convertir '{path.name}': {completed.stderr.strip()}")

        data, sample_rate = sf.read(str(wav_path), dtype="float32", always_2d=True)
        return np.ascontiguousarray(data.T), sample_rate


def match_channels(wav, channels: int):
    """Mismo criterio que demucs.audio.convert_audio_channels."""
    if wav.shape[0] == channels:
        return wav
    if channels == 1:
        return wav.mean(dim=0, keepdim=True)
    if wav.shape[0] == 1:
        return wav.expand(channels, -1)
    return wav[:channels]


def install_progress_hook(total_passes: int) -> None:
    """Demucs informa del progreso con tqdm (demucs.apply hace `import tqdm`).

    Se sustituye tqdm.tqdm por un iterador que emite @@PROGRESS, sin modificar
    Demucs. Cada modelo del "bag" y cada shift es una pasada completa.
    """
    import tqdm

    state = {"pass": 0}

    def tracked(iterable=None, *args, **kwargs):
        items = list(iterable) if iterable is not None else []
        index = state["pass"]
        state["pass"] += 1
        count = max(1, len(items))

        def generator():
            for i, item in enumerate(items):
                yield item
                done = (index + (i + 1) / count) / total_passes
                emit("PROGRESS", f"{min(done, 1.0):.4f}")

        return generator()

    tqdm.tqdm = tracked


def separate(args: argparse.Namespace) -> None:
    emit("STATUS", "Cargando PyTorch...")
    import soundfile as sf
    import torch
    from demucs.apply import BagOfModels, apply_model
    from demucs.pretrained import get_model

    device = pick_device(torch, args.device)

    emit("STATUS", f"Cargando modelo {args.model} en {device} (la primera vez se descarga)...")
    model = get_model(args.model)
    model.eval()

    emit("STATUS", f"Leyendo {args.input.name}...")
    audio, sample_rate = load_audio(args.input, args.ffmpeg)
    wav = match_channels(torch.from_numpy(audio), model.audio_channels)

    if sample_rate != model.samplerate:
        import julius  # dependencia de demucs

        wav = julius.resample_frac(wav, sample_rate, model.samplerate)

    # Normalización que aplica demucs.separate antes de la inferencia.
    reference = wav.mean(0)
    mean, std = reference.mean(), reference.std() + 1e-8
    wav = (wav - mean) / std

    models = len(model.models) if isinstance(model, BagOfModels) else 1
    install_progress_hook(models * max(1, args.shifts))

    emit("STATUS", f"Separando instrumentos ({device})...")
    emit("PROGRESS", "0")

    with torch.no_grad():
        sources = apply_model(model, wav[None], device=device, shifts=args.shifts,
                              split=True, overlap=args.overlap, progress=True)[0]

    sources = sources * std + mean

    emit("STATUS", "Guardando pistas...")
    args.output.mkdir(parents=True, exist_ok=True)
    names = list(model.sources)
    order = {name: i for i, name in enumerate(STEM_ORDER)}

    for name in sorted(names, key=lambda n: order.get(n, len(STEM_ORDER))):
        data = sources[names.index(name)].cpu().numpy().T

        if args.format == "flac" and float(abs(data).max()) <= 1.0:
            path = args.output / f"{name}.flac"
            sf.write(str(path), data, model.samplerate, format="FLAC", subtype="PCM_24")
        else:
            path = args.output / f"{name}.wav"
            sf.write(str(path), data, model.samplerate, subtype="FLOAT")

        emit("STEM", f"{name}\t{path}")

    emit("PROGRESS", "1")
    emit("DONE")


def check_environment() -> int:
    print(f"Python      {platform.python_version()} ({sys.executable})")
    ok = True

    for module in ("numpy", "soundfile", "torch", "torchaudio", "demucs", "julius"):
        try:
            imported = importlib.import_module(module)
            print(f"{module:<11} {getattr(imported, '__version__', 'ok')}")
        except Exception as error:  # noqa: BLE001 - diagnóstico
            ok = False
            print(f"{module:<11} NO DISPONIBLE ({error})")

    try:
        import torch

        print(f"CUDA        {'sí' if torch.cuda.is_available() else 'no'}")
    except Exception:  # noqa: BLE001
        pass

    print(f"FFmpeg      {shutil.which('ffmpeg') or 'no encontrado (opcional)'}")
    print("Entorno listo." if ok else "Faltan dependencias: pip install -r requirements.txt")
    return 0 if ok else 1


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

    args = parse_args()

    if args.check:
        return check_environment()

    try:
        separate(args)
        return 0
    except ModuleNotFoundError as error:
        emit("ERROR", f"Falta el paquete de Python '{error.name}'. "
                      "Instala las dependencias de requirements.txt (ver README.md).")
        return 2
    except Exception as error:  # noqa: BLE001 - se informa a quien lo ejecuta
        emit("ERROR", f"{type(error).__name__}: {error}".replace("\n", "\\n"))
        return 1


if __name__ == "__main__":
    sys.exit(main())
