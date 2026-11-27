/* Same Zotero 10 content browser as ReaderTab, but no backing Zotero item. */
function saveTranslated(s, method, entries) {
  if (!s.store || !entries.length) return Promise.resolve();
  const copy = JSON.parse(JSON.stringify(entries));
  return track(s.store[method](copy).catch(() => {
    Zotero.logError(new Error('Anywhere PLaMo: 訳文の注釈を保存できませんでした。'));
    if (!s.closed) {
      s.right.setReadOnly(true);
      s.status.textContent = '訳文の注釈を保存できませんでした。注釈の編集を停止しました。';
    }
  }));
}

function closeNative(s) {
  // Copy pending edits before disposing of their content realm.
  if (s.store) {
    const changes = s.right?._annotationManager?._unsavedAnnotations;
    if (changes?.size) {
      const saves = [], removes = [];
      for (const [id, annotation] of changes) {
        if (annotation) saves.push(annotation); else removes.push(id);
      }
      saveTranslated(s, 'save', saves);
      saveTranslated(s, 'remove', removes);
    }
  }
  s.blocker?.unregister(s.browser);
}

function nativeReaderOptions(s, bytes) {
  const ftl = [];
  for (const locale of [...Services.locale.appLocalesAsBCP47].reverse()) {
    for (const file of ['branding/brand.ftl', 'zotero.ftl', 'reader.ftl']) {
      try { ftl.push(Zotero.File.getContentsFromURL(`resource://app/localization/${locale}/${file}`)); }
      catch (_) { /* ReaderInstance likewise ignores missing locales. */ }
    }
  }
  const noop = () => {};
  return {
    type: 'pdf', data: { buf: bytes }, annotations: [], readOnly: true,
    primaryViewState: { pageIndex: 0, scale: 'page-width', scrollMode: 0, spreadMode: 0 },
    sidebarOpen: false, showContextPaneToggle: false, enableReadAloud: false,
    ftl, rtl: Zotero.rtl, fontSize: Zotero.Prefs.get('fontSize'),
    textSelectionAnnotationMode: Zotero.Prefs.get('reader.textSelectionAnnotationMode'),
    onSaveAnnotations: (entries, ack) => { saveTranslated(s, 'save', entries).finally(() => { if (!s.closed) ack(); }); },
    onDeleteAnnotations: ids => { saveTranslated(s, 'remove', ids); },
    onOpenContextMenu: () => { s.right.openContextMenu(s.browser.contentWindow.wrappedJSObject.contextMenuParams); },
    // The frontend already sets text/plain. Never forward IDs or PDF edits
    // to source item callbacks, including for group-library sources.
    onSetDataTransferAnnotations: noop, onChangeViewState: noop, onChangeSidebarView: noop,
    onToggleSidebar: noop, onChangeSidebarWidth: noop, onOpenLink: noop,
    onOpenTagsPopup: noop, onRotatePages: noop, onDeletePages: noop,
    onSetZoom: (frame, zoom) => { frame.browsingContext.fullZoom = zoom; },
    onConfirm: (title, text) => Services.prompt.confirm(s.win, title, text),
    onTextSelectionAnnotationModeChange: noop
  };
}

function nativeReaderBrowser(doc) {
  const browser = doc.createXULElement('browser');
  browser.setAttribute('class', 'anywhere-plamo-native-reader');
  browser.setAttribute('type', 'content');
  browser.setAttribute('tooltip', 'html-tooltip');
  browser.setAttribute('src', 'resource://zotero/reader/reader.html');
  browser.style.cssText = 'flex:1;min-height:0;min-width:0;width:100%';
  return browser;
}

function activePDF(reader) {
  const view = reader?._state?.primary === false ? reader._secondaryView : reader?._primaryView;
  return view?._iframeWindow?.PDFViewerApplication?.pdfViewer;
}

