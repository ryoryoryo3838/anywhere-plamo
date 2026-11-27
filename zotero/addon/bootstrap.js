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

function message(status, kind) {
  if (status === 401 || status === 403) return '認証できません。ローカルサービスの状態を確認し、再試行してください。';
  if (status === 413) return kind === 'pdf' ? '完成した翻訳PDFが表示上限（256 MiB）を超えました。原本を章ごとに分けてお試しください。' : '原本PDFが送信上限（128 MiB）を超えました。章ごとに分けてお試しください。';
  if (status === 429 || status === 503) return 'サービスが混み合っています。しばらく待って再試行してください。';
  return `翻訳サービスが HTTP ${status} を返しました。サービスの状態を確認して再試行してください。`;
}

async function request(s, path, method, kind, body) {
  const controller = new s.win.AbortController();
  const timer = setTimeout(() => controller.abort(), method === 'POST' ? 60000 : 15000);
  if (method === 'GET') s.controller = controller;
  try {
    const headers = { Authorization: 'Bearer ' + s.token };
    if (method === 'POST') Object.assign(headers, { 'Content-Type': 'application/pdf', 'X-Target': 'ja', 'X-Request-ID': s.requestID });
    const response = await fetch(ORIGIN + path, { method, headers, body, signal: controller.signal,
      credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (kind === 'page' && [202, 404, 409, 425].includes(response.status)) return null;
    if (method === 'DELETE' && response.status === 404) return;
    if (kind === 'page' && response.status === 413) {
      (s.oversizePages ??= new Set()).add(path);
      return null;
    }
    if (kind === 'pdf' && response.status === 413) {
      const saved = await request(s, s.path + '/save-final', 'GET', 'json');
      s.status.textContent = '翻訳完了 · 表示上限を超えたため、完成PDFを保存しました：' + saved.path;
      s.done = true;
      return null;
    }
    if (!response.ok) throw Object.assign(new Error(message(response.status, kind)), { transient: [408, 429, 500, 502, 503, 504].includes(response.status) });
    if (kind === 'page' || kind === 'pdf') {
      if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/pdf') throw new Error('PDF を取得できません。サービスのバージョンを確認してください。');
      return new Uint8Array(await response.arrayBuffer());
    }
    if (kind === 'json') return await response.json();
  } catch (e) {
    if (e.name === 'TypeError' || e.name === 'NetworkError' || e.name === 'AbortError') {
      throw Object.assign(new Error('ローカル翻訳サービスへの接続が途切れました。'), { transient: true });
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

function markButton(s, open) {
  s.readerDoc.getElementById(BUTTON)?.setAttribute('aria-pressed', String(open));
}

function close(s) {
  if (s.closed) return;
  s.closed = true;
  sessions.delete(s.reader.tabID);
  clearInterval(s.timer);
  stopScrollSync(s);
  s.controller?.abort();
  s.readerDoc.defaultView?.removeEventListener('unload', s.onUnload);
  closeNative(s);
  markButton(s, false);
  s.pane.remove();
  release(s);
}

function fail(s, error) {
  if (s.closed) return;
  s.failed = true;
  stopScrollSync(s);
  clearInterval(s.timer);
  s.status.textContent = error.message;
  s.retry.hidden = false;
  release(s);
}

async function refresh(s) {
  const status = await request(s, s.path, 'GET', 'json');
  if (s.closed) return;
  if (status.state === 'failed') {
    const detail = typeof status.error === 'string' ? status.error.replaceAll(s.token, '…').slice(0, 300) : '';
    throw new Error(`翻訳に失敗しました。翻訳エンジンの設定を確認して再試行してください。${detail ? ' 詳細: ' + detail : ''}`);
  }
  if (!['running', 'done'].includes(status.state) || !Number.isInteger(status.pages) || status.pages < 0) throw new Error('ジョブ状態を読み取れません。サービスのバージョンを確認してください。');
  if (status.state !== 'done') {
    await updateReadyPages(s, status.pages);
    if (!s.closed) s.status.textContent = status.pages ? `${status.pages} ページ翻訳済み · 未翻訳ページは原文です。注釈は完了後に使えます。` : '最初の翻訳ページを待っています…';
    return;
  }
  const bytes = await request(s, `${s.path}/document.pdf`, 'GET', 'pdf');
  if (!bytes || s.closed) return;
  await displayPDF(s, bytes, true, status.layoutDigest);
  if (s.closed) return;
  s.done = true;
  s.status.textContent = '翻訳完了 · 訳文に注釈を付けられます。';
}

function tick(s) {
  if (s.closed || s.failed) return;
  if (!s.pane.isConnected) { close(s); return; }
  bindScrollSource(s);
  if (s.busy || s.done || !s.path || Date.now() < s.nextStatus) return;
  s.busy = true;
  s.nextStatus = Date.now() + 1200;
  track(refresh(s).then(() => { s.delay = 0; }).catch(e => {
    if (!s.closed && e.transient) {
      s.delay = Math.min(15000, (s.delay || 750) * 2);
      s.nextStatus = Date.now() + s.delay;
      s.status.textContent = '自動で再接続しています。翻訳は最初からやり直しません。';
    } else if (!s.closed) fail(s, e);
  }).finally(() => { s.busy = false; }));
}

async function start(s) {
  s.token = await localToken();
  if (s.closed) return;
  s.item = Zotero.Items.get(s.reader.itemID);
  const path = s.item?.getFilePath();
  let file;
  try {
    if (!path) throw new Error();
    file = await File.createFromFileName(path);
  } catch (_) { throw new Error('ローカルの PDF が見つかりません。添付ファイルをダウンロードして再試行してください。'); }
  if (s.closed) return;
  const bytes = await file.arrayBuffer();
  s.digest = await pdfDigest(s.win, bytes);
  if (s.closed) return;
  s.requestID = s.win.crypto.randomUUID();
  let result;
  for (let delay = 1000; !s.closed; delay = Math.min(15000, delay * 2)) {
    try { result = await request(s, '/jobs', 'POST', 'json', bytes); break; }
    catch (e) {
      if (!e.transient) throw e;
      s.status.textContent = '翻訳サービスに自動で再接続しています…';
      await Zotero.Promise.delay(delay);
    }
  }
  if (!result && s.closed) return;
  if (typeof result?.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(result.id)) throw new Error('ジョブ ID を読み取れません。サービスのバージョンを確認してください。');
  s.path = '/jobs/' + result.id;
  // Closing mid-upload must not strand the job after the POST completes.
  if (s.closed) { await release(s); return; }
  await displayPDF(s, new Uint8Array(bytes), false);
  if (s.closed) return;
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
  const bar = el('footer');
  bar.style.cssText = 'display:flex;align-items:center;gap:.5em;flex:none;min-width:0;padding:.2em .5em;border-block-start:1px solid GrayText;font-size:.9em';
  const title = el('strong', '日本語訳');
  const retry = el('button', '再試行');
  retry.hidden = true;
  const stop = el('button', '閉じる');
  stop.title = '訳文を閉じて、翻訳ジョブを終了します';
  const status = el('div', 'PDF をローカルサービスに送信しています…');
  status.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere';
  status.className = 'anywhere-plamo-status';
  status.setAttribute('role', 'status');
  const browser = nativeReaderBrowser(doc);
  bar.append(title, status, retry, stop);
  pane.append(browser, bar);
  reader._iframe.after(pane);
  const s = { reader, readerDoc, pane, browser, win: doc.defaultView, retry, status, nextStatus: 0, scrollGeneration: 0 };
  s.onScroll = () => {
    ++s.scrollGeneration;
    if (s.frame != null || s.loading) return;
    s.frame = s.win.requestAnimationFrame(() => {
      s.frame = null;
      if (!s.loading && !s.closed) syncScroll(s);
    });
  };
  sessions.set(reader.tabID, s);
  const restart = () => { close(s); open(reader, readerDoc); };
  retry.addEventListener('click', restart);
  stop.addEventListener('click', () => close(s));
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
let cleanupSelectionTranslation;
function startup({ id, rootURI }) {
  for (const script of ['native-annotations.js', 'native-pane.js', 'selection-translation.js']) {
    Services.scriptloader.loadSubScript(rootURI + script, globalThis);
  }
  cleanupSelectionTranslation = registerSelectionTranslation(id, localToken);
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
  cleanupSelectionTranslation?.();
  cleanupSelectionTranslation = null;
  Zotero.Reader.unregisterEventListener('renderToolbar', toolbar);
  Zotero.Notifier.unregisterObserver(observer);
  for (const s of sessions.values()) close(s);
  for (const reader of Zotero.Reader._readers) reader._iframeWindow?.document?.getElementById(BUTTON)?.remove();
  await Promise.allSettled([...pending]);
}
