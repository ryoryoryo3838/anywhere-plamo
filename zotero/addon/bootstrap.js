/* Zotero 10 bootstrapped add-on. The reader browser stays in its original parent. */
const ORIGIN = 'http://127.0.0.1:17843';
const HTML = 'http://www.w3.org/1999/xhtml';
const BUTTON = 'anywhere-plamo-toolbar';
const sessions = new Map(); // Tab ID, not item ID: the same PDF can be open twice.
const pending = new Set();
let observer;

function track(promise) {
  pending.add(promise);
  promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return promise;
}

async function localToken() {
  const home = Services.dirsvc.get('Home', Components.interfaces.nsIFile).path;
  const path = PathUtils.join(home, '.config', 'anywhere-plamo-zotero', 'token');
  try {
    const token = (await IOUtils.readUTF8(path, { maxBytes: 128 })).trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) return token;
  } catch (_) { /* Do not log token contents or store them in preferences. */ }
  throw new Error('ローカルサービスの認証ファイルを読み込めません。サービスの導入状態を確認し、再試行してください。');
}

function message(status) {
  if (status === 401 || status === 403) return '認証できません。ローカルサービスの状態を確認し、再試行してください。';
  if (status === 413) return 'PDF がサービスのサイズ上限を超えています。小さい PDF でお試しください。';
  if (status === 429 || status === 503) return 'サービスが混み合っています。しばらく待って再試行してください。';
  return `翻訳サービスが HTTP ${status} を返しました。サービスの状態を確認して再試行してください。`;
}

