const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

function context(extra = {}) {
  const ctx = vm.createContext(extra);
  for (const name of ['bootstrap', 'native-pane']) {
    vm.runInContext(fs.readFileSync(`${__dirname}/addon/${name}.js`, 'utf8'), ctx);
  }
  return ctx;
}

function pdf(height, margin, top) {
  const container = { clientTop: 0, scrollTop: top, getBoundingClientRect: () => ({ top: 12 }),
    addEventListener() {}, removeEventListener() {} };
  return { pagesCount: 3, container, getPageView(index) {
    return { div: { getBoundingClientRect() {
      const top = 12 + (height + margin) * index - container.scrollTop;
      return { top, height, bottom: top + height };
    } } };
  } };
}

function reader(pdfViewer) {
  return { _state: { primary: true }, _primaryView: {
    _iframeWindow: { PDFViewerApplication: { pdfViewer } }, initializedPromise: Promise.resolve()
  } };
}

test('continuous scroll maps viewport top across page boundaries and unequal scales', () => {
  const ctx = context(), left = pdf(1000, 12, 0), right = pdf(500, 6, 0);
  const s = { reader: { _internalReader: reader(left) }, right: reader(right) };
  for (const [source, expected] of [[400, 200], [999, 499.5], [1002, 501], [1012, 506], [1812, 906]]) {
    left.container.scrollTop = source;
    ctx.syncScroll(s);
    assert.equal(right.container.scrollTop, expected);
  }
});

test('status polling after manual right scroll never forces it back to the left', () => {
  const ctx = context(), left = pdf(1000, 12, 300), right = pdf(500, 6, 0);
  const s = { reader: { _internalReader: reader(left) }, right: reader(right), done: true, pane: { isConnected: true } };
  let bound = 0;
  s.onScroll = () => { ++bound; ctx.syncScroll(s); };
  ctx.tick(s);
  right.container.scrollTop = 725;
  ctx.tick(s);
  assert.equal(bound, 1);
  assert.equal(right.container.scrollTop, 725);
});

test('polls by completion count, switches to final even when page count is unchanged', async () => {
  const ctx = context(), requests = [], stages = [];
  const states = [{ state: 'running', pages: 1 }, { state: 'running', pages: 1 }, { state: 'done', pages: 1, layoutDigest: 'a'.repeat(64) }];
  ctx.request = async (s, path, method, kind) => { requests.push(path); return kind === 'json' ? states.shift() : new Uint8Array(1); };
  ctx.displayPDF = async (s, bytes, final, identity) => stages.push([final, identity]);
  const s = { path: '/jobs/abc', status: {} };
  for (let i = 0; i < 3; i++) await ctx.refresh(s);
  assert.deepEqual(requests.filter(x => x.endsWith('.pdf')), ['/jobs/abc/preview.pdf', '/jobs/abc/document.pdf']);
  assert.deepEqual(stages, [[false, undefined], [true, 'a'.repeat(64)]]);
  assert.equal(s.done, true);
});

test('reload uses immediate right-side location; only final opens the private annotation store', async () => {
  const ctx = context({ Components: { utils: { cloneInto: x => structuredClone(x) } }, Zotero: { Promise: { delay: async () => {} } } });
  const calls = [], store = { annotations: [{ id: 'existing' }] };
  ctx.createTranslationAnnotationStore = async (...args) => { calls.push(args); return store; };
  const pdfViewer = { _location: { pageNumber: 2, scale: 170, top: 460, left: 13 }, scrollMode: 0, spreadMode: 0 };
  const s = { right: reader(pdfViewer), item: {}, digest: 'd'.repeat(64), win: { crypto: webcrypto },
    browser: { contentWindow: { wrappedJSObject: { createReader() {} } } } };
  const events = [];
  Object.assign(s.right, { reload() { events.push('reload'); }, setAnnotations(x) { events.push(x[0].id); }, setReadOnly(x) { events.push(x); } });
  const bytes = new Uint8Array([22, 33]);
  await ctx.displayPDF(s, bytes, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(s.right._state.primaryViewState, { pageIndex: 1, scale: 170, top: 460, left: 13, scrollMode: 0, spreadMode: 0 });
  await ctx.displayPDF(s, bytes, true, 'a'.repeat(64));
  assert.deepEqual(events, ['reload', 'reload', 'existing', false]);
  assert.deepEqual(calls[0], [s.item, 'ja', s.digest, 'a'.repeat(64)]);
  await ctx.displayPDF(s, bytes, true, 'bad');
  assert.equal(calls[1][3], require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
});
