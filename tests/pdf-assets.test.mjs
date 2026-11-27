import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

// Reproduce a dev server without a public-file index: a missing worker URL
// gets the HTML application shell (200), which WebKit refuses as a module.
test('the PDF viewer loads a JavaScript worker independently of copied assets', async () => {
  const server = await createServer({ publicDir: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const module = await (await fetch(`${base}/src/document-pdf.ts`)).text();
    const specifier = module.match(/from "([^"]+pdf\.worker[^"\n]+\?url)"/)?.[1];
    assert.ok(specifier, 'viewer should import its worker URL from Vite');
    const urlModule = await (await fetch(base + specifier)).text();
    const asset = JSON.parse(urlModule.match(/export default ("[^"]+")/)[1]);
    const response = await fetch(new URL(asset, base));
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /WorkerMessageHandler/);
  } finally { await server.close(); }
});
