const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(`${__dirname}/addon/bootstrap.js`, 'utf8'), ctx);

test('syncs scroll progress within the current page, not within the document', () => {
  const s = { source: { getBoundingClientRect: () => ({top: 30}), clientTop: 0, clientHeight: 400 },
    sourcePage: {}, scroll: {scrollHeight: 950, clientHeight: 450}, shown: 2, wanted: 2,
    image: {complete: true, naturalWidth: 600} };
  for (const [pageTop, expected] of [[50, 0], [-270, 250], [-600, 500]]) {
    s.sourcePage.getBoundingClientRect = () => ({top: pageTop, height: 1000});
    ctx.syncScroll(s);
    assert.equal(s.scroll.scrollTop, expected);
  }
});

test('late image load uses the latest geometry and ignores stale pages', () => {
  const s = { source: { getBoundingClientRect: () => ({top: 0}), clientTop: 0, clientHeight: 500 },
    sourcePage: {getBoundingClientRect: () => ({top: -300, height: 1000})},
    scroll: {scrollTop: 0, scrollHeight: 900, clientHeight: 400},
    shown: 1, wanted: 2, image: {complete: true, naturalWidth: 600} };
  ctx.syncScroll(s);
  assert.equal(s.scroll.scrollTop, 0);
  s.shown = 2;
  ctx.syncScroll(s);
  assert.equal(s.scroll.scrollTop, 300);
  s.scroll.clientHeight = 600;
  ctx.syncScroll(s);
  assert.equal(s.scroll.scrollTop, 180);
  s.source.clientHeight = 1200;
  ctx.syncScroll(s);
  assert.equal(s.scroll.scrollTop, 0);
});
