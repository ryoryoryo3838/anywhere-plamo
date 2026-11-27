#!/usr/bin/env python3
"""Opt-in loopback PDF translation bridge. Run with the BabelDOC Python environment."""
import argparse
import importlib.util
import contextlib
from dataclasses import dataclass
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
import os
from pathlib import Path
import re
import resource
import secrets
import shutil
import signal
import socket
from socketserver import ThreadingMixIn
import stat
import subprocess
import sys
import tempfile
import threading
import time
from typing import cast

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'src-tauri/resources/runtime'
MODEL = Path.home() / '.local/share/app.anywhere-plamo.desktop/models/plamo-3-translate-2b-Q4_K_M.gguf'
TOKEN = Path.home() / '.config/anywhere-plamo-zotero/token'
_selection_spec = importlib.util.spec_from_file_location('plamo_selection', Path(__file__).with_name('selection_engine.py'))
if _selection_spec is None or _selection_spec.loader is None:
    raise ImportError('Bundled selection engine not found.')
selection = importlib.util.module_from_spec(_selection_spec)
_selection_spec.loader.exec_module(selection)
PORT = 17843
MAX_BODY = 128 * 1024 * 1024  # Original PDF upload
MAX_PREVIEW = 64 * 1024 * 1024
MAX_FINAL = 256 * 1024 * 1024
MAX_PAGES = 500
MAX_JOBS = 4  # Retained results; only one active model at a time.
LIFETIME = 3600
MAX_EDGE = 1800


def pairing_token(path):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = path.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o077:
        raise ValueError('pairing directory must be private (0700) and owned by you')
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w') as file:
            file.write(secrets.token_urlsafe(32) + '\n')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('pairing token must be a private user file (0600)')
        raw = file.read(128)
        if not re.fullmatch(rb'[A-Za-z0-9_-]{43}\n?', raw):
            raise ValueError('invalid pairing token file')
        return raw.strip().decode('ascii')


class JobError(Exception):
    """Only fixed, document-independent messages may be exposed to clients."""


def build_preview(directory, pages):
    # Isolate expensive MuPDF work from control requests and the PNG renderer.
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_PREVIEW, MAX_PREVIEW))
    resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
    staging = directory / 'preview.partial'
    try:
        with pymupdf.open(directory / 'input.pdf') as doc:
            total = len(doc)
            if not 1 <= pages <= total <= MAX_PAGES:
                return 1
            part_bytes = 0
            for index in range(pages):
                part = directory / 'pages' / f'{index + 1}.pdf'
                part_bytes += part.stat().st_size
                if part_bytes > 4 * MAX_PREVIEW:
                    return 2
                with pymupdf.open(part) as translated:
                    if len(translated) != 1:
                        return 1
                    doc.insert_pdf(translated)
                # Keep the original xref for bookmarks and links from remaining
                # pages. The grafted page can have a different page-tree parent.
                target = doc.page_xref(index)
                parent = doc.xref_get_key(target, 'Parent')[1]
                doc.xref_copy(doc.page_xref(total + index), target)
                doc.xref_set_key(target, 'Parent', parent)
            doc.delete_pages(from_page=total, to_page=len(doc) - 1)
            doc.save(staging, garbage=3, deflate=True)
        staging.replace(directory / 'preview.pdf')
        return 0
    except Exception:
        return 2 if staging.exists() and staging.stat().st_size >= MAX_PREVIEW else 1
    finally:
        staging.unlink(missing_ok=True)


def layout_digest(pdf):
    """Identify visible page layouts, not volatile PDF IDs or creation dates."""
    import hashlib
    digest = hashlib.sha256(b'plamo-page-layout-v1\0')
    with pymupdf.open(pdf) as document:
        for page in document:
            digest.update(json.dumps([list(page.rect), page.rotation, page.get_text('words')],
                                     ensure_ascii=False, separators=(',', ':')).encode())
            scale = 128 / max(page.rect.width, page.rect.height)
            digest.update(page.get_pixmap(matrix=pymupdf.Matrix(scale, scale),
                                         colorspace=pymupdf.csGRAY, alpha=False).samples)
    return digest.hexdigest()


