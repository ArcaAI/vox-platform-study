#!/usr/bin/env python3
"""Build module/controller source map with line numbers for docs and diagrams."""
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

API = Path('/Users/apple/repos/VOX/project-hope/apps/api')
OUT = Path('/Users/apple/repos/VOX/review/api_explore/inventory')
OUT.mkdir(parents=True, exist_ok=True)

routes = json.loads((API / 'route-manifest.json').read_text())['routes']
by_ctrl = defaultdict(list)
for r in routes:
    by_ctrl[r['controller']].append(r)

class_re = re.compile(r'export\s+class\s+([A-Za-z0-9_]+)')


def find_line(path: Path, pattern: str):
    for i, line in enumerate(path.read_text(errors='ignore').splitlines(), 1):
        if re.search(pattern, line):
            return i
    return None


rows = []
for p in sorted((API / 'src/modules').rglob('*.controller.ts')):
    txt = p.read_text(errors='ignore')
    classes = re.findall(r'export\s+class\s+([A-Za-z0-9_]+Controller)', txt)
    if not classes:
        continue
    mod_dir = p.relative_to(API / 'src/modules').parts[0]
    rel = str(p.relative_to(API))
    for ctrl in classes:
        idx = find_line(p, rf'export\s+class\s+{ctrl}\b') or 1
        head = '\n'.join(txt.splitlines()[max(0, idx - 30):idx - 1])
        decorators = [ln.strip() for ln in head.splitlines() if ln.strip().startswith('@')]
        controller_path = None
        for ln in decorators:
            mm = re.match(r"@Controller\((.*)\)", ln)
            if mm:
                controller_path = mm.group(1)
        rs = by_ctrl.get(ctrl, [])
        rows.append({
            'controller': ctrl,
            'file': rel,
            'dir': mod_dir,
            'class_line': idx,
            'controller_decorator': controller_path,
            'class_decorators': decorators[-8:],
            'routes': len(rs),
            'public_routes': sum(1 for r in rs if r.get('isPublic')),
            'api_key_forbidden': sum(1 for r in rs if r.get('apiKeyForbidden')),
            'occ_routes': sum(1 for r in rs if r.get('requiresIfMatch')),
            'test_files': None,
        })

# Module class + file inventory
mod_rows = []
for d in sorted(p for p in (API / 'src/modules').iterdir() if p.is_dir()):
    mod_files = list(d.glob('*.module.ts'))
    ctrls = list(d.glob('*.controller.ts'))
    svcs = list(d.glob('*.service.ts'))
    tests = list(d.rglob('*.test.ts'))
    mod_class = None
    mod_line = None
    if mod_files:
        mk = mod_files[0].read_text(errors='ignore')
        mm = re.search(r'export\s+class\s+([A-Za-z0-9_]+Module)', mk)
        if mm:
            mod_class = mm.group(1)
            mod_line = find_line(mod_files[0], rf'export\s+class\s+{mod_class}\b')
    mod_rows.append({
        'dir': d.name,
        'module_class': mod_class,
        'module_file': str(mod_files[0].relative_to(API)) if mod_files else '',
        'module_line': mod_line,
        'controllers': len(ctrls),
        'controller_files': [str(c.relative_to(API)) for c in ctrls],
        'services': len(svcs),
        'test_files': len(tests),
        'routes': sum(len(by_ctrl.get(re.search(r'export\s+class\s+([A-Za-z0-9_]+Controller)', c.read_text(errors='ignore')).group(1), [])) for c in ctrls if re.search(r'export\s+class\s+([A-Za-z0-9_]+Controller)', c.read_text(errors='ignore'))),
    })

# Attach actual unit test file counts by controller string scan (one pass).
corpus = {}
for t in (API / 'src').rglob('*.test.ts'):
    corpus[str(t.relative_to(API))] = t.read_text(errors='ignore')
for row in rows:
    row['unit_test_files'] = sorted(f for f, txt in corpus.items() if row['controller'] in txt)
    row['test_files'] = len(row['unit_test_files'])

(OUT / 'controllers.json').write_text(json.dumps(rows, indent=1))
(OUT / 'modules.json').write_text(json.dumps(mod_rows, indent=1))

print('controllers', len(rows), 'modules', len(mod_rows))
print('controllers/routes top')
for r in sorted(rows, key=lambda x: -x['routes'])[:15]:
    print(r['routes'], r['controller'], r['dir'])
print('modules with no controller', [m['dir'] for m in mod_rows if not m['controller_files']])
