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
  // A native proxy exposes translated glyphs; a canvas overlay may leave the
  // original PDF's text alone. In that case accept the painted page marker.
  const progressive = n => until(`painted translation for page ${n}`, async () => {
    const app=pdf(internal()), pv=app?.pdfViewer?.getPageView(n-1), page=pv?.div;
    if (!page || pv.renderingState!==3) return false;
    const marker=`[data-anywhere-plamo-page="${n}"]`;
    if (page.matches(marker) || page.querySelector(marker)) return app;
    // Read the page actually attached to the painted view, not the source
    // pdfDocument: page proxies can come from independent one-page files.
    const glyphs=await pv.pdfPage.getTextContent();
    return (page.innerText?.includes(`Translated page ${n} paragraph 1.`) ||
      glyphs.items.map(i=>i.str).join(' ').includes(`Translated page ${n} paragraph 1.`)) && app;
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
    await IOUtils.writeUTF8('/sandbox/release-page-1','yes');
    const preview=await progressive(1);
    check((await text(preview,2)).includes('Original page 2 paragraph 1.'),'missing source fallback');
    const left = pdf(reader._internalReader), sourceRect=reader._iframe.getBoundingClientRect(), paneRect=right().getBoundingClientRect();
    check(right().contentDocument.documentURI==='resource://zotero/reader/reader.html' && left!==preview,'not separate official reader documents');
    check(paneRect.width>0 && sourceRect.width>0 && paneRect.x>=sourceRect.right-1,'not side-by-side');
    check(Math.abs(paneRect.top-sourceRect.top)<=1,'reader top edges are misaligned');
    await note('aligned tops',{sourceTop:sourceRect.top,translationTop:paneRect.top});
    await note('first progressive page',{leftWidth:sourceRect.width,rightX:paneRect.x,rightWidth:paneRect.width});
    const browser=right(), outer=browser.contentDocument, frame=outer.querySelector('#primary-view iframe');
    const content=frame.contentDocument, v=preview.pdfViewer, scroller=v.container;
    const z=v.currentScale;
    outer.getElementById('zoomIn').click(); await until('progressive toolbar zoom',()=>v.currentScale>z);
    // Straddle the page boundary so the unchanged page and the incoming page
    // are both painted. Use a non-default zoom and scroll before publication.
    const page=i=>v.getPageView(i).div;
    scroller.scrollTop+=page(1).getBoundingClientRect().top-scroller.getBoundingClientRect().top-scroller.clientHeight/2;
    await until('both pages rendered',()=>[0,1].every(i=>v.getPageView(i).renderingState===3));
    await sleep(600);
    const stable=page(0), paint=stable.querySelector('canvas'), scroll=scroller.scrollTop, scale=v.currentScale;
    const visible=stable.getBoundingClientRect().bottom-scroller.getBoundingClientRect().top;
    check(scroll>0 && visible>50 && visible<scroller.clientHeight-50,'pages do not straddle viewport');
    check(paint && paint.width>0,'unchanged page has no rendered canvas');
    // Capture the rendered viewport, not just the source PDF's backing canvas:
    // both overlay paint and native page-proxy paint must change the second page.
    const sample = i => {
      const bounds=page(i).getBoundingClientRect(), viewport=scroller.getBoundingClientRect();
      const x=Math.ceil(Math.max(bounds.left,viewport.left)+4), y=Math.ceil(Math.max(bounds.top,viewport.top)+4);
      const w=Math.floor(Math.min(bounds.right,viewport.right)-x-16), h=Math.floor(Math.min(bounds.bottom,viewport.bottom)-y-4);
      check(w>0 && h>0,'page crop not visible');
      const target=host.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml','canvas');
      target.width=w; target.height=h;
      target.getContext('2d').drawWindow(frame.contentWindow,x,y,w,h,'white');
      return target.toDataURL();
    };
    const pixels=sample(0), originalPage2=sample(1);
    await IOUtils.writeUTF8('/sandbox/release-page-2','yes');
    await progressive(2);
    await until('page two pixels changed',()=>sample(1)!==originalPage2);
    check(right()===browser && right().contentDocument===outer && frame===outer.querySelector('#primary-view iframe') && frame.contentDocument===content,'reader iframe or document replaced');
    check(pdf(internal()).pdfViewer.getPageView(0).div===stable && stable.querySelector('canvas')===paint && sample(0)===pixels,'visible unchanged page or pixels replaced');
    check(v.currentScale===scale && Math.abs(scroll-scroller.scrollTop)<=1,'progressive update changed zoom or scroll');
    await note('second progressive page',{stablePage:1,updatedPage:2,stableVisiblePixels:visible,scrollBefore:scroll,scrollAfter:scroller.scrollTop,scaleBefore:scale,scaleAfter:v.currentScale});
    await IOUtils.writeUTF8('/sandbox/finish-job','yes');
    await until('final reader ready',()=>host.querySelector('[role=status]')?.textContent.includes('翻訳完了'));
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