async function request(s, path, method, kind, body) {
  const controller = new s.win.AbortController();
  const timer = setTimeout(() => controller.abort(), method === 'POST' ? 60000 : 15000);
  if (method === 'GET') s.controller = controller;
  try {
    const headers = { Authorization: 'Bearer ' + s.token };
    if (method === 'POST') Object.assign(headers, { 'Content-Type': 'application/pdf', 'X-Target': 'ja' });
    const response = await fetch(ORIGIN + path, { method, headers, body, signal: controller.signal,
      credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (kind === 'image' && [202, 404, 409, 425].includes(response.status)) return null;
    if (method === 'DELETE' && response.status === 404) return;
    if (!response.ok) throw new Error(message(response.status));
    if (kind === 'image') {
      if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'image/png') throw new Error('ページが PNG ではありません。サービスのバージョンを確認してください。');
      return new s.win.Blob([await response.arrayBuffer()], { type: 'image/png' });
    }
    if (kind === 'json') return await response.json();
  } catch (e) {
    if (e.name === 'TypeError' || e.name === 'NetworkError' || e.name === 'AbortError') {
      throw new Error('ローカル翻訳サービスに接続できません。サービスを起動し、ポート 17843 を確認して再試行してください。');
    }
    if (e.name === 'SyntaxError') throw new Error('サービスの応答を読み取れません。サービスのバージョンを確認してください。');
    throw e;
  } finally {
    clearTimeout(timer);
    if (s.controller === controller) s.controller = null;
  }
}

function release(s) {
  if (!s.path) return;
  const path = s.path;
  s.path = null;
  return track(request(s, path, 'DELETE').catch(() => {
    // Do not print credentials, response bodies, or local file paths.
    Zotero.debug('Anywhere PLaMo: ローカルサービスのジョブを解放できませんでした。');
  }));
}

function clearImage(s) {
  s.image.removeAttribute('src');
  s.image.hidden = true;
  if (s.url) s.win.URL.revokeObjectURL(s.url);
  s.url = null;
  s.shown = null;
}

function markButton(s, open) {
  s.readerDoc.getElementById(BUTTON)?.setAttribute('aria-pressed', String(open));
}

function close(s) {
  if (s.closed) return;
  s.closed = true;
  sessions.delete(s.reader.tabID);
  clearInterval(s.timer);
  s.controller?.abort();
  s.readerDoc.defaultView?.removeEventListener('unload', s.onUnload);
  clearImage(s);
  markButton(s, false);
  s.pane.remove();
  release(s);
}

function pageNumber(s) {
  // Same active view and zero-based index as Zotero 10's reader toolbar.
  const state = s.reader._internalReader?._state;
  const stats = state?.primary ? state.primaryViewStats : state?.secondaryViewStats;
  return Number.isInteger(stats?.pageIndex) ? stats.pageIndex + 1 : null;
}

function fail(s, error) {
  if (s.closed) return;
  s.failed = true;
  clearInterval(s.timer);
  clearImage(s);
  s.status.textContent = error.message;
  s.retry.hidden = false;
  release(s);
}

async function refresh(s, page) {
  if (!s.done && Date.now() >= s.nextStatus) {
    const status = await request(s, s.path, 'GET', 'json');
    if (s.closed) return;
    if (status.state === 'failed') {
      const detail = typeof status.error === 'string' ? status.error.replaceAll(s.token, '…').slice(0, 300) : '';
      throw new Error(`翻訳に失敗しました。翻訳エンジンの設定を確認して再試行してください。${detail ? ' 詳細: ' + detail : ''}`);
    }
    if (!['running', 'done'].includes(status.state) || !Number.isInteger(status.pages) || status.pages < 0) throw new Error('ジョブ状態を読み取れません。サービスのバージョンを確認してください。');
    s.done = status.state === 'done';
    s.pages = status.pages;
    s.nextStatus = Date.now() + 1200;
  }
  if (page !== pageNumber(s) || page === s.shown || !page) return;
  if (page > s.pages) {
    if (s.done) s.status.textContent = `訳文には ${page} ページ目がありません（全 ${s.pages} ページ）。`;
    return;
  }
  if (page === s.lastAttempt && Date.now() < s.nextImage) return;
  s.lastAttempt = page;
  s.nextImage = Date.now() + 1000;
  const blob = await request(s, `${s.path}/pages/${page}.png`, 'GET', 'image');
  if (s.closed || page !== pageNumber(s)) return;
  if (!blob) {
    if (s.done) throw new Error('翻訳済みページを取得できません。再試行してください。');
    return;
  }
  clearImage(s);
  s.url = s.win.URL.createObjectURL(blob);
  s.image.alt = `日本語訳 ${page} ページ`;
  s.image.src = s.url;
  s.shown = page;
  s.image.hidden = false;
  s.scroll.scrollTop = 0;
  s.status.textContent = `${page} ページ目の日本語訳`;
}

function tick(s) {
  if (s.closed || s.failed) return;
  if (!s.pane.isConnected) { close(s); return; }
  const page = pageNumber(s);
  if (page !== s.wanted) {
    clearImage(s);
    s.wanted = page;
    s.status.textContent = page ? `${page} ページ目の訳文を待っています…` : '原文のページ情報を待っています…';
  }
  if (s.busy || !s.path || (s.done && s.shown === page)) return;
  s.busy = true;
  refresh(s, page).catch(e => fail(s, e)).finally(() => { s.busy = false; });
}

async function start(s) {
  s.token = await localToken();
  if (s.closed) return;
  const path = Zotero.Items.get(s.reader.itemID)?.getFilePath();
  let file;
  try {
    if (!path) throw new Error();
    file = await File.createFromFileName(path);
  } catch (_) { throw new Error('ローカルの PDF が見つかりません。添付ファイルをダウンロードして再試行してください。'); }
  if (s.closed) return;
  const result = await request(s, '/jobs', 'POST', 'json', file);
  if (typeof result?.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(result.id)) throw new Error('ジョブ ID を読み取れません。サービスのバージョンを確認してください。');
  s.path = '/jobs/' + result.id;
  // Closing mid-upload must not strand the job after the POST completes.
  if (s.closed) { await release(s); return; }
  s.timer = setInterval(() => tick(s), 250);
  tick(s);
}

function open(reader, readerDoc) {
  const container = reader._iframe.parentElement;
  const doc = container.ownerDocument;
  const el = (tag, text) => {
    const node = doc.createElementNS(HTML, tag);
    if (text) node.textContent = text;
    return node;
  };
  const pane = el('aside');
  pane.setAttribute('aria-label', '日本語訳');
  pane.style.cssText = 'display:flex;flex-flow:column nowrap;flex:0 1 47%;width:47%;min-width:0;min-height:0;overflow:hidden;border-inline-start:1px solid GrayText;background:Canvas;color:CanvasText';
  const bar = el('header');
  bar.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:.5em;padding:.5em';
  const title = el('strong', '日本語訳');
  const retry = el('button', '再試行');
  retry.hidden = true;
  const stop = el('button', '閉じる');
  stop.title = '訳文を閉じて、翻訳ジョブを終了します';
  bar.append(title, retry, stop);
  const status = el('div', 'PDF をローカルサービスに送信しています…');
  status.style.cssText = 'padding:0 .5em .5em;overflow-wrap:anywhere';
  status.setAttribute('role', 'status');
  const scroll = el('div');
  scroll.style.cssText = 'flex:1;min-height:0;overflow:auto';
  const image = el('img');
  image.hidden = true;
  image.style.cssText = 'width:100%;height:auto';
  scroll.append(image);
  pane.append(bar, status, scroll);
  reader._iframe.after(pane);
  const s = { reader, readerDoc, pane, win: doc.defaultView, retry, status, image, scroll, nextStatus: 0 };
  sessions.set(reader.tabID, s);
  const restart = () => { close(s); open(reader, readerDoc); };
  retry.addEventListener('click', restart);
  stop.addEventListener('click', () => close(s));
  image.addEventListener('error', () => { if (s.url) fail(s, new Error('訳文の画像を表示できません。再試行してください。')); });
  s.onUnload = () => close(s);
  readerDoc.defaultView.addEventListener('unload', s.onUnload, { once: true });
  markButton(s, true);
  track(start(s).catch(e => fail(s, e)));
}

function toolbar({ reader, doc, append }) {
  if (!reader.tabID || reader.type !== 'pdf') return;
  const button = doc.createElement('button');
  button.id = BUTTON;
  button.className = 'toolbar-button';
  button.textContent = '訳';
  button.title = '日本語訳を右側に表示／閉じる';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(sessions.has(reader.tabID)));
  button.addEventListener('click', () => {
    const session = sessions.get(reader.tabID);
    if (session) close(session); else open(reader, doc);
  });
  append(button);
}

function install() {}
function uninstall() {}
function startup({ id }) {
  Zotero.Reader.registerEventListener('renderToolbar', toolbar, id);
  // renderToolbar runs only when React mounts its custom section. Also cover
  // already-open tabs when enabling the add-on without restarting Zotero.
  for (const reader of Zotero.Reader._readers) {
    const doc = reader._iframeWindow?.document;
    const target = doc?.querySelector('.toolbar .end .custom-sections');
    if (target && !doc.getElementById(BUTTON)) toolbar({ reader, doc, append: b => target.append(b) });
  }
  observer = Zotero.Notifier.registerObserver({ notify(event, type, ids) {
    if (type === 'tab' && event === 'close') for (const id of ids) {
      const session = sessions.get(id);
      if (session) close(session);
    }
  } }, ['tab'], 'anywhere-plamo');
}
async function shutdown() {
  Zotero.Reader.unregisterEventListener('renderToolbar', toolbar);
  Zotero.Notifier.unregisterObserver(observer);
  for (const s of sessions.values()) close(s);
  for (const reader of Zotero.Reader._readers) reader._iframeWindow?.document?.getElementById(BUTTON)?.remove();
  await Promise.allSettled([...pending]);
}
