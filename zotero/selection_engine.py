"""Local selection translation. Dispatch only after the bridge's host/origin/token checks."""
import collections
import contextlib
from http.client import HTTPConnection, HTTPException
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import select
import socket
import stat
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'src-tauri/resources/runtime'
MODEL = Path.home() / '.local/share/app.anywhere-plamo.desktop/models/plamo-3-translate-2b-Q4_K_M.gguf'
MAX_BODY = 32 * 1024
MAX_TEXT = 4000  # UTF-16 units, as counted by the Zotero JavaScript client.
REQUEST_SECONDS = 25
IDLE_SECONDS = 30
PER_MINUTE = 30

# `python -I` does not put sibling scripts on sys.path.
_spec = importlib.util.spec_from_file_location('plamo_pdf_adapter', ROOT / 'scripts/babeldoc_pdf.py')
assert _spec is not None and _spec.loader is not None
_adapter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_adapter)


class Busy(Exception):
    pass


def pdf_endpoint(bridge):
    # A slow upload may currently hold the jobs lock. Never queue behind it.
    if not bridge.lock.acquire(blocking=False):
        raise Busy
    try:
        job = next((j for j in bridge.jobs.values() if j.worker.poll() is None), None)
    finally:
        bridge.lock.release()
    if job is None:
        return None
    try:
        fd = os.open(job.directory / 'engine.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as f:
            info = os.fstat(f.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise Busy
            raw = f.read(513)
        if len(raw) > 512:
            raise Busy
        data = json.loads(raw)
        port, key = data['port'], data['key']
        if type(port) is not int or not 1 <= port <= 65535 or not re.fullmatch(r'[A-Za-z0-9_-]{43}', key):
            raise Busy
        return port, key, job.worker
    except (OSError, ValueError, TypeError, KeyError):
        raise Busy from None  # PDF starting or disappearing: don't launch another model.


def connect(address, timeout):
    conn = HTTPConnection('127.0.0.1', address if isinstance(address, int) else 80, timeout=timeout)
    if isinstance(address, Path):
        conn.sock = socket.socket(socket.AF_UNIX)
        try:
            conn.sock.settimeout(timeout)
            conn.sock.connect(str(address))
        except BaseException:
            conn.close()
            raise
    else:
        conn.connect()
        # A released PDF's ephemeral port could be rebound by another local user.
        # Verify the connected peer (not just the listening port) before sending
        # even the credential. These are IPv4 loopback sockets on the Linux bridge.
        try:
            remote = f'0100007F:{address:04X}'
            local = f'0100007F:{conn.sock.getsockname()[1]:04X}'
            with open('/proc/net/tcp', encoding='ascii') as table:
                next(table)
                if not any(row[1:4] == [remote, local, '01'] and int(row[7]) == os.getuid()
                           for row in map(str.split, table)):
                    raise Busy
        except BaseException:
            conn.close()
            raise
    return conn


class SelectionCompletion(_adapter.LocalCompletion):
    """Use the PDF adapter's tokenizer, prompt, stopping and output checks unchanged."""
    def __init__(self, endpoint, check):
        address, key, self.owner = endpoint
        super().__init__(address, 'ja', key)
        self.check = check

    def post(self, path, payload):
        conn = connect(self.port, self.check())
        sock = conn.sock
        done = threading.Event()

        def watch():
            while not done.wait(.15):
                try:
                    self.check()
                except TimeoutError:
                    with contextlib.suppress(OSError):
                        sock.shutdown(socket.SHUT_RDWR)
                    return

        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()
        try:
            if self.owner.poll() is not None:
                raise Busy
            if path == '/v1/completions':
                payload = {**payload, 'max_tokens': min(2048, payload['max_tokens'])}
            conn.request('POST', path, json.dumps(payload).encode(),
                         {'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
            response = conn.getresponse()
            if response.status != 200:
                raise RuntimeError('Native completion unavailable.')
            raw = response.read(128 * 1024 + 1)
            if len(raw) > 128 * 1024:
                raise ValueError('Oversized native response.')
            return json.loads(raw)
        finally:
            done.set()
            watcher.join()
            conn.close()
            self.check()  # Map a timed-out or cancelled socket read to a fixed timeout response.


class SelectionManager:
    def __init__(self, bridge):
        self.bridge = bridge
        self.gate = threading.Lock()
        self.recent = collections.deque()
        self.endpoint = None
        self.timer = None
        self.closed = threading.Event()
        self.yield_requested = threading.Event()

    def stop_engine(self):
        if self.timer:
            self.timer.cancel()
            self.timer = None
        if self.endpoint:
            address, _, process = self.endpoint
            self.endpoint = None
            process.kill()
            process.wait()
            address.unlink(missing_ok=True)

    def expire(self):
        with self.gate:
            if self.timer is threading.current_thread():
                self.stop_engine()

    def standalone(self, check):
        if self.endpoint and self.endpoint[2].poll() is None:
            return self.endpoint
        self.stop_engine()
        address = self.bridge.work / 'selection.sock'  # Private bridge temporary directory.
        key = secrets.token_urlsafe(32)
        for binary, gpu in [('llama-server-cuda', ['--gpu-layers', 'all']),
                            ('llama-server-cuda', []), ('llama-server', [])]:
            check()
            try:
                process = subprocess.Popen(
                    [RUNTIME / binary, *gpu, '--model', MODEL, '--host', address, '--alias', _adapter.MODEL,
                     '--ctx-size', '8192', '--parallel', '1', '--cache-ram', '0', '--threads', '8',
                     '--threads-http', '4', '--no-webui', '--no-warmup', '--offline', '--log-disable'],
                    env={**{k: v for k, v in os.environ.items() if not k.startswith('LLAMA_')},
                         'LLAMA_API_KEY': key}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL)
            except OSError:
                continue
            self.endpoint = address, key, process
            while process.poll() is None:
                remaining = check()
                try:
                    with contextlib.closing(connect(address, min(remaining, .5))) as conn:
                        conn.request('GET', '/v1/models', headers={'Authorization': 'Bearer ' + key})
                        if conn.getresponse().status == 200:
                            return self.endpoint
                except (OSError, HTTPException):
                    pass
                time.sleep(.1)
            self.stop_engine()
        raise RuntimeError('Bundled translation engine unavailable.')

    def translate(self, text, client):
        if not self.gate.acquire(blocking=False):
            raise Busy
        now = time.monotonic()
        deadline = now + REQUEST_SECONDS
        poll = select.poll()

        def check():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or self.closed.is_set() or poll.poll(0):
                raise TimeoutError
            return remaining

        try:
            poll.register(client, select.POLLRDHUP | select.POLLHUP | select.POLLERR)
            self.yield_requested.clear()
            check()
            while self.recent and self.recent[0] <= now - 60:
                self.recent.popleft()
            if len(self.recent) >= PER_MINUTE:
                raise Busy
            self.recent.append(now)
            try:
                endpoint = pdf_endpoint(self.bridge)
            except Busy:
                self.stop_engine()
                raise
            if endpoint:
                self.stop_engine()
            else:
                endpoint = self.standalone(check)
            translation = SelectionCompletion(endpoint, check).translate(text).strip()
            check()
            if self.yield_requested.is_set():
                self.stop_engine()
            elif self.endpoint:
                if self.timer:
                    self.timer.cancel()
                self.timer = threading.Timer(IDLE_SECONDS, self.expire)
                self.timer.daemon = True
                self.timer.start()
            return translation
        except Busy:
            raise
        except Exception:
            self.stop_engine()  # Don't retain a failed startup or an interrupted generation.
            raise
        finally:
            self.gate.release()


_install = threading.Lock()


def manager(bridge):
    with _install:
        if not hasattr(bridge, '_selection_manager'):
            bridge._selection_manager = SelectionManager(bridge)
        return bridge._selection_manager


def cleanup_selection(bridge):
    """Call at bridge shutdown; never stop a borrowed PDF worker."""
    engine = manager(bridge)
    engine.closed.set()
    with engine.gate:
        engine.stop_engine()


def yield_idle_selection(bridge):
    """Optional PDF-start hook: release an idle selection model before spawning the PDF worker."""
    engine = manager(bridge)
    engine.yield_requested.set()
    if engine.gate.acquire(blocking=False):
        try:
            engine.stop_engine()
        finally:
            engine.gate.release()


def handle_selection(handler):
    headers = handler.headers
    if headers.get_all('Content-Type') not in (['application/json'], ['application/json; charset=utf-8']):
        return handler.reply(415, {'error': 'Expected application/json.'})
    lengths = headers.get_all('Content-Length', [])
    if 'Transfer-Encoding' in headers or len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,12}', lengths[0]):
        return handler.reply(411, {'error': 'Content-Length required.'})
    size = int(lengths[0])
    if not 0 < size <= MAX_BODY:
        return handler.reply(413, {'error': 'Selection body outside allowed range.'})
    try:
        raw = handler.rfile.read(size)
        if len(raw) != size:
            raise ValueError
        body = json.loads(raw.decode('utf-8'))
        if not isinstance(body, dict) or set(body) != {'text', 'target'} or body['target'] != 'ja':
            raise ValueError
        text = body['text']
        if not isinstance(text, str) or not text.strip() or '<|plamo:' in text or '\0' in text:
            raise ValueError
        if len(text.encode('utf-16-le')) > 2 * MAX_TEXT:
            return handler.reply(413, {'error': 'Selection exceeds character limit.'})
    except (ValueError, RecursionError, OSError):
        return handler.reply(400, {'error': 'Invalid selection or target.'})
    try:
        translation = manager(handler.bridge).translate(text, handler.connection)
    except Busy:
        return handler.reply(429, {'error': 'Local translator busy. Try again shortly.'})
    except TimeoutError:
        return handler.reply(504, {'error': 'Selection translation timed out or was cancelled.'})
    except Exception:
        return handler.reply(503, {'error': 'Local selection translation unavailable.'})
    return handler.reply(200, {'translation': translation})
