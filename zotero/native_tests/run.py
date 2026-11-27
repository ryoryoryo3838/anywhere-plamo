"""Run the packaged extension inside a fresh, network-isolated Zotero 10.0.8."""
from collections import Counter
from pathlib import Path
import hashlib
import json
import os
import runpy
import secrets
import shutil
import subprocess as sp
import tempfile
import zipfile

here = Path(__file__).resolve().parent
p = Path(tempfile.mkdtemp(prefix='native-reader-acceptance-', dir=os.environ['TMPDIR']))
print(f'Evidence: {p}', flush=True)
u, a = [Path(sp.check_output(['flatpak', 'info', '--show-location', ref], text=True).strip()) / 'files'
        for ref in ('org.freedesktop.Platform//25.08', 'org.zotero.Zotero')]
for n in ('profile', 'data', 'home/.config/anywhere-plamo-zotero', 'tmp', 'run'):
    (p/n).mkdir(mode=0o700, parents=True)
token = p/'home/.config/anywhere-plamo-zotero/token'
token.write_text(secrets.token_urlsafe(32)); token.chmod(0o600)
shutil.copytree(here/'fixtures', p/'fixtures'); shutil.copy(here/'mock.py', p)
(p/'result.jsonl').touch()
prefs = {'extensions.zotero.dataDir': '/sandbox/data', 'extensions.zotero.useDataDir': True,
         'extensions.zotero.firstRun': False, 'extensions.zotero.httpServer.enabled': False,
         'extensions.autoDisableScopes': 0, 'extensions.enabledScopes': 15,
         'toolkit.telemetry.reportingpolicy.firstRun': False}
(p/'profile/user.js').write_text('\n'.join(f'user_pref({json.dumps(k)}, {json.dumps(v)});' for k,v in prefs.items()))
xpi = runpy.run_path(str(here.parent/'build.py'))['build'](here.parent/'addon', p/'test.xpi')
print('XPI SHA256:', hashlib.sha256(xpi.read_bytes()).hexdigest(), flush=True)
# Instrument only the disposable host window: reader libraries and XPI stay untouched.
entry = 'chrome/content/zotero/zoteroPane.js'
with zipfile.ZipFile(a/'share/zotero/app/omni.ja') as src, zipfile.ZipFile(p/'omni.ja', 'w') as dst:
    assert entry in src.namelist()
    for inf in src.infolist():
        dst.writestr(inf, src.read(inf) + (b'\n' + (here/'ui.js').read_bytes() if inf.filename == entry else b''))
cmd = ['bwrap','--die-with-parent','--unshare-all','--ro-bind',u,'/usr','--ro-bind',a,'/app',
       '--ro-bind',p/'omni.ja','/app/share/zotero/app/omni.ja','--symlink','usr/bin','/bin',
       '--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--ro-bind',u/'etc','/etc',
       '--ro-bind','/etc/passwd','/etc/passwd','--ro-bind','/etc/group','/etc/group','--dev','/dev',
       '--proc','/proc','--tmpfs','/tmp','--tmpfs','/run','--bind',p,'/sandbox','--clearenv']
for k,v in {'HOME':'/sandbox/home','TMPDIR':'/sandbox/tmp','XDG_RUNTIME_DIR':'/sandbox/run',
            'PATH':'/app/bin:/usr/bin','MOZ_HEADLESS':'1','MOZ_HEADLESS_WIDTH':'1600','MOZ_HEADLESS_HEIGHT':'900',
            'MOZ_DISABLE_CONTENT_SANDBOX':'1','LD_LIBRARY_PATH':'/app/share/zotero:/app/lib:/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu/pulseaudio'}.items():
    cmd += ['--setenv', k, v]
cmd += ['--chdir','/sandbox','/bin/bash','-c', 'python3 -u mock.py >requests.jsonl 2>&1 & exec /app/share/zotero/zotero -no-remote -profile /sandbox/profile -headless -ZoteroDebugText']
with (p/'native.log').open('w') as log:
    result=sp.run(cmd, stdout=log, stderr=sp.STDOUT, timeout=180)
records = [json.loads(s) for s in (p/'result.jsonl').read_text().splitlines()]
print(json.dumps(records, ensure_ascii=False, indent=2)); result.check_returncode()
requests = [json.loads(s) for s in (p/'requests.jsonl').read_text().splitlines()]
inventory = Counter(f"{r['method']} {r['path']} {r['status']}" for r in requests)
print('Request inventory:', json.dumps(inventory, indent=2), flush=True)
assert all(r['auth'] and r['status'] < 400 for r in requests), inventory
if not records or records[-1]['stage'] != 'PASS': raise SystemExit(1)
assert sum(r['method']=='POST' for r in requests)==2, inventory
for n, artifacts in [(1,['pages/1.pdf','pages/2.pdf','document.pdf']), (2,['document.pdf'])]:
    path = f'/jobs/{n:032x}'
    assert inventory[f'DELETE {path} 200']==1, inventory
    assert [r['path'][len(path)+1:] for r in requests if r['path'].startswith(path+'/')] == artifacts, inventory
