"""Offline selection tests; PLAMO_REAL_TEST=1 also loads the bundled model."""
from email.message import Message
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
from pathlib import Path
import secrets
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

if __package__:
    from . import selection_engine as engine
else:
    import selection_engine as engine


class SelectionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.bridge = SimpleNamespace(work=Path(tmp.name), jobs={}, lock=threading.Lock())
        self.addCleanup(engine.cleanup_selection, self.bridge)
        self.client, self.peer = socket.socketpair()
        self.addCleanup(self.client.close)
        self.addCleanup(self.peer.close)

    def request(self, raw=None, *, text='The library opens at nine.', target='ja', mime='application/json', length=None):
        if raw is None:
            raw = json.dumps({'text': text, 'target': target}).encode()
        headers = Message()
        headers['Content-Type'] = mime
        headers['Content-Length'] = str(len(raw) if length is None else length)
        return engine.handle_selection(SimpleNamespace(headers=headers, bridge=self.bridge, connection=self.client,
                                                      rfile=BytesIO(raw), reply=lambda code, body: (code, body)))

    def test_reject_invalid_and_oversized_input_before_start(self):
        for kwargs, code in [({'raw': b'{'}, 400), ({'raw': b'[]'}, 400), ({'length': '-1'}, 411),
                             ({'length': engine.MAX_BODY + 1}, 413), ({'raw': b'{}', 'length': 3}, 400),
                             ({'text': '\ud800'}, 400), ({'text': '😀' * (engine.MAX_TEXT // 2 + 1)}, 413),
                             ({'text': '  '}, 400), ({'text': '<|plamo:tag|>'}, 400), ({'target': 'en'}, 400),
                             ({'mime': 'application/pdf'}, 415)]:
            with self.subTest(kwargs=list(kwargs)):
                self.assertEqual(self.request(**kwargs)[0], code)
        self.assertFalse(hasattr(self.bridge, '_selection_manager'))

    def pdf_job(self):
        directory = self.bridge.work / 'private-job'
        directory.mkdir(mode=0o700)
        worker = Mock()
        worker.poll.return_value = None
        self.bridge.jobs['job'] = SimpleNamespace(directory=directory, worker=worker)
        return directory / 'engine.json'

    def test_active_pdf_not_ready_or_unsafe_never_starts_another_engine(self):
        metadata = self.pdf_job()
        with patch.object(engine.SelectionManager, 'standalone') as spawn:
            self.assertEqual(self.request()[0], 429)
            metadata.write_text(json.dumps({'port': 1, 'key': secrets.token_urlsafe(32)}))
            metadata.chmod(0o644)
            self.assertEqual(self.request()[0], 429)
            metadata.chmod(0o600)
            metadata.write_text(json.dumps({'port': 'example.org', 'key': secrets.token_urlsafe(32)}))
            self.assertEqual(self.request()[0], 429)
            spawn.assert_not_called()

    def test_shared_pdf_protocol_rate_and_error_privacy(self):
        requests = []
        key = secrets.token_urlsafe(32)

        class Native(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append((self.path, payload, self.headers['Authorization']))
                if self.path == '/tokenize':
                    result = {'tokens': [12, 13]}
                else:
                    result = {'choices': [{'text': '翻訳', 'finish_reason': 'stop' if len(requests) == 2 else 'length'}]}
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

        server = ThreadingHTTPServer(('127.0.0.1', 0), Native)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .05})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        metadata = self.pdf_job()
        metadata.write_text(json.dumps({'key': key, 'port': server.server_port}))
        metadata.chmod(0o600)
        with patch.object(engine.SelectionManager, 'standalone') as spawn, patch.object(engine, 'PER_MINUTE', 2):
            self.assertEqual(self.request(), (200, {'translation': '翻訳'}))
            self.assertEqual([r[0] for r in requests], ['/tokenize', '/v1/completions'])
            self.assertTrue(all(r[2] == 'Bearer ' + key for r in requests))
            self.assertIn('<|plamo:val|>ja', requests[1][1]['prompt'])
            self.assertTrue(requests[0][1]['parse_special'])
            code, data = self.request(text='private document excerpt')
            self.assertEqual(code, 503)
            self.assertNotIn('private document excerpt', str(data))
            self.assertNotIn('translation', data)
            self.assertEqual(self.request()[0], 429)
            spawn.assert_not_called()
        self.bridge.jobs['job'].worker.kill.assert_not_called()

    def test_cancel_during_native_request_closes_borrowed_socket(self):
        entered = threading.Event()
        disconnected = threading.Event()

        class Stalled(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                entered.set()
                self.connection.settimeout(3)
                if not self.connection.recv(1):
                    disconnected.set()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Stalled)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.handle_request)
        server.timeout = 3
        thread.start()
        self.addCleanup(thread.join)
        metadata = self.pdf_job()
        metadata.write_text(json.dumps({'key': secrets.token_urlsafe(32), 'port': server.server_port}))
        metadata.chmod(0o600)
        replies = []
        caller = threading.Thread(target=lambda: replies.append(self.request()))
        caller.start()
        try:
            self.assertTrue(entered.wait(2))
            self.peer.close()
            self.assertTrue(disconnected.wait(2))
            caller.join(2)
            self.assertEqual(replies[0][0], 504)
            self.bridge.jobs['job'].worker.kill.assert_not_called()
        finally:
            self.peer.close()
            caller.join(3)

    def test_cancel_during_startup_and_reject_concurrent_requests(self):
        entered = threading.Event()
        released = threading.Event()

        def wait_for_cancel(_, check):
            entered.set()
            while not released.wait(.01):
                check()
            raise TimeoutError

        replies = []
        with patch.object(engine.SelectionManager, 'standalone', wait_for_cancel):
            thread = threading.Thread(target=lambda: replies.append(self.request()))
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(self.request()[0], 429)
                self.assertTrue(self.bridge.lock.acquire(blocking=False))
                self.bridge.lock.release()
                self.peer.close()
                thread.join(2)
                self.assertFalse(thread.is_alive())
                self.assertEqual(replies[0][0], 504)
            finally:
                released.set()
                thread.join(2)

    @unittest.skipUnless(os.environ.get('PLAMO_REAL_TEST') == '1', 'real local model test disabled')
    def test_real_selections_share_warm_process_and_expire(self):
        if __package__:
            from . import bridge
        else:
            import bridge
        token = secrets.token_urlsafe(32)
        server = bridge.Bridge(0, token, self.bridge.work)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .05})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)

        def request(text, key):
            conn = HTTPConnection('127.0.0.1', server.server_port, timeout=30)
            try:
                conn.request('POST', '/translate-selection', json.dumps({'text': text, 'target': 'ja'}),
                             {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
                response = conn.getresponse()
                return response.status, json.loads(response.read())
            finally:
                conn.close()

        self.assertEqual(request('test', '')[0], 401)
        with patch.object(bridge.selection, 'IDLE_SECONDS', 1):
            code, first = request('The library opens at nine.', token)
            self.assertEqual(code, 200, first)
            self.assertIn('図書館', first['translation'])
            endpoint = bridge.selection.manager(server).endpoint
            assert endpoint is not None
            model = endpoint[2]
            code, second = request('Please close the door.', token)
            self.assertEqual(code, 200, second)
            self.assertIn('ドア', second['translation'])
            self.assertIs(bridge.selection.manager(server).endpoint, endpoint)
            self.assertIsNotNone(model.wait(timeout=5))
            self.assertFalse(server.jobs)


if __name__ == '__main__':
    unittest.main()
