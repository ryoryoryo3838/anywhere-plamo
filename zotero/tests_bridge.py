"""Run with the BabelDOC Python. Set PLAMO_REAL_TEST=1 for offline model inference."""
from http.client import HTTPConnection
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest
from typing import Any
from unittest.mock import Mock, patch

import pymupdf

if __package__:
    from . import bridge
else:
    import bridge


class BridgeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        path = self.work / 'pairing/token'
        self.key = bridge.pairing_token(path)
        self.assertEqual(self.key, bridge.pairing_token(path))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.server = bridge.Bridge(0, self.key, self.work)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02})
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)

    def request(self, method, path, body=None, **headers) -> tuple[int, Any]:
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        try:
            conn.request(method, path, body, {'Authorization': 'Bearer ' + self.key, **headers})
            response = conn.getresponse()
            self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))
            data = response.read()
            if path.endswith('.pdf') and response.status == 200:
                self.assertEqual(response.getheader('Content-Type'), 'application/pdf')
                self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                self.assertEqual(response.getheader('Content-Length'), str(len(data)))
            if response.getheader('Content-Type') == 'application/json':
                data = json.loads(data)
            return response.status, data
        finally:
            conn.close()

    def upload(self, pdf, **extra):
        return self.request('POST', '/jobs', pdf, **{'Content-Type': 'application/pdf', 'X-Target': 'ja', **extra})

    def wait(self, route):
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            code, data = self.request('GET', route)
            self.assertEqual(code, 200)
            if data['state'] != 'running':
                return data
            time.sleep(.2)
        self.fail('job did not finish within five minutes')

    def test_access_and_upload_limits(self):
        for method in ('GET', 'POST', 'DELETE', 'OPTIONS'):
            self.assertEqual(self.request(method, '/jobs', Authorization='')[0], 401)
        for origin in ('https://example.org', 'null', 'chrome://zotero.example'):
            self.assertEqual(self.request('GET', '/jobs', Origin=origin)[0], 403)
        self.assertEqual(self.request('GET', '/jobs', Host='example.org')[0], 403)
        self.assertEqual(self.request('GET', '/jobs', Origin='chrome://zotero')[0], 404)
        self.assertEqual(self.upload(b'x', **{'Content-Length': str(bridge.MAX_BODY + 1)})[0], 413)
        self.assertEqual(self.upload(b'x', **{'X-Target': '../x'})[0], 400)
        self.assertEqual(self.upload(b'x', **{'Content-Type': 'text/plain'})[0], 400)
        with patch.object(bridge, 'MAX_JOBS', 0):
            self.assertEqual(self.upload(b'x')[0], 429)

    def test_bad_pdf_and_release(self):
        code, job = self.upload(b'not a PDF')
        self.assertEqual(code, 202)
        route = '/jobs/' + job['id']
        self.assertEqual(self.wait(route)['state'], 'failed')
        for name in ('document', 'preview'):
            self.assertEqual(self.request('GET', f'{route}/{name}.pdf')[0], 422)
        self.assertEqual(self.request('DELETE', route)[0], 200)
        self.assertEqual(self.request('GET', route)[0], 404)
        self.assertFalse((self.work / job['id']).exists())

    def test_expiry(self):
        with patch.object(bridge, 'LIFETIME', 0):
            code, job = self.upload(b'invalid')
            self.assertEqual(code, 202)
            self.server.service_actions()
            self.assertEqual(self.request('GET', '/jobs/' + job['id'])[0], 404)
        self.assertFalse((self.work / job['id']).exists())

    def test_release_running_job(self):
        with pymupdf.open() as doc:
            doc.new_page().insert_text((40, 100), 'A short paragraph.')
            code, job = self.upload(doc.tobytes())
        self.assertEqual(code, 202)
        route = '/jobs/' + job['id']
        self.assertEqual(self.request('GET', route)[1]['state'], 'running')
        self.assertEqual(self.upload(b'x')[0], 429)
        self.assertEqual(self.request('DELETE', route)[0], 200)
        self.assertFalse((self.work / job['id']).exists())

    def test_progressive_full_pdfs(self):
        # Freeze translation milestones, not PDF assembly or HTTP delivery.
        id_ = 'f' * 32
        root = self.work / id_
        (root / 'pages').mkdir(parents=True)
        route = '/jobs/' + id_
        worker = Mock()
        worker.poll.return_value = None
        self.addCleanup(setattr, worker.poll, 'return_value', 0)
        with self.server.lock:
            self.server.jobs[id_] = bridge.Job(root, worker, time.monotonic())
        sizes = [(320, 400), (500, 300), (360, 600)]
        with pymupdf.open() as original, pymupdf.open() as final:
            for n, (width, height) in enumerate(sizes, 1):
                for doc, text in ((original, 'Source'), (final, 'Translated')):
                    doc.new_page(width=width, height=height).insert_text((40, 80), f'{text} {n}')
            original.set_toc([[1, 'Start', 1]])
            original[2].insert_link({'kind': pymupdf.LINK_GOTO, 'from': pymupdf.Rect(20, 20, 40, 40), 'page': 0})
            original.save(root / 'input.pdf')
            final.save(root / 'output.pdf')
            for name in ('document', 'preview'):
                path = f'{route}/{name}.pdf'
                self.assertEqual(self.request('GET', path, Authorization='')[0], 401)
                self.assertEqual(self.request('GET', path), (202, {'state': 'not-ready'}))
            for ready in (1, 2):
                with pymupdf.open() as part:
                    part.insert_pdf(final, from_page=ready - 1, to_page=ready - 1)
                    part.save(root / 'pages' / f'{ready}.pdf')
                path = route + '/preview.pdf'
                code, body = self.request('GET', path)
                self.assertEqual(code, 202)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    code, body = self.request('GET', path)
                    if code != 202:
                        break
                    time.sleep(.03)
                self.assertEqual(code, 200, body)
                with pymupdf.open(stream=body) as snapshot:
                    self.assertEqual(len(snapshot), 3)
                    self.assertEqual(snapshot.get_toc(), original.get_toc())
                    self.assertEqual(snapshot[2].get_links()[0]['page'], 0)
                    for i, page in enumerate(snapshot):
                        self.assertEqual((page.rect.width, page.rect.height), sizes[i])
                        prefix = 'Translated' if i < ready else 'Source'
                        self.assertEqual(page.get_text().strip(), f'{prefix} {i + 1}')
                self.assertEqual(self.request('GET', path), (200, body))
                self.assertEqual(self.request('GET', route + '/document.pdf')[0], 202)
        worker.poll.return_value = 0
        for name in ('document', 'preview'):
            path = f'{route}/{name}.pdf'
            self.assertEqual(self.request('GET', path), (200, (root / 'output.pdf').read_bytes()))
            with patch.object(bridge, 'MAX_BODY', 100):
                self.assertEqual(self.request('GET', path)[0], 413)
        # Hold a download mid-transfer; status and release must still work,
        # and unlinking the job must not truncate the already-open download.
        entered, resume = threading.Event(), threading.Event()
        copy_file = bridge.shutil.copyfileobj

        def slow_copy(*args, **kwargs):
            entered.set()
            if not resume.wait(5):
                raise TimeoutError('control requests blocked by PDF download')
            copy_file(*args, **kwargs)

        expected = (root / 'output.pdf').read_bytes()
        with ThreadPoolExecutor(1) as pool, patch.object(bridge.shutil, 'copyfileobj', slow_copy):
            transfer = pool.submit(self.request, 'GET', route + '/document.pdf')
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(self.request('GET', route)[1]['state'], 'done')
                self.assertEqual(self.request('DELETE', route)[0], 200)
            finally:
                resume.set()
            self.assertEqual(transfer.result(), (200, expected))
        self.assertFalse(root.exists())
        for name in ('document', 'preview'):
            self.assertEqual(self.request('GET', f'{route}/{name}.pdf')[0], 404)

    @unittest.skipUnless(os.environ.get('PLAMO_REAL_TEST') == '1', 'opt-in real model test')
    def test_real(self):
        with pymupdf.open() as doc:
            for sentence in ('The library is open every morning.', 'Readers can borrow books from the library.'):
                doc.new_page().insert_text((40, 100), sentence, fontsize=14)
            code, job = self.upload(doc.tobytes())
        self.assertEqual(code, 202)
        route = '/jobs/' + job['id']
        metadata = self.work / job['id'] / 'engine.json'
        deadline = time.monotonic() + 120
        while not metadata.exists() and time.monotonic() < deadline:
            self.assertEqual(self.request('GET', route)[1]['state'], 'running')
            time.sleep(.05)
        self.assertEqual(metadata.stat().st_mode & 0o777, 0o600)
        handoff = json.loads(metadata.read_bytes())
        self.assertTrue(isinstance(handoff['key'], str) and len(handoff['key']) == 43)
        self.assertTrue(0 < handoff['port'] <= 65535)
        self.assertEqual(self.request('GET', route + '/engine.json')[0], 404)
        self.assertEqual(self.wait(route), {'state': 'done', 'pages': 2})
        self.assertFalse(metadata.exists())
        code, full = self.request('GET', route + '/document.pdf')
        self.assertEqual(code, 200)
        self.assertEqual(self.request('GET', route + '/preview.pdf'), (200, full))
        with pymupdf.open(stream=full) as final:
            self.assertEqual(len(final), 2)
            for page in final:
                self.assertRegex(page.get_text(), '[ぁ-んァ-ヶ一-龯]')
        for page in (1, 2):
            code, png = self.request('GET', f'{route}/pages/{page}.png')
            self.assertEqual(code, 200)
            self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
            self.assertLessEqual(max(struct.unpack('>II', png[16:24])), bridge.MAX_EDGE)
            with pymupdf.open(self.work / job['id'] / 'pages' / f'{page}.pdf') as preview:
                text = preview[0].get_text().strip()
                self.assertRegex(text, '[ぁ-んァ-ヶ一-龯]')
                print(f'page {page}: {text}; {len(png)} PNG bytes', flush=True)
        self.assertEqual(self.request('GET', route + '/pages/3.png')[0], 404)
        self.assertEqual(self.request('DELETE', route)[0], 200)
        self.assertEqual(self.request('GET', route)[0], 404)


if __name__ == '__main__':
    unittest.main()
