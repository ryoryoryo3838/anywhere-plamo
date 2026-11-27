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
  const prefixes = [];
  ctx.updateReadyPages = async (_s, ready) => prefixes.push(ready);
  const s = { path: '/jobs/abc', status: {} };
  for (let i = 0; i < 3; i++) await ctx.refresh(s);
  assert.deepEqual(requests.filter(x => x.endsWith('.pdf')), ['/jobs/abc/document.pdf']);
  assert.deepEqual(prefixes, [1, 1]);
  assert.deepEqual(stages, [[true, 'a'.repeat(64)]]);
  assert.equal(s.done, true);
});

test('oversized page is skipped individually; oversized final uses save-final', async () => {
  const paths = [];
  const ctx = context({setTimeout, clearTimeout, fetch: async url => {
    paths.push(url);
    if (url.endsWith('.pdf')) return {status: 413};
    if (url.endsWith('/save-final')) return {ok: true, json: async () => ({path: '/saved/translation.pdf'})};
    return {ok: true, json: async () => ({state: 'done', pages: 2})};
  }});
  const s = {win: {AbortController}, path: '/jobs/example', status: {}};
  const path = s.path + '/pages/1.pdf';
  assert.equal(await ctx.request(s, path, 'GET', 'page'), null);
  assert.deepEqual([...s.oversizePages], [path]);
  await ctx.refresh(s);
  assert.match(s.status.textContent, /\/saved\/translation.pdf/);
  assert.equal(s.done, true);
});

test('visible ready pages are installed individually, reused, evicted and revisited', async () => {
  const ctx = context({ Components: { utils: { cloneInto: x => x, waiveXrays: x => x } } });
  const fetched = [], released = [], pv = new Map();
  const viewer = pdf(1000, 0, 0), originalView = viewer.getPageView;
  viewer.pagesCount = 100;
  viewer.getPageView = i => {
    if (!pv.has(i)) pv.set(i, { ...originalView(i), setPdfPage(page) { this.pdfPage = page; } });
    return pv.get(i);
  };
  viewer._getVisiblePages = () => ({ views: [{ id: viewer.container.scrollTop / 1000 + 1 }] });
  viewer.update = () => {};
  const s = { path: '/jobs/x', right: reader(viewer) }, view = s.right._primaryView, frame = view._iframeWindow;
  view._pdfPages = {}; view._handlePageDestroy = () => {};
  frame.PDFViewerApplication.pdfDocument = { getPage: n => 'original ' + n };
  frame.PDFViewerApplicationOptions = { get: () => '' };
  frame.pdfjsLib = { getDocument: ({ data }) => ({ promise: Promise.resolve({ numPages: 1,
    getPage: () => 'translated ' + data, getPageData: () => 'glyphs ' + data,
    getOptionalContentConfig: () => null }), destroy: async () => { released.push(data); } }) };
  ctx.request = async (_s, path) => { fetched.push(path); return Number(path.match(/(\d+)\.pdf$/)[1]); };
  await ctx.updateReadyPages(s, 1); await ctx.updateReadyPages(s, 1);
  assert.deepEqual(fetched, ['/jobs/x/pages/1.pdf']);
  assert.equal(viewer.getPageView(0).pdfPage, 'translated 1');
  viewer.container.scrollTop = 50000;
  await ctx.updateReadyPages(s, 80);
  assert.deepEqual([...s.pageDocuments.keys()], [50, 51, 49]);
  assert.equal(viewer.getPageView(0).pdfPage, 'original 1');
  assert.deepEqual(released, [1]);
  viewer.container.scrollTop = 0;
  await ctx.updateReadyPages(s, 80);
  assert.equal(view._pdfPages[0], 'glyphs 1');
  assert.deepEqual([...s.pageDocuments.keys()], [0, 1]);
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
  await assert.rejects(ctx.displayPDF(s, bytes, false));
  assert.equal(calls.length, 0);
  await ctx.displayPDF(s, bytes, true, 'a'.repeat(64));
  assert.deepEqual(s.right._state.primaryViewState, { pageIndex: 1, scale: 170, top: 460, left: 13, scrollMode: 0, spreadMode: 0 });
  assert.deepEqual(events, ['reload', 'existing', false]);
  assert.deepEqual(calls[0], [s.item, 'ja', s.digest, 'a'.repeat(64)]);
  await ctx.displayPDF(s, bytes, true, 'bad');
  assert.equal(calls[1][3], require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
});
