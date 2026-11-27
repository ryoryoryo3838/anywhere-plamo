"""Fixture bridge in the private network namespace. No real jobs or credentials."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json

root = Path('/sandbox')
token = (root/'home/.config/anywhere-plamo-zotero/token').read_text()
jobs = set(); number = 0

class Mock(BaseHTTPRequestHandler):
    def log_message(self, format, *args): pass

    def dispatch(self):
        global number
        auth = self.headers.get('Authorization') == 'Bearer '+token
        status, body, mime = 404, {}, 'application/json'
        parts = self.path.strip('/').split('/')
        if not auth: status = 401
        elif self.command == 'POST' and self.path == '/jobs':
            pdf = self.rfile.read(int(self.headers['Content-Length']))
            if pdf == (root/'fixtures/source.pdf').read_bytes() and self.headers.get('X-Target') == 'ja':
                number += 1; job = f'{number:032x}'; jobs.add(job); status, body = 202, {'id': job}
            else: status = 422
        elif len(parts)>=2 and parts[0]=='jobs' and parts[1] in jobs:
            done = (root/'finish-job').exists()
            if self.command=='DELETE' and len(parts)==2:
                jobs.remove(parts[1]); status=200
            elif self.command=='GET' and len(parts)==2:
                status,body = 200, {'state':'done' if done else 'running', 'pages':2 if done else 1}
            elif self.command=='GET' and parts[2:] in (['document.pdf'], ['preview.pdf']):
                if parts[2]=='document.pdf' and not done: status=202
                else:
                    name='final' if parts[2]=='document.pdf' else 'preview'
                    status,body,mime=200,(root/f'fixtures/{name}.pdf').read_bytes(),'application/pdf'
        data=body if isinstance(body,bytes) else json.dumps(body).encode()
        print(json.dumps(dict(method=self.command,path=self.path,status=status,auth=auth)),flush=True)
        self.send_response(status); self.send_header('Content-Type',mime); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    do_GET = do_POST = do_DELETE = dispatch

HTTPServer(('127.0.0.1',17843), Mock).serve_forever()
