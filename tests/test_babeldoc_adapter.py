"""Run with unittest; set BABELDOC_INTEGRATION=1 for the real offline-asset PDF pipeline."""
import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import babeldoc_pdf as sidecar


@contextmanager
def local_server(text='翻訳された文章です。', finish='stop', status=200):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append((self.path, self.headers.get('Authorization'), payload))
            if self.path == '/tokenize':
                reply = {'tokens': [10, 20]}
                self.send_response(200)
            else:
                reply = {'choices': [{'text': text, 'finish_reason': finish}]}
                self.send_response(status)
                if status == 307:
                    self.send_header('Location', '/unexpected')
            self.end_headers()
            self.wfile.write(json.dumps(reply).encode())

        def log_message(self, format, *args):
            pass

    with HTTPServer(('127.0.0.1', 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_port, calls
        finally:
            server.shutdown()
            thread.join()


class AdapterTests(unittest.TestCase):
    def test_native_completion(self):
        with local_server() as (port, calls), patch.dict(os.environ, {'http_proxy': 'http://127.0.0.1:1'}):
            adapter = sidecar.LocalCompletion(port, 'ja', 'local-key')
            self.assertEqual(adapter.translate('  Hello\nworld!  '), '翻訳された文章です。')
        expected = ('<|plamo:tag|>dataset<|plamo:msg|>translation'
                    '<|plamo:tag|>input<|plamo:msg|>  Hello\nworld!  '
                    '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>')
        self.assertEqual(calls, [('/tokenize', 'Bearer local-key', {
            'content': expected, 'add_special': True, 'parse_special': True}),
            ('/v1/completions', 'Bearer local-key', {
                'model': 'plamo-3-translate', 'prompt': expected, 'temperature': 0,
                'stream': False, 'max_tokens': 8190, 'stop': ['<|plamo:tag|>', '<|plamo:bos|>']})])

    def test_rejects_unsafe_url_and_prompt(self):
        for url in ('https://127.0.0.1:42', 'http://localhost:42', 'http://127.0.0.1:42@host',
                    'http://127.0.0.1:42/path', 'http://127.0.0.1:65536', 'http://example.org:80'):
            with self.subTest(url=url), self.assertRaises(argparse.ArgumentTypeError):
                sidecar.loopback_port(url)
        self.assertEqual(sidecar.loopback_port('http://127.0.0.1:42'), 42)
        for text in (' ', '<|plamo:msg|>', '🍃' * 6001):
            with self.assertRaises(ValueError):
                sidecar.prompt(text, 'ja')

    def test_truncated_empty_redirect_are_sticky_failures(self):
        for text, finish, status in [('translated', 'length', 200), (' ', 'stop', 200), ('', 'stop', 307)]:
            with self.subTest(finish=finish, status=status), local_server(text, finish, status) as (port, calls):
                adapter = sidecar.LocalCompletion(port, 'fr', '')
                with self.assertRaises((RuntimeError, ValueError)):
                    adapter.translate('source')
                with self.assertRaises(RuntimeError):
                    adapter.translate('another paragraph')
                self.assertEqual([call[0] for call in calls], ['/tokenize', '/v1/completions'])

    @unittest.skipUnless(os.environ.get('BABELDOC_INTEGRATION') == '1', 'requires BabelDOC and layout/font assets')
    def test_real_pdf_success_and_failure(self):
        import pymupdf
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / 'input.pdf', Path(tmp) / 'output.pdf'
            with pymupdf.open() as pdf:
                pdf.new_page().insert_text((72, 100), 'This paragraph should be translated into Japanese.')
                pdf.save(source)
            before = b''
            for status in (200, 503):
                with local_server(status=status) as (port, calls):
                    result = subprocess.run([sys.executable, '-I', str(ROOT / 'scripts/babeldoc_pdf.py'),
                                             str(source), str(output), '--target', 'ja', '--server-url',
                                             f'http://127.0.0.1:{port}'], capture_output=True, text=True, timeout=180,
                                            env={**os.environ, 'ANYWHERE_PLAMO_API_KEY': 'job-key'})
                self.assertIn('/v1/completions', [c[0] for c in calls], result.stderr)
                self.assertTrue(all(auth == 'Bearer job-key' for _, auth, _ in calls))
                if status == 200:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    with pymupdf.open(output) as pdf:
                        self.assertIn('翻訳された文章です。', ''.join(pdf[0].get_text().split()))
                    before = output.read_bytes()
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('503', result.stderr)
                    self.assertEqual(output.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
