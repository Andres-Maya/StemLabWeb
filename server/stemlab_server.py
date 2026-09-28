#!/usr/bin/env python3
"""Servidor de StemLab Web.

Hace dos cosas, sin dependencias aparte de las de Demucs:

1. Sirve la aplicación web ya compilada (carpeta dist/, "npm run build") con
   las cabeceras de aislamiento de origen que necesita el motor de audio.
2. Separa instrumentos con Demucs: ejecuta stemlab_separate.py (el mismo
   script que StemLab de escritorio) sobre la canción que sube el navegador.

No guarda nada: cada separación trabaja en una carpeta temporal que se borra
en cuanto el navegador descarga los stems (o al cancelar, o a los 30 minutos
si nadie los pide, o al cerrar el servidor). Las pistas, grabaciones y
mezclas viven solo en el navegador y se descargan desde allí.

    python server/stemlab_server.py                   # http://127.0.0.1:8000
    python server/stemlab_server.py --port 9000 --host 0.0.0.0

API (JSON):
    GET    /api/health                         modelos y estado del entorno
    POST   /api/separations?model=M&name=N     cuerpo = el archivo de audio -> {"id": ...}
    GET    /api/separations/<id>/events        progreso (Server-Sent Events)
    GET    /api/separations/<id>/stems/<stem>  descargar un stem (FLAC o WAV)
    DELETE /api/separations/<id>               cancelar y borrar sus archivos

Eventos: {"type": "status", "message"} · {"type": "progress", "value"} ·
{"type": "done", "stems": [{"name", "url"}]} · {"type": "error", "message"} ·
{"type": "cancelled"}
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "stemlab_separate.py"
DIST = HERE.parent / "dist"

MODELS = [
    {"id": "htdemucs", "description": "4 pistas: voz, batería, bajo y otros (recomendado)",
     "stems": ["vocals", "drums", "bass", "other"]},
    {"id": "htdemucs_ft", "description": "4 pistas, más calidad (unas 4 veces más lento)",
     "stems": ["vocals", "drums", "bass", "other"]},
    {"id": "htdemucs_6s", "description": "6 pistas: añade guitarra y piano (experimental)",
     "stems": ["vocals", "drums", "bass", "guitar", "piano", "other"]},
]

MAX_UPLOAD_BYTES = 1024 ** 3        # 1 GB
ABANDONED_SECONDS = 30 * 60         # stems que nadie descarga
KEEPALIVE_SECONDS = 15

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".wasm": "application/wasm", ".map": "application/json",
    ".flac": "audio/flac", ".wav": "audio/wav",
}

ISOLATION_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
}


def safe_name(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", name).strip(" .")
    return cleaned[:120] or "cancion.wav"


class Job:
    def __init__(self, root: Path, model: str, name: str) -> None:
        self.id = uuid.uuid4().hex
        self.dir = root / self.id
        self.input = self.dir / "entrada" / safe_name(name)
        self.output = self.dir / "stems"
        self.model = model
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.stems: dict[str, Path] = {}
        self.process: subprocess.Popen | None = None
        self.finished = False
        self.finished_at = 0.0
        self.cancelled = False

    def emit(self, event: dict) -> None:
        with self.cond:
            self.events.append(event)
            self.cond.notify_all()

    def finish(self, event: dict) -> None:
        with self.cond:
            if self.finished:
                return
            self.finished = True
            self.finished_at = time.time()
            self.events.append(event)
            self.cond.notify_all()

    def cancel(self) -> None:
        self.cancelled = True
        process = self.process

        if process is not None and process.poll() is None:
            process.kill()

        self.finish({"type": "cancelled"})

    def delete_files(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


class Separations:
    """Cola de separaciones: una a la vez (el modelo ocupa mucha memoria)."""

    def __init__(self, python: str) -> None:
        self.python = python
        self.root = Path(tempfile.mkdtemp(prefix="stemlab-web-"))
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.pending: queue.Queue[Job] = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()
        threading.Thread(target=self._janitor, daemon=True).start()
        atexit.register(self.shutdown)

    def create(self, model: str, name: str, body_reader, length: int) -> Job:
        job = Job(self.root, model, name)
        job.input.parent.mkdir(parents=True, exist_ok=True)

        with open(job.input, "wb") as file:
            remaining = length
            while remaining > 0:
                chunk = body_reader(min(1 << 20, remaining))
                if not chunk:
                    raise ConnectionError("La subida se interrumpió.")
                file.write(chunk)
                remaining -= len(chunk)

        with self.lock:
            self.jobs[job.id] = job
            busy = any(not j.finished for j in self.jobs.values() if j is not job and j.process is not None)

        if busy:
            job.emit({"type": "status", "message": "En cola: hay otra separación en marcha..."})

        self.pending.put(job)
        return job

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            return self.jobs.get(job_id)

    def remove(self, job_id: str) -> bool:
        with self.lock:
            job = self.jobs.pop(job_id, None)

        if job is None:
            return False

        job.cancel()
        job.delete_files()
        return True

    def _worker(self) -> None:
        while True:
            job = self.pending.get()

            if not job.cancelled:
                try:
                    self._run(job)
                except Exception as error:  # noqa: BLE001 - se informa al navegador
                    job.finish({"type": "error", "message": f"{type(error).__name__}: {error}"})

            # La canción subida ya no hace falta.
            shutil.rmtree(job.input.parent, ignore_errors=True)

    def _run(self, job: Job) -> None:
        command = [self.python, "-u", "-X", "utf8", str(SCRIPT), "--input", str(job.input),
                   "--output", str(job.output), "--model", job.model, "--format", "flac"]

        job.emit({"type": "status", "message": "Iniciando Python..."})
        env = dict(os.environ, PYTHONIOENCODING="utf-8")

        try:
            job.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                           stdin=subprocess.DEVNULL, text=True, encoding="utf-8",
                                           errors="replace", env=env)
        except OSError as error:
            job.finish({"type": "error", "message": f"No se pudo ejecutar Python ({self.python}): {error}"})
            return

        if job.cancelled:
            job.process.kill()

        script_error = ""
        log_tail: list[str] = []

        assert job.process.stdout is not None

        for raw in job.process.stdout:
            line = raw.rstrip("\r\n")

            if line.startswith("@@PROGRESS "):
                try:
                    job.emit({"type": "progress", "value": max(0.0, min(1.0, float(line[11:])))})
                except ValueError:
                    pass
            elif line.startswith("@@STATUS "):
                job.emit({"type": "status", "message": line[9:]})
            elif line.startswith("@@STEM "):
                name, _, path = line[7:].partition("\t")
                job.stems[name] = Path(path)
            elif line.startswith("@@ERROR "):
                script_error = line[8:].replace("\\n", "\n")
            elif line and not line.startswith("@@"):
                log_tail = (log_tail + [line])[-20:]

        code = job.process.wait()

        if job.cancelled:
            job.finish({"type": "cancelled"})
        elif script_error:
            job.finish({"type": "error", "message": script_error})
        elif code != 0:
            job.finish({"type": "error", "message": f"Python terminó con código {code}:\n\n" + "\n".join(log_tail)})
        elif not job.stems:
            job.finish({"type": "error", "message": "El modelo terminó pero no generó ningún stem."})
        else:
            stems = [{"name": name, "url": f"/api/separations/{job.id}/stems/{name}"} for name in job.stems]
            job.finish({"type": "done", "stems": stems})

    def _janitor(self) -> None:
        while True:
            time.sleep(60)
            now = time.time()

            with self.lock:
                stale = [j.id for j in self.jobs.values() if j.finished and now - j.finished_at > ABANDONED_SECONDS]

            for job_id in stale:
                self.remove(job_id)

    def shutdown(self) -> None:
        with self.lock:
            jobs = list(self.jobs.values())

        for job in jobs:
            job.cancel()

        shutil.rmtree(self.root, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "StemLabWeb/0.1"
    separations: Separations

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - firma de la clase base
        if not self.path.startswith("/api/separations/") or "/events" not in self.path:
            sys.stderr.write(f"[{self.log_date_time_string()}] {format % args}\n")

    def _headers(self, status: int, content_type: str, length: int | None = None, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)

        if length is not None:
            self.send_header("Content-Length", str(length))

        for key, value in {**ISOLATION_HEADERS, **(extra or {})}.items():
            self.send_header(key, value)

        self.end_headers()

    def _json(self, status: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(body), {"Cache-Control": "no-store"})
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _route(self) -> tuple[list[str], dict]:
        url = urlparse(self.path)
        parts = [unquote(p) for p in url.path.split("/") if p]
        return parts, parse_qs(url.query)

    # ------------------------------------------------------------------ GET
    def do_GET(self) -> None:  # noqa: N802 - nombre de la clase base
        parts, _ = self._route()

        if parts[:1] != ["api"]:
            self._static(parts)
            return

        if parts == ["api", "health"]:
            self._json(HTTPStatus.OK, {
                "ok": True,
                "models": MODELS,
                "scriptFound": SCRIPT.exists(),
                "python": self.separations.python,
            })
            return

        if len(parts) >= 4 and parts[1] == "separations":
            job = self.separations.get(parts[2])

            if job is None:
                self._error(HTTPStatus.NOT_FOUND, "La separación no existe (quizá ya se borró).")
            elif parts[3:] == ["events"]:
                self._events(job)
            elif len(parts) == 5 and parts[3] == "stems":
                self._stem(job, parts[4])
            else:
                self._error(HTTPStatus.NOT_FOUND, "Ruta desconocida.")
            return

        self._error(HTTPStatus.NOT_FOUND, "Ruta desconocida.")

    def _events(self, job: Job) -> None:
        self._headers(HTTPStatus.OK, "text/event-stream; charset=utf-8",
                      extra={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
        index = 0

        try:
            while True:
                with job.cond:
                    if index >= len(job.events) and not job.finished:
                        job.cond.wait(KEEPALIVE_SECONDS)

                    events = job.events[index:]
                    index = len(job.events)
                    finished = job.finished

                if not events:
                    self.wfile.write(b": sigo aqui\n\n")

                for event in events:
                    self.wfile.write(b"data: " + json.dumps(event, ensure_ascii=False).encode("utf-8") + b"\n\n")

                self.wfile.flush()

                if finished and index >= len(job.events):
                    break
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _stem(self, job: Job, name: str) -> None:
        path = job.stems.get(name)

        if path is None or not job.finished or not path.is_file():
            self._error(HTTPStatus.NOT_FOUND, "Ese stem no existe.")
            return

        size = path.stat().st_size
        self._headers(HTTPStatus.OK, CONTENT_TYPES.get(path.suffix, "application/octet-stream"), size,
                      {"Cache-Control": "no-store"})

        try:
            with open(path, "rb") as file:
                shutil.copyfileobj(file, self.wfile, 1 << 20)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _static(self, parts: list[str]) -> None:
        if not DIST.is_dir():
            body = ("<!doctype html><meta charset=utf-8><title>StemLab Web</title>"
                    "<body style='font-family:system-ui;background:#121419;color:#e4e6eb;padding:40px'>"
                    "<h1>StemLab Web</h1><p>Falta compilar la aplicación: ejecuta <code>npm run build</code> "
                    "y vuelve a cargar esta página.</p><p>Para desarrollar, usa <code>npm run dev</code> "
                    "(abre http://localhost:5173) con este servidor en marcha para la separación.</p>").encode("utf-8")
            self._headers(HTTPStatus.OK, "text/html; charset=utf-8", len(body))
            self.wfile.write(body)
            return

        path = (DIST / Path(*parts)).resolve() if parts else DIST / "index.html"

        if not str(path).startswith(str(DIST.resolve())) or not path.is_file():
            path = DIST / "index.html"

        data = path.read_bytes()
        cache = "no-cache" if path.name == "index.html" else "public, max-age=31536000, immutable"
        self._headers(HTTPStatus.OK, CONTENT_TYPES.get(path.suffix, "application/octet-stream"), len(data),
                      {"Cache-Control": cache})
        self.wfile.write(data)

    def do_HEAD(self) -> None:  # noqa: N802
        """¿Sigue existiendo la separación? (el navegador lo pregunta si pierde los eventos)."""
        parts, _ = self._route()
        exists = len(parts) >= 3 and parts[:2] == ["api", "separations"] and self.separations.get(parts[2]) is not None
        self._headers(HTTPStatus.OK if exists else HTTPStatus.NOT_FOUND, "text/plain", 0)

    # ----------------------------------------------------------------- POST
    def do_POST(self) -> None:  # noqa: N802
        parts, query = self._route()

        if parts != ["api", "separations"]:
            self._error(HTTPStatus.NOT_FOUND, "Ruta desconocida.")
            return

        model = query.get("model", ["htdemucs"])[0]
        name = query.get("name", ["cancion.wav"])[0]

        if model not in {m["id"] for m in MODELS}:
            self._error(HTTPStatus.BAD_REQUEST, f"Modelo desconocido: {model}")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0

        if length <= 0:
            self._error(HTTPStatus.BAD_REQUEST, "No se recibió ningún audio.")
            return

        if length > MAX_UPLOAD_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "El archivo es demasiado grande (máximo 1 GB).")
            return

        if not SCRIPT.exists():
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"No se encontró el script de separación: {SCRIPT}")
            return

        try:
            job = self.separations.create(model, name, self.rfile.read, length)
        except (ConnectionError, OSError) as error:
            self._error(HTTPStatus.BAD_REQUEST, str(error))
            return

        self._json(HTTPStatus.CREATED, {"id": job.id})

    # --------------------------------------------------------------- DELETE
    def do_DELETE(self) -> None:  # noqa: N802
        parts, _ = self._route()

        if len(parts) == 3 and parts[:2] == ["api", "separations"]:
            self.separations.remove(parts[2])
            self._json(HTTPStatus.OK, {"ok": True})
        else:
            self._error(HTTPStatus.NOT_FOUND, "Ruta desconocida.")


def find_python() -> str:
    """El intérprete con Demucs: STEMLAB_PYTHON, o el que ejecuta este servidor."""
    return os.environ.get("STEMLAB_PYTHON") or sys.executable


def main() -> int:
    parser = argparse.ArgumentParser(description="Servidor de StemLab Web (aplicación + separación con Demucs).")
    parser.add_argument("--host", default="127.0.0.1", help="0.0.0.0 para abrirlo a la red local")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--python", default=find_python(), help="Python con Demucs instalado")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    Handler.separations = Separations(args.python)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True

    shown = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    print(f"StemLab Web en http://{shown}:{args.port}")
    print(f"Separación con: {args.python}")
    print(f"Archivos temporales: {Handler.separations.root} (se borran solos)")

    if not DIST.is_dir():
        print("Aviso: no hay dist/. Compila con 'npm run build' o usa 'npm run dev'.")

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        Handler.separations.shutdown()

    return 0


if __name__ == "__main__":
    sys.exit(main())
