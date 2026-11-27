// Loaded into a privileged subscript scope with Zotero and fetch, not into the PDF.
(function (scope) {
  // React's popup uses a 198px cap and a native transform. Resize that popup,
  // leaving its original transform (and all annotation controls) under React's ownership.
  function fitPopup(reader, doc, row, text) {
    const popup = row.closest('.selection-popup');
    if (!popup) return () => {};
    const view = popup.closest('.secondary-view') ? 'secondary' : 'primary';
    const frame = doc.querySelector(`#${view}-view > iframe`);
    const win = doc.defaultView;
    const parent = popup.parentElement;
    const style = popup.style;
    const saved = Object.fromEntries(['width', 'maxWidth', 'maxHeight', 'translate', 'overflow'].map(k => [k, style[k]]));
    let dx = 0, dy = 0;
    function assign(key, value) { if (style[key] !== value) style[key] = value; }
    function layout() {
      if (!row.isConnected) return;
      const bounds = parent.getBoundingClientRect();
      const leftEdge = Math.max(0, bounds.left) + 12;
      const rightEdge = Math.min(win.innerWidth, bounds.right) - 12;
      const topEdge = Math.max(0, bounds.top) + 12;
      const bottomEdge = Math.min(win.innerHeight, bounds.bottom) - 12;
      if (rightEdge <= leftEdge || bottomEdge <= topEdge) return;
      // All coordinates here are CSS pixels. Range fragments already include PDF zoom
      // and rotation. The view's own popup rect also works without a DOM selection.
      const native = reader._internalReader?._state?.[`${view}ViewSelectionPopup`]?.rect;
      let x1 = native ? bounds.left + native[0] : leftEdge;
      let x2 = native ? bounds.left + native[2] : x1;
      const sel = frame?.contentWindow?.getSelection();
      if (sel?.rangeCount && !sel.isCollapsed && sel.toString().trim() === text.trim()) {
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < sel.rangeCount; i++) {
          for (const rect of sel.getRangeAt(i).getClientRects()) {
            if (rect.right > rect.left) { min = Math.min(min, rect.left); max = Math.max(max, rect.right); }
          }
        }
        if (max > min) {
          const origin = frame.getBoundingClientRect().left;
          x1 = origin + min; x2 = origin + max;
        }
      }
      const available = rightEdge - leftEdge;
      // Paragraphs need a reading column even when the reader reports only
      // the selection's last line as its anchor (common for multi-line PDFs).
      const paragraphWidth = text.length >= 120 ? Math.round(available * 0.9) : 0;
      const width = Math.min(available, Math.max(400, paragraphWidth, Math.round(x2 - x1)));
      assign('maxWidth', 'none'); assign('width', width + 'px');
      assign('maxHeight', (bottomEdge - topEdge) + 'px');
      if (popup.scrollHeight > popup.clientHeight) assign('overflow', 'auto');
      const box = popup.getBoundingClientRect();
      const x = Math.max(leftEdge, Math.min(rightEdge - box.width, (x1 + x2 - box.width) / 2));
      // Keep native vertical placement unless a taller translation would be clipped.
      const nativeTop = box.top - dy;
      const y = Math.max(topEdge, Math.min(bottomEdge - box.height, nativeTop));
      const nextX = Math.round(x - (box.left - dx)), nextY = Math.round(y - nativeTop);
      if (nextX !== dx || nextY !== dy) {
        dx = nextX; dy = nextY; style.translate = `${dx}px ${dy}px`;
      }
    }
    layout();
    // The event exposes a waived reader window. Construct observers in chrome so
    // Gecko reads our privileged options dictionary rather than an empty wrapper.
    const chrome = reader._iframe.ownerGlobal;
    const resize = new chrome.ResizeObserver(layout);
    resize.observe(parent); resize.observe(popup);
    const moved = new reader._iframe.ownerGlobal.MutationObserver(layout);
    moved.observe(popup, { attributes: true, attributeFilter: ['style'] });
    return () => { resize.disconnect(); moved.disconnect(); Object.assign(style, saved); };
  }

  scope.registerSelectionTranslation = function (pluginId, localToken) {
    const event = 'renderTextSelectionPopup';
    const active = new Map(); // Reader instances, not attachment IDs (duplicate tabs).
    let disposed = false;

    function render({ reader, doc, params, append }) {
      active.get(reader)?.();
      const text = params?.annotation?.text;
      const isSelected = () => !reader.tabID || reader._iframe.ownerGlobal.Zotero_Tabs.selectedID === reader.tabID;
      if (disposed || reader.type !== 'pdf' || typeof text !== 'string' || !text.trim() || !isSelected()) return;
      const win = doc.defaultView;
      const row = doc.createElement('div');
      row.className = 'anywhere-plamo-selection';
      row.setAttribute('role', 'status');
      row.setAttribute('lang', 'ja');
      row.style.cssText = 'box-sizing:border-box;width:100%;min-width:0;text-align:start;padding:8px 6px 4px;border-top:1px solid var(--color-panedivider)';
      const heading = doc.createElement('strong');
      heading.textContent = '日本語訳';
      heading.style.cssText = 'display:block;font-size:14px;line-height:1.5;margin-bottom:4px';
      const result = doc.createElement('div');
      result.style.cssText = 'font-size:16px;line-height:1.65;max-height:12em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere';
      result.textContent = '翻訳中…';
      row.append(heading, result);
      append(row); // Zotero closes append() as soon as this synchronous event returns.
      const restoreLayout = fitPopup(reader, doc, row, text);

      const controller = new win.AbortController();
      function current() {
        return !controller.signal.aborted && row.isConnected && isSelected();
      }
      async function translate() {
        try {
          if (!current()) return;
          const token = await localToken();
          if (!current()) return;
          const response = await scope.fetch('http://127.0.0.1:17843/translate-selection', {
            method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, target: 'ja' }), signal: controller.signal,
          });
          if (!current()) return;
          if (!response.ok) throw new Error();
          const { translation } = await response.json();
          if (typeof translation !== 'string' || !translation.trim()) throw new Error();
          if (current()) result.textContent = translation;
        } catch (_) {
          if (current()) result.textContent = '翻訳できませんでした。ローカルサービスを確認し、もう一度選択してください。';
        }
      }
      const timer = win.setTimeout(translate, 180);
      const observer = new reader._iframe.ownerGlobal.MutationObserver(() => { if (!row.isConnected) close(); });
      observer.observe(doc.documentElement, {childList: true, subtree: true});
      function close() {
        win.clearTimeout(timer);
        observer.disconnect();
        restoreLayout();
        win.removeEventListener('unload', close);
        controller.abort();
        row.remove();
        active.delete(reader);
      }
      active.set(reader, close);
      win.addEventListener('unload', close, {once: true});
    }

    scope.Zotero.Reader.registerEventListener(event, render, pluginId);
    const observer = scope.Zotero.Notifier.registerObserver({ notify(event, type, ids) {
      if (type !== 'tab') return;
      for (const [reader, close] of active) {
        if (!reader.tabID) continue;
        if ((event === 'select' && reader.tabID !== reader._iframe.ownerGlobal.Zotero_Tabs.selectedID)
          || (event === 'close' && ids.includes(reader.tabID))) close();
      }
    } }, ['tab'], pluginId + '-selection');
    return () => {
      if (disposed) return;
      disposed = true;
      scope.Zotero.Reader.unregisterEventListener(event, render);
      scope.Zotero.Notifier.unregisterObserver(observer);
      for (const close of active.values()) close();
    };
  };
})(this);
