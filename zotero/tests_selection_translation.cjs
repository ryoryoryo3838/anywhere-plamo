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
  const box = {left:0,top:0,right:620,bottom:480,width:620,height:480};
  const popup = {style:{width:'',maxWidth:'',maxHeight:'',translate:'',overflow:''}, parentElement:{getBoundingClientRect:()=>box}, closest: () => ({}), getBoundingClientRect:()=>({left:35,right:35+(parseFloat(popup.style.width)||198),top:20,bottom:180,width:parseFloat(popup.style.width)||198,height:160})};
  let rect = [80,15,485,130];
  const selection = { rangeCount:0 };
  const frame = {getBoundingClientRect:()=>box,contentWindow:{getSelection:()=>selection}};
  Object.assign(win,{innerWidth:620,innerHeight:480,ResizeObserver:class {observe(){} disconnect(){}}});
  const doc = { defaultView: win, documentElement: {}, querySelector(selector) {assert.equal(selector,'#secondary-view > iframe');return frame;}, createElement() { return {style:{}, children:[], append(...children){this.children.push(...children);}, closest:()=>popup, setAttribute() {}, remove() { this.isConnected = false; } }; } };
  const reader = { _internalReader:{_state:{secondaryViewSelectionPopup:{get rect(){return rect;}}}}, type: 'pdf', tabID: 'a', _iframe: { ownerGlobal: { ResizeObserver:win.ResizeObserver, MutationObserver:win.MutationObserver, Zotero_Tabs: { selectedID: 'a' } } } };
  const scope = { Zotero: { Reader: { registerEventListener(type, fn, id) { assert.equal(type, 'renderTextSelectionPopup'); assert.equal(id, 'fixture'); render = fn; }, unregisterEventListener(type, fn) { assert.equal(fn, render); render = null; } }, Notifier: { registerObserver(obj) { notify = obj; return 8; }, unregisterObserver(id) { assert.equal(id, 8); notify = null; } } }, fetch(url, init) { return new Promise(resolve => requests.push({ url, init, respond(translation) { resolve({ok: true, json: async () => ({translation})}); } })); } };
  vm.runInNewContext(readFileSync(require.resolve('./addon/selection-translation.js'), 'utf8'), scope);
  const clean = scope.registerSelectionTranslation('fixture', async () => 'dummy');
  return { popup, box, selection, setRect(value){rect=value;}, clean, requests, nodes, reader, render(text) { render({ reader, doc, params: {annotation:{text}}, append(node) { node.isConnected = true; nodes.push(node); } }); }, async flush() { for (const [id,fn] of [...timers]) { timers.delete(id); fn(); } await tick(); }, switchTab() { reader._iframe.ownerGlobal.Zotero_Tabs.selectedID = 'b'; notify.notify('select', 'tab', ['b']); }, detach() { nodes.at(-1).remove(); mutation(); } };
}
test('the official popup receives a literal Japanese translation through the authenticated local endpoint', async () => {
  const f = fixture(); f.render('source'); assert.equal(f.nodes.length, 1); assert.equal(f.requests.length, 0); await f.flush();
  const r = f.requests[0]; assert.equal(r.url, 'http://127.0.0.1:17843/translate-selection'); assert.equal(r.init.method, 'POST'); assert.equal(r.init.headers.Authorization, 'Bearer dummy'); assert.deepEqual(JSON.parse(r.init.body), {text:'source',target:'ja'}); assert.equal(r.init.cache, 'no-store'); assert.equal(r.init.redirect, 'error');
  r.respond('<b>日本語</b>'); await tick(); assert.equal(f.nodes[0].children[0].textContent, '日本語訳'); assert.equal(f.nodes[0].children[1].textContent, '<b>日本語</b>'); f.clean();
});
test('fits the real popup to the secondary view’s screen rect and restores native styles', () => {
  const f=fixture(); f.render('source'); assert.equal(f.popup.style.width, '405px');
  f.setRect([415,10,445,20]); f.render('short');assert.equal(f.popup.style.width, '400px');
  f.render('A multi-line paragraph. '.repeat(12)); assert.equal(f.popup.style.width,'536px');
  f.box.right=215; f.render('narrow'); assert.equal(f.popup.style.width, '191px');
  f.clean(); assert.equal(f.popup.style.width,''); assert.equal(f.popup.style.translate,'');
});
test('uses the horizontal union of live multi-line range fragments at current zoom', () => {
  const f=fixture();Object.assign(f.selection,{rangeCount:1,isCollapsed:false,toString:()=> 'two lines',getRangeAt:()=>({getClientRects:()=>[{left:132,right:518},{left:45,right:285}]})});
  f.render('two lines');assert.equal(f.popup.style.width,'473px'); f.clean();
});
for (const reason of ['replacement', 'tab switch', 'popup removal', 'shutdown']) test(`late responses are discarded on ${reason}`, async () => {
  const f = fixture(); f.render('a'); f.render('b'); await f.flush(); assert.equal(f.requests.length, 1); const node = f.nodes.at(-1), r = f.requests[0];
  if (reason === 'replacement') f.render('c'); else if (reason === 'tab switch') f.switchTab(); else if (reason === 'popup removal') f.detach(); else f.clean();
  assert.equal(r.init.signal.aborted, true); r.respond('stale'); await tick(); assert.notEqual(node.children[1].textContent, 'stale'); f.clean();
});
