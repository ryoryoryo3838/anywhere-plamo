const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const item = { libraryID: 1, key: 'ABCD2345' };
const source = 'a'.repeat(64);
const layout = 'b'.repeat(64);
const highlight = { id: 'DEFG5678', type: 'highlight', color: '#ffd400', text: '翻訳', comment: '',
  tags: [{ name: 'review' }], sortIndex: '00000|000001|00000', position: { pageIndex: 0, rects: [[8, 16, 32, 48]] } };

async function fixture(t) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-annotations-'));
  t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
  const script = await fs.readFile(path.join(__dirname, 'addon/native-annotations.js'), 'utf8');
  function load() {
    const globals = { PathUtils: { profileDir, join: path.join }, IOUtils: {
      makeDirectory: (dir, opts) => fs.mkdir(dir, { recursive: true, mode: opts.permissions }),
      readJSON: async file => {
        try { return JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (e) { if (e.code === 'ENOENT') throw new DOMException('missing', 'NotFoundError'); throw e; }
      },
      writeJSON: async (file, data, { tmpPath }) => {
        await fs.writeFile(tmpPath, JSON.stringify(data));
        await fs.rename(tmpPath, file);
      },
    } };
    vm.runInNewContext(script, globals);
    return (i = item, lang = 'ja', hash = source, pdf = layout) => globals.createTranslationAnnotationStore(i, lang, hash, pdf);
  }
  return { load, profileDir };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('reader callback JSON survives a fresh bootstrap, including native IDs and rectangle coordinates', async t => {
  const { load } = await fixture(t);
  const store = await load()();
  await store.save([highlight]);
  assert.deepEqual(plain((await load()()).annotations), [highlight]);
});

test('two open tabs save separate batches without dropping other IDs; deletes survive stale handles', async t => {
  const { load } = await fixture(t);
  const open = load();
  const [one, two] = await Promise.all([open(), open()]);
  const other = { ...highlight, id: 'ABCD6789' };
  await Promise.all([one.save([highlight]), two.save([other])]);
  assert.deepEqual(plain((await open()).annotations).sort((a,b) => a.id.localeCompare(b.id)), [other, highlight]);
  const stale = await open();
  await one.remove([highlight.id]);
  await assert.rejects(stale.save([{ ...highlight, comment: 'late edit' }]));
  await two.save([{ ...other, comment: 'revised' }]);
  assert.deepEqual(plain((await load()()).annotations), [{ ...other, comment: 'revised' }]);
});

test('stored rectangles are isolated by library, attachment key, language, source bytes and translated bytes', async t => {
  const { load } = await fixture(t);
  const open = load();
  await (await open()).save([highlight]);
  for (const args of [[{ ...item, libraryID: 2 }], [{ ...item, key: 'ABCD4567' }], [item, 'en'],
    [item, 'ja', 'c'.repeat(64)], [item, 'ja', source, 'd'.repeat(64)]]) {
    assert.deepEqual(plain((await open(...args)).annotations), []);
  }
});

test('a stale same-ID edit cannot overwrite another tab; its other annotations can still be saved', async t => {
  const { load } = await fixture(t);
  const open = load();
  const first = await open();
  await first.save([highlight]);
  const second = await open();
  const revised = { ...highlight, comment: 'first tab edit' };
  const other = { ...highlight, id: 'ABCD6789' };
  await first.save([revised]);
  await assert.rejects(second.save([other, { ...highlight, comment: 'stale' }]));
  assert.deepEqual(plain((await open()).annotations), [revised]);
  await second.save([other]);
  assert.deepEqual(plain((await open()).annotations), [revised, other]);
});

test('a corrupt store is not treated as empty or overwritten by an open tab', async t => {
  const { load, profileDir } = await fixture(t);
  const open = load();
  const store = await open();
  await store.save([highlight]);
  const files = (await fs.readdir(profileDir, { recursive: true })).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const file = path.join(profileDir, files[0]);
  await fs.writeFile(file, 'broken json');
  await assert.rejects(open());
  await assert.rejects(store.remove([highlight.id]));
  assert.equal(await fs.readFile(file, 'utf8'), 'broken json');
});
