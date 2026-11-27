"""Build the Anywhere Plamo Zotero plugin without touching any profile."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json


def build(source, destination):
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    if not manifest['applications']['zotero']['id'] or not (source / 'bootstrap.js').is_file():
        raise ValueError('Missing Zotero ID or bootstrap.js')
    files = sorted(p for p in source.rglob('*') if p.is_file())
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
        for file in files:
            archive.write(file, file.relative_to(source))
    with ZipFile(destination) as archive:
        assert archive.testzip() is None
        assert all(archive.read(f.relative_to(source).as_posix()) == f.read_bytes() for f in files)
    return destination


if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    print(build(root / 'addon', root / 'dist' / 'anywhere-plamo-zotero.xpi'))