// Use the page at the viewport top, not the toolbar's most-visible page.
// The latter can change halfway down a page and make the right side jump.
function pageAnchor(pdf) {
  if (!pdf?.pagesCount) return null;
  const top = pdf.container.getBoundingClientRect().top + pdf.container.clientTop;
  let lo = 0, hi = pdf.pagesCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pdf.getPageView(mid).div.getBoundingClientRect().bottom <= top) lo = mid + 1;
    else hi = mid;
  }
  const rect = pdf.getPageView(lo).div.getBoundingClientRect();
  return rect.height > 0 ? { index: lo, fraction: (top - rect.top) / rect.height } : null;
}

function syncScroll(s) {
  const anchor = pageAnchor(activePDF(s.reader._internalReader));
  const target = activePDF(s.right);
  if (!anchor || !target || anchor.index >= target.pagesCount) return;
  const rect = target.getPageView(anchor.index).div.getBoundingClientRect();
  const viewport = target.container;
  if (rect.height) viewport.scrollTop += rect.top - viewport.getBoundingClientRect().top - viewport.clientTop + anchor.fraction * rect.height;
}

function bindScrollSource(s) {
  const source = activePDF(s.reader._internalReader)?.container;
  if (s.source === source) return;
  s.source?.removeEventListener('scroll', s.onScroll);
  s.source = source;
  source?.addEventListener('scroll', s.onScroll, { passive: true });
  if (source) s.onScroll();
}

function stopScrollSync(s) {
  s.source?.removeEventListener('scroll', s.onScroll);
  if (s.frame != null) s.win.cancelAnimationFrame(s.frame);
}

async function displayPDF(s, bytes, final, layoutDigest) {
  const first = !s.right;
  const validLayout = typeof layoutDigest === 'string' && /^[0-9a-f]{64}$/.test(layoutDigest);
  const identity = final && (validLayout ? layoutDigest : await pdfDigest(s.win, bytes));
  const store = final && await createTranslationAnnotationStore(s.item, 'ja', s.digest, identity);
  if (s.closed) return;
  const generation = s.scrollGeneration;
  s.loading = true;
  try {
    const deadline = Date.now() + 30000;
    while (!s.browser.contentWindow?.wrappedJSObject?.createReader) {
      if (s.closed) return;
      if (Date.now() >= deadline) throw new Error('Zotero リーダーを起動できませんでした。');
      await Zotero.Promise.delay(50);
    }
    const win = s.browser.contentWindow;
    const clone = value => Components.utils.cloneInto(value, win);
    if (first) {
      const { BlockingObserver } = ChromeUtils.importESModule('chrome://zotero/content/BlockingObserver.mjs');
      s.blocker = new BlockingObserver({ shouldBlock: uri => ['http', 'https'].includes(uri.scheme) });
      s.blocker.register(s.browser);
      s.right = win.wrappedJSObject.createReader(Components.utils.cloneInto(nativeReaderOptions(s, bytes), win, { cloneFunctions: true }));
    } else {
      // reload() uses the last debounced view state. Copy PDF.js's current
      // location first so a recent manual right-side scroll or zoom survives.
      const pdf = s.right._primaryView._iframeWindow.PDFViewerApplication.pdfViewer;
      const loc = pdf._location;
      if (loc) s.right._state.primaryViewState = clone({ pageIndex: loc.pageNumber - 1,
        scale: loc.scale, top: loc.top, left: loc.left, scrollMode: pdf.scrollMode, spreadMode: pdf.spreadMode });
      s.right.reload(clone({ buf: bytes }));
    }
    let ready = false;
    s.right._primaryView.initializedPromise.then(() => { ready = true; });
    while (!ready) {
      if (s.closed) return;
      if (Date.now() >= deadline) throw new Error('訳文の PDF を表示できませんでした。');
      await Zotero.Promise.delay(50);
    }
    if (s.closed) return;
    if (first || s.scrollGeneration !== generation) syncScroll(s);
    if (final) {
      s.right.setAnnotations(clone(store.annotations));
      s.store = store;
      s.right.setReadOnly(false);
    }
  } finally { s.loading = false; }
}

async function pdfDigest(win, data) {
  const hash = await win.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
