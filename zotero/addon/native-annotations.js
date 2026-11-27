/* Load once into the add-on bootstrap scope; all reader tabs share its write queue. */
const translatedAnnotationQueues = new Map();

function withAnnotationFile(file, operation) {
  const previous = translatedAnnotationQueues.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  translatedAnnotationQueues.set(file, next);
  return next.finally(() => {
    if (translatedAnnotationQueues.get(file) === next) translatedAnnotationQueues.delete(file);
  });
}

async function createTranslationAnnotationStore(sourceItem, targetLang, documentIdentity, translatedIdentity = documentIdentity) {
  const { libraryID, key } = sourceItem;
  const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!Number.isSafeInteger(libraryID) || libraryID <= 0 || typeof key !== 'string' || !/^[A-Z0-9]{8}$/.test(key)
      || typeof targetLang !== 'string' || !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8}){0,6}$/.test(targetLang)
      || !digest(documentIdentity) || !digest(translatedIdentity)) {
    throw new Error('Invalid translated annotation store identity');
  }
  const dir = PathUtils.join(PathUtils.profileDir, 'anywhere-plamo-zotero', 'annotations-v1',
    `${libraryID}-${key}`, targetLang.toLowerCase(), documentIdentity);
  const file = PathUtils.join(dir, `${translatedIdentity}.json`);
  await IOUtils.makeDirectory(dir, { createAncestors: true, permissions: 0o700 });
  async function read() {
    let annotations;
    try { annotations = await IOUtils.readJSON(file); }
    catch (e) { if (e.name === 'NotFoundError') return []; throw e; }
    if (!Array.isArray(annotations) || annotations.some(a => !a || typeof a.id !== 'string' || !a.id)
        || new Set(annotations.map(a => a.id)).size !== annotations.length) {
      throw new Error('Invalid stored annotations');
    }
    return annotations;
  }
  const annotations = await withAnnotationFile(file, read);
  const seen = new Map(annotations.map(a => [a.id, JSON.stringify(a)]));
  function change(entries, deleting) {
    return withAnnotationFile(file, async () => {
      const current = new Map((await read()).map(a => [a.id, a]));
      for (const [id, value] of entries) {
        if (typeof id !== 'string' || !id) throw new Error('Invalid annotation ID');
        const stored = JSON.stringify(current.get(id));
        if (stored !== seen.get(id) && stored !== JSON.stringify(value)) {
          throw new Error('Annotation changed in another tab. Reopen the translated reader before editing.');
        }
        if (deleting) current.delete(id);
        else current.set(id, value);
      }
      await IOUtils.writeJSON(file, Array.from(current.values()), { tmpPath: `${file}.tmp`, flush: true });
      for (const [id, value] of entries) {
        if (deleting) seen.delete(id);
        else seen.set(id, JSON.stringify(value));
      }
    });
  }
  return { annotations,
    async save(batch) {
      if (!Array.isArray(batch)) throw new TypeError('Expected reader annotation array');
      // Detach callback data before yielding: its iframe may close before the disk write.
      if (batch.length) await change(JSON.parse(JSON.stringify(batch)).map(a => [a.id, a]), false);
    },
    async remove(ids) {
      if (!Array.isArray(ids)) throw new TypeError('Expected reader annotation ID array');
      if (ids.length) await change(Array.from(ids, id => [id, undefined]), true);
    },
  };
}