def worker(directory):
    with pymupdf.open(directory / 'input.pdf') as doc:
        if not doc.is_pdf or doc.needs_pass or not 1 <= len(doc) <= MAX_PAGES:
            raise JobError('Unsupported, encrypted or oversized PDF.')
        expected = len(doc)
    key = secrets.token_urlsafe(32)
    cuda = RUNTIME / 'llama-server-cuda'
    # Default auto-fit reserves 1 GiB, which can push much of a small model onto
    # the CPU even when all its layers would fit. Try full offload first, then
    # keep automatic fitting and CPU as fallbacks on memory-limited machines.
    for binary, backend_args in ((cuda, ['--gpu-layers', 'all']), (cuda, []),
                                 (RUNTIME / 'llama-server', [])):
        if not binary.is_file():
            continue
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        command = [binary, *backend_args, '--model', MODEL, '--host', '127.0.0.1', '--port', str(port),
                   '--alias', 'plamo-3-translate', '--ctx-size', '8192', '--parallel', '1',
                   '--cache-ram', '0', '--threads', '8', '--no-webui', '--no-warmup', '--offline', '--log-disable']
        try:
            engine = subprocess.Popen(command, env={**os.environ, 'LLAMA_API_KEY': key})
        except OSError:
            continue
        try:
            deadline = time.monotonic() + 120
            while engine.poll() is None and time.monotonic() < deadline:
                conn = HTTPConnection('127.0.0.1', port, timeout=1)
                try:
                    conn.request('GET', '/v1/models', headers={'Authorization': 'Bearer ' + key})
                    if conn.getresponse().status == 200 and engine.poll() is None:
                        break
                except OSError:
                    pass
                finally:
                    conn.close()
                time.sleep(.2)
            else:
                continue
            # Private handoff for other local translation requests, never part
            # of the job API. Publish only after authenticated engine readiness.
            metadata = directory / 'engine.json'
            staging = directory / 'engine.partial'
            with os.fdopen(os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
                json.dump({'port': port, 'key': key}, file)
            staging.replace(metadata)
            result = subprocess.run([sys.executable, '-I', ROOT / 'scripts/babeldoc_pdf.py',
                                     'input.pdf', 'output.pdf', '--target', 'ja', '--preview-dir', 'pages',
                                     '--server-url', f'http://127.0.0.1:{port}'], cwd=directory,
                                    env={**os.environ, 'ANYWHERE_PLAMO_API_KEY': key, 'TMPDIR': str(directory)})
            if result.returncode or not all((directory / 'pages' / f'{n}.pdf').is_file()
                                           for n in range(1, expected + 1)):
                raise JobError('BabelDOC translation failed; check the PDF and local BabelDOC assets.')
            (directory / 'layout.sha256').write_text(layout_digest(directory / 'output.pdf'))
            return
        finally:
            try:
                (directory / 'engine.json').unlink(missing_ok=True)
                (directory / 'engine.partial').unlink(missing_ok=True)
            finally:
                engine.kill()
                engine.wait()
    raise JobError('Could not start the bundled llama-server. Check the runtime, model and available memory.')


@dataclass
class Job:
    directory: Path
    worker: subprocess.Popen
    created: float
    pages: int = 0
    preview_worker: subprocess.Popen | None = None
    preview_pages: int = 0

    def pdf_path(self, kind, status):
        if status['state'] == 'failed':
            return 422, None
        if status['state'] == 'done':
            return 200, self.directory / 'output.pdf'
        if kind == 'document' or not self.pages:
            return 202, None
        if self.preview_worker is not None:
            code = self.preview_worker.poll()
            if code is None:
                return 202, None
            if self.preview_pages == self.pages:
                if code == 0:
                    return 200, self.directory / 'preview.pdf'
                return (413 if code in (2, -signal.SIGXFSZ) else 422), None
        self.preview_pages = self.pages
        self.preview_worker = subprocess.Popen(
            [sys.executable, '-I', Path(__file__).resolve(), '--preview', self.directory, str(self.pages)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 202, None

    def status(self):
        code = self.worker.poll()
        while self.pages < MAX_PAGES and (self.directory / 'pages' / f'{self.pages + 1}.pdf').is_file():
            self.pages += 1
        if code not in (None, 0):
            error = self.directory / 'error'
            return {'state': 'failed', 'pages': self.pages,
                    'error': error.read_text() if error.exists() else 'Translation worker failed.'}
        status = {'state': 'running' if code is None else 'done', 'pages': self.pages}
        layout = self.directory / 'layout.sha256'
        if code == 0 and layout.is_file():
            status['layoutDigest'] = layout.read_text()
        return status

    def release(self):
        if self.preview_worker is not None:
            self.preview_worker.kill()
            self.preview_worker.wait()
        if self.worker.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.worker.pid, signal.SIGKILL)
            self.worker.wait()
        shutil.rmtree(self.directory)


class Bridge(ThreadingMixIn, HTTPServer):
    def __init__(self, port, token, work):
        self.token = token
        self.work = work
        self.jobs = {}
        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(('127.0.0.1', port), Handler)

    def service_actions(self):
        with self.lock:
            for id_, job in list(self.jobs.items()):
                if time.monotonic() - job.created >= LIFETIME:
                    self.jobs.pop(id_).release()

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            return self.shutdown_request(request)
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def server_close(self):
        selection.cleanup_selection(self)
        super().server_close()
        while self.jobs:
            self.jobs.popitem()[1].release()

    def finish_request(self, request, client_address):
        assert isinstance(request, socket.socket)
        # Absolute timeout, even for a client that trickles header/body bytes.
        def disconnect():
            with contextlib.suppress(OSError):
                request.shutdown(socket.SHUT_RDWR)
        timer = threading.Timer(30, disconnect)
        timer.start()
        try:
            super().finish_request(request, client_address)
        finally:
            timer.cancel()


class Handler(BaseHTTPRequestHandler):
    @property
    def bridge(self) -> Bridge:
        return cast(Bridge, self.server)

    def log_message(self, format, *args):
        pass  # Never log request paths, credentials or document data.

    def reply(self, status, body, mime='application/json'):
        if mime == 'application/json':
            body = json.dumps(body).encode()
        self.reply_headers(status, len(body), mime)
        self.wfile.write(body)

    def reply_headers(self, status, length, mime):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()

    def parse_request(self):
        if not super().parse_request():
            return False
        hosts = self.headers.get_all('Host')
        origins = self.headers.get_all('Origin')
        auth = self.headers.get_all('Authorization', [])
        if hosts != [f'127.0.0.1:{self.bridge.server_port}'] or origins not in (None, ['chrome://zotero']):
            self.reply(403, {'error': 'Forbidden host or origin.'})
        elif len(auth) != 1 or not secrets.compare_digest(auth[0].encode(), ('Bearer ' + self.bridge.token).encode()):
            self.reply(401, {'error': 'Pairing token required.'})
        else:
            return True
        return False

    def do_POST(self):
        if self.path == '/translate-selection':
            return selection.handle_selection(self)
        with self.bridge.lock:
            self.upload_job()

    def upload_job(self):
        if self.path != '/jobs':
            return self.reply(404, {'error': 'Not found.'})
        if self.headers.get_all('Content-Type') != ['application/pdf'] or self.headers.get_all('X-Target') != ['ja']:
            return self.reply(400, {'error': 'Expected application/pdf and X-Target: ja.'})
        lengths = self.headers.get_all('Content-Length', [])
        if 'Transfer-Encoding' in self.headers or len(lengths) != 1 or not re.fullmatch('[0-9]{1,12}', lengths[0]):
            return self.reply(411, {'error': 'Content-Length required.'})
        size = int(lengths[0])
        if not 0 < size <= MAX_BODY:
            return self.reply(413, {'error': 'PDF size outside allowed range.'})
        jobs = self.bridge.jobs
        if len(jobs) >= MAX_JOBS or any(j.worker.poll() is None for j in jobs.values()):
            return self.reply(429, {'error': 'Bridge busy. Wait or release an earlier job.'})
        id_ = secrets.token_hex(16)
        directory = self.bridge.work / id_
        directory.mkdir(mode=0o700)
        try:
            with (directory / 'input.pdf').open('wb') as output:
                while size:
                    chunk = self.rfile.read(min(size, 65536))
                    if not chunk:
                        return self.reply(400, {'error': 'Incomplete upload.'})
                    output.write(chunk)
                    size -= len(chunk)
            selection.yield_idle_selection(self.bridge)
            process = subprocess.Popen([sys.executable, '-I', Path(__file__).resolve(), '--worker', directory],
                                       cwd=directory, start_new_session=True, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            jobs[id_] = Job(directory, process, time.monotonic())
        finally:
            if id_ not in jobs:
                shutil.rmtree(directory)
        self.reply(202, {'id': id_})

    def do_GET(self):
        match = re.fullmatch(r'/jobs/([0-9a-f]{32})/(document|preview)\.pdf', self.path)
        if match:
            return self.send_pdf(match[1], match[2])
        with self.bridge.lock:
            self.send_status_or_png()

    def send_pdf(self, id_, kind):
        with self.bridge.lock:
            job = self.bridge.jobs.get(id_)
            if job is None:
                return self.reply(404, {'error': 'Job not found.'})
            code, path = job.pdf_path(kind, job.status())
            if code == 202:
                return self.reply(202, {'state': 'not-ready'})
            if code == 413:
                return self.reply(413, {'error': 'PDF exceeds size limit.'})
            if path is None:
                return self.reply(422, {'error': 'PDF unavailable.'})
            try:
                file = path.open('rb')
            except OSError:
                return self.reply(422, {'error': 'PDF unavailable.'})
        # An open descriptor remains valid across snapshot replacement or DELETE.
        with file:
            size = os.fstat(file.fileno()).st_size
            if size > (MAX_FINAL if path.name == 'output.pdf' else MAX_PREVIEW):
                return self.reply(413, {'error': 'PDF exceeds size limit.'})
            self.reply_headers(200, size, 'application/pdf')
            shutil.copyfileobj(file, self.wfile, length=65536)

    def send_status_or_png(self):
        match = re.fullmatch(r'/jobs/([0-9a-f]{32})(?:/pages/([1-9][0-9]{0,2})\.png)?', self.path)
        job = self.bridge.jobs.get(match[1]) if match else None
        if not match or not job:
            return self.reply(404, {'error': 'Job not found.'})
        status = job.status()
        if match[2] is None:
            return self.reply(200, status)
        if int(match[2]) > status['pages']:
            return self.reply(404, {'error': 'Page not available.'})
        try:
            with pymupdf.open(job.directory / 'pages' / f'{match[2]}.pdf') as doc:
                page = doc[0]
                edge = max(page.rect.width, page.rect.height)
                if not math.isfinite(edge) or edge <= 0:
                    raise ValueError('invalid page')
                zoom = min(2, (MAX_EDGE - 1) / edge)
                png = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csRGB,
                                      alpha=False).tobytes('png')
        except Exception:
            return self.reply(422, {'error': 'Cannot render preview page.'})
        self.reply(200, png, 'image/png')

    def do_DELETE(self):
        with self.bridge.lock:
            self.delete_job()

    def delete_job(self):
        match = re.fullmatch('/jobs/([0-9a-f]{32})', self.path)
        job = self.bridge.jobs.pop(match[1], None) if match else None
        if not job:
            return self.reply(404, {'error': 'Job not found.'})
        job.release()
        self.reply(200, {})


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('--preview', nargs=2, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.preview:
        return build_preview(Path(args.preview[0]), int(args.preview[1]))
    if args.worker:
        try:
            worker(args.worker)
        except Exception as exc:
            message = str(exc) if isinstance(exc, JobError) else 'Invalid PDF or unavailable BabelDOC environment.'
            (args.worker / 'error').write_text(message)
            return 1
        return 0
    if not MODEL.is_file() or not any((RUNTIME / name).is_file() for name in ('llama-server-cuda', 'llama-server')):
        parser.exit(1, 'Missing bundled llama-server or local PLaMo GGUF.\n')
    token = pairing_token(TOKEN)
    with tempfile.TemporaryDirectory(prefix='plamo-zotero-') as tmp, Bridge(PORT, token, Path(tmp)) as server:
        print(f'Bridge: http://127.0.0.1:{PORT}. Pair using {TOKEN}. Ctrl-C to stop.', flush=True)
        stopping = False

        def stop(*_):
            nonlocal stopping
            stopping = True

        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        server.timeout = .5
        while not stopping:
            server.handle_request()
            server.service_actions()
    return 0


if __name__ == '__main__':
    sys.exit(main())
