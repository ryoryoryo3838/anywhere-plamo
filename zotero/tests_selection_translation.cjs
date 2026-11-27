const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let render, notify, mutation;
  const timers = new Map(), requests = [], nodes = [], win = new EventTarget();
  Object.assign(win, { AbortController, setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} disconnect() {} } });
  const doc = { defaultView: win, documentElement: {}, createElement() { return { style: {}, setAttribute() {}, remove() { this.isConnected = false; } }; } };
  const reader = { type: 'pdf', tabID: 'a', _iframe: { ownerGlobal: { Zotero_Tabs: { selectedID: 'a' } } } };
  const scope = { Zotero: { Reader: { registerEventListener(type, fn, id) { assert.equal(type, 'renderTextSelectionPopup'); assert.equal(id, 'fixture'); render = fn; }, unregisterEventListener(type, fn) { assert.equal(fn, render); render = null; } }, Notifier: { registerObserver(obj) { notify = obj; return 8; }, unregisterObserver(id) { assert.equal(id, 8); notify = null; } } }, fetch(url, init) { return new Promise(resolve => requests.push({ url, init, respond(translation) { resolve({ok: true, json: async () => ({translation})}); } })); } };
  vm.runInNewContext(readFileSync(require.resolve('./addon/selection-translation.js'), 'utf8'), scope);
  const clean = scope.registerSelectionTranslation('fixture', async () => 'dummy');
  return { clean, requests, nodes, reader, render(text) { render({ reader, doc, params: {annotation:{text}}, append(node) { node.isConnected = true; nodes.push(node); } }); }, async flush() { for (const [id,fn] of [...timers]) { timers.delete(id); fn(); } await tick(); }, switchTab() { reader._iframe.ownerGlobal.Zotero_Tabs.selectedID = 'b'; notify.notify('select', 'tab', ['b']); }, detach() { nodes.at(-1).remove(); mutation(); } };
}
test('the official popup receives a literal Japanese translation through the authenticated local endpoint', async () => {
  const f = fixture(); f.render('source'); assert.equal(f.nodes.length, 1); assert.equal(f.requests.length, 0); await f.flush();
  const r = f.requests[0]; assert.equal(r.url, 'http://127.0.0.1:17843/translate-selection'); assert.equal(r.init.method, 'POST'); assert.equal(r.init.headers.Authorization, 'Bearer dummy'); assert.deepEqual(JSON.parse(r.init.body), {text:'source',target:'ja'}); assert.equal(r.init.cache, 'no-store'); assert.equal(r.init.redirect, 'error');
  r.respond('<b>日本語</b>'); await tick(); assert.equal(f.nodes[0].textContent, '<b>日本語</b>'); f.clean();
});
for (const reason of ['replacement', 'tab switch', 'popup removal', 'shutdown']) test(`late responses are discarded on ${reason}`, async () => {
  const f = fixture(); f.render('a'); f.render('b'); await f.flush(); assert.equal(f.requests.length, 1); const node = f.nodes.at(-1), r = f.requests[0];
  if (reason === 'replacement') f.render('c'); else if (reason === 'tab switch') f.switchTab(); else if (reason === 'popup removal') f.detach(); else f.clean();
  assert.equal(r.init.signal.aborted, true); r.respond('stale'); await tick(); assert.notEqual(node.textContent, 'stale'); f.clean();
});
