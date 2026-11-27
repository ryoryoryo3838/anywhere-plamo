; (async () => {
  const note = (stage, data={}) => IOUtils.writeUTF8('/sandbox/result.jsonl', JSON.stringify({stage,...data})+'\n', {mode:'append'});
  const sleep = ms => Zotero.Promise.delay(ms);
  const check = (v, m) => { if (!v) throw Error(m); };
  let reader, toolbar, host;
  const until = async (name, read) => {
    let last;
    for (let i=0;i<120;i++) { try { const value=await Promise.race([Promise.resolve().then(read),sleep(250).then(()=>null)]); if(value) return value; } catch(e) {last=String(e);} await sleep(125); }
    throw Error(`${name} timed out; status=${host?.querySelector('[role=status]')?.textContent}; last=${last}`);
  };
  const right = () => host?.querySelector('.anywhere-plamo-native-reader');
  const internal = () => right()?.contentWindow?.wrappedJSObject?._reader;
  const pdf = r => r?._primaryView?._iframeWindow?.PDFViewerApplication;
  const chars = async (app,n) => (await app.pdfDocument.getPageData(Cu.cloneInto({pageIndex:n-1},app.pdfDocument))).chars;
  const text = async (app,n) => (await chars(app,n)).map(c=>c.u+(c.spaceAfter||c.lineBreakAfter||c.paragraphBreakAfter?' ':'')).join('').replace(/\s+/g,' ');
  const translated = (n, expected) => until(`page ${n} contains ${expected}`,async()=>{
    const app=pdf(internal()); return app?.pdfDocument && (await text(app,n)).includes(expected) && app;
  });
  try {
    await Zotero.uiReadyPromise; check(Zotero.version==='10.0.8', 'Requires Zotero 10.0.8');
    const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const addon=await AddonManager.installTemporaryAddon(Zotero.File.pathToFile('/sandbox/test.xpi'));
    await note('installed',{version:Zotero.version,id:addon.id,home:Services.dirsvc.get('Home',Ci.nsIFile).path});
    await Zotero.Libraries.userLibrary.waitForDataLoad('item'); await sleep(3000);
    const item=await Zotero.Attachments.importFromFile({file:Zotero.File.pathToFile('/sandbox/fixtures/source.pdf')});
    reader=await Zotero.Reader.open(item.id); await reader._initPromise; host=reader._iframe.parentElement;
    toolbar=await until('source toolbar',()=>reader._iframeWindow.document.querySelector('#anywhere-plamo-toolbar'));
    check(toolbar.textContent==='訳','wrong source button'); toolbar.click(); await note('clicked 訳');
    const preview=await translated(1,'Translated page 1 paragraph 1.');
    check((await text(preview,2)).includes('Original page 2 paragraph 1.'),'preview missing source fallback');
    const left = pdf(reader._internalReader), sourceRect=reader._iframe.getBoundingClientRect(), paneRect=right().getBoundingClientRect();
    check(right().contentDocument.documentURI==='resource://zotero/reader/reader.html' && left!==preview,'not separate official reader documents');
    check(paneRect.width>0 && sourceRect.width>0 && paneRect.x>=sourceRect.right-1,'not side-by-side');
    check(Math.abs(paneRect.top-sourceRect.top)<=1,'reader top edges are misaligned');
    await note('aligned tops',{sourceTop:sourceRect.top,translationTop:paneRect.top});
    await note('progressive official reader',{page1:(await text(preview,1)).slice(0,32),page2:(await text(preview,2)).slice(0,32),leftWidth:sourceRect.width,rightX:paneRect.x,rightWidth:paneRect.width});
    await IOUtils.writeUTF8('/sandbox/finish-job','yes');
    const app=await translated(2,'Translated page 2 paragraph 1.'); const view=app.pdfViewer;
    check((await text(left,2)).includes('Original page 2 paragraph 1.'),'source changed');
    const doc=right().contentDocument;
    const zoom=await until('zoom in',()=>doc.getElementById('zoomIn')); const initial=view.currentScale; zoom.click();
    await until('zoom effect',()=>view.currentScale>initial); await note('right toolbar zoom',{initial,after:view.currentScale,page2:(await text(app,2)).slice(0,32)});
    const src=left.pdfViewer;
    const fraction=(vw,n)=>{const page=vw.getPageView(n).div.getBoundingClientRect();return (vw.container.getBoundingClientRect().top+vw.container.clientTop-page.top)/page.height;};
    for(const [n,f] of [[0,.35],[1,.04]]) {
      const pg=src.getPageView(n).div, ct=src.container; ct.scrollTop+=(f-fraction(src,n))*pg.getBoundingClientRect().height;
      await until('source to right scroll',()=>Math.abs(fraction(src,n)-f)<.03 && Math.abs(fraction(view,n)-fraction(src,n))<.035);
      await note('scroll sync',{page:n+1,source:fraction(src,n),translated:fraction(view,n)});
    }
    const p1=view.getPageView(0).div.getBoundingClientRect(), p2=view.getPageView(1).div.getBoundingClientRect();
    check(Math.abs(p1.x-p2.x)<2 && p2.top>=p1.bottom-2,'not continuous vertical pages');
    src.container.scrollTop=0; await until('return to first page',()=>Math.abs(fraction(view,0))<.035);
    // Drag across actual PDF text in the inner content frame, then click the native selection popup.
    const inn=doc.querySelector('#primary-view iframe').contentWindow; const utils=inn.windowUtils;
    const pg=view.getPageView(0), letters=await chars(app,1);
    const last=letters.findIndex(c=>c.u==='.'); check(last>0,'first line not found');
    const firstRect=letters[0].rect,lastRect=letters[last].rect;
    const r=pg.div.querySelector('canvas').getBoundingClientRect(), vp=pg.viewport;
    const [px,py]=vp.convertToViewportPoint(firstRect[0],(firstRect[1]+firstRect[3])/2);
    const x=r.x+px*r.width/vp.width, y=r.y+py*r.height/vp.height;
    const dx=(lastRect[2]-firstRect[0])*vp.scale*r.width/vp.width;
    await note('drag translated text',{x,y,dx,target:inn.document.elementFromPoint(x+1,y)?.className});
    utils.sendMouseEvent('mousedown',x+1,y,0,1,0); for(let i=1;i<=16;i++){utils.sendMouseEvent('mousemove',x+dx*i/16,y,0,0,0); await sleep(16);} utils.sendMouseEvent('mouseup',x+dx,y,0,1,0);
    const color=await until('translated selection popup',()=>doc.querySelector('.selection-popup .color-button')); color.click();
    const annotation=await until('saved highlight',()=>internal()._state.annotations.find(a=>a.type==='highlight' && a.text.includes('Translated page 1')));
    const {id,text:selection}=annotation; await note('highlight created',{id,selection});
    await sleep(1800); toolbar.click(); await until('pane closed',()=>!right()); toolbar.click();
    await translated(2,'Translated page 2 paragraph 1.');
    await until('persisted highlight after reopen',()=>internal()._state.annotations.some(a=>a.id===id && a.text===selection));
    check(!item.getAnnotations().length,'translation annotation leaked into source'); toolbar.click();
    await until('second job released',async()=> (await IOUtils.readUTF8('/sandbox/requests.jsonl')).split('\n').filter(s=>s.includes('"DELETE"')).length===2);
    await note('PASS',{reopenedHighlight:id,sourceAnnotations:item.getAnnotations().length});
  } catch(e) { await note('FAIL',{error:String(e),stack:e.stack}); }
  finally { Services.startup.quit(Ci.nsIAppStartup.eForceQuit); }
})();
