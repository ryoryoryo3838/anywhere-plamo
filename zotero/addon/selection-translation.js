// Loaded into a privileged subscript scope with Zotero and fetch, not into the PDF.
(function (scope) {
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
      row.style.cssText = 'box-sizing:border-box;width:100%;max-height:9em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:0.4em 0.6em;text-align:start';
      row.textContent = '日本語に翻訳中…';
      append(row); // Zotero closes append() as soon as this synchronous event returns.

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
          if (current()) row.textContent = translation;
        } catch (_) {
          if (current()) row.textContent = '翻訳できませんでした。ローカルサービスを確認し、もう一度選択してください。';
        }
      }
      const timer = win.setTimeout(translate, 180);
      const observer = new win.MutationObserver(() => { if (!row.isConnected) close(); });
      observer.observe(doc.documentElement, {childList: true, subtree: true});
      function close() {
        win.clearTimeout(timer);
        observer.disconnect();
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
