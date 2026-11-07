#!/usr/bin/env python3
"""Build deterministic route/test inventory for apps/api.

Reads only; writes only into ../review/api_explore.
"""
import csv
import json
import os
import re
from collections import Counter, defaultdict
from pathlib import Path

API = Path('/Users/apple/repos/VOX/project-hope/apps/api')
OUT = Path('/Users/apple/repos/VOX/review/api_explore/inventory')
OUT.mkdir(parents=True, exist_ok=True)

# ---------- controller -> file ----------
controller_file = {}
class_re = re.compile(r'export\s+class\s+([A-Za-z0-9_]+Controller)\b')
for p in (API / 'src').rglob('*.ts'):
    try:
        txt = p.read_text(errors='ignore')
    except OSError:
        continue
    for name in class_re.findall(txt):
        controller_file[name] = str(p.relative_to(API))

# ---------- openapi operation index ----------
openapi = json.loads((API / 'openapi.json').read_text())
op_by_id = {}
op_by_path = {}
for path, item in openapi.get('paths', {}).items():
    for method, op in item.items():
        if method.lower() not in {'get', 'post', 'put', 'patch', 'delete', 'head', 'options'}:
            continue
        rec = {
            'summary': op.get('summary', ''),
            'tags': op.get('tags', []),
            'operationId': op.get('operationId', ''),
            'security': [list(s.keys()) for s in op.get('security', [])],
            'deprecated': op.get('deprecated', False),
        }
        op_by_id[rec['operationId']] = rec
        op_by_path[(path, method.upper())] = rec

# ---------- route manifest ----------
manifest = json.loads((API / 'route-manifest.json').read_text())
routes = manifest['routes']

for r in routes:
    ctrl = r.get('controller', '')
    r['file'] = controller_file.get(ctrl, '')
    r['module'] = (r['file'].split('src/modules/')[-1].split('/')[0] if 'src/modules/' in r['file'] else (
        r['file'].split('src/')[-1].split('/')[0] if 'src/' in r['file'] else '')) or '(root)'
    op = op_by_id.get(f"{ctrl}_{r.get('handler','')}") or op_by_path.get((r.get('path'), r.get('method')))
    r['tag'] = (op['tags'][0] if op and op['tags'] else '')
    r['summary'] = (op['summary'] if op else '')
    r['documented'] = bool(op)
    r['auth_kind'] = 'public' if r.get('isPublic') else ('api-key-forbidden' if r.get('apiKeyForbidden') else 'api-key-allowed')
    perms = r.get('requiredPermissions') or []
    # Manifest has appeared in several shapes across passes; render defensively.
    def fmt_group(g):
        if isinstance(g, str):
            return g
        if isinstance(g, (list, tuple)):
            parts = [fmt_group(x) for x in g]
            return ':'.join(parts) if all(isinstance(x, str) for x in g) else ' AND '.join(parts)
        return str(g)
    if perms and all(isinstance(x, str) for x in perms):
        r['permissions'] = ':'.join(perms)
    else:
        r['permissions'] = ';'.join(fmt_group(grp) for grp in perms)
    r['scopes'] = ';'.join(r.get('apiKeyScopes') or []) or ';'.join(r.get('svcScopes') or [])

# ---------- test corpus ----------
test_files = []
for root in [API / 'src', API / 'tests', API / 'test']:
    if not root.exists():
        continue
    for p in root.rglob('*'):
        if p.is_file() and re.search(r'\.(test|spec)\.ts$', p.name):
            test_files.append(p)
test_corpus = {str(p.relative_to(API)): p.read_text(errors='ignore') for p in test_files}

def refs_for(ctrl, handler, path, route_path):
    """Classify test references: controller-level unit refs vs route-level e2e refs."""
    frag = re.sub(r'^/api/v1', '', path)
    frag = re.sub(r':[A-Za-z0-9_]+', '', frag).rstrip('/')
    e2e, unit = set(), set()
    for f, txt in test_corpus.items():
        is_e2e = f.startswith('tests/e2e/') or f.startswith('test/')
        is_unit = ('/__tests__/' in f) or f.startswith('tests/unit/') or f.startswith('tests/integration/')
        # route-level evidence: the literal route path appears in the test
        route_hit = bool(route_path and len(route_path) > 8 and route_path in txt) or (
            bool(frag and len(frag) > 8) and frag in txt)
        # controller-level evidence: controller class + handler name both appear
        ctrl_hit = bool(ctrl and ctrl in txt)
        handler_hit = bool(handler and len(handler) > 4 and handler in txt)
        if is_e2e and (route_hit or (ctrl_hit and handler_hit)):
            e2e.add(f)
        elif is_unit and (ctrl_hit or (route_hit and handler_hit)):
            unit.add(f)
    return sorted(unit), sorted(e2e)

for r in routes:
    unit, e2e = refs_for(r.get('controller', ''), r.get('handler', ''), r.get('path', ''), r.get('routePath', ''))
    r['unit_tests'] = unit
    r['e2e_tests'] = e2e
    r['tests'] = sorted(set(unit) | set(e2e))

# ---------- outputs ----------
fields = ['method', 'path', 'routePath', 'controller', 'handler', 'file', 'module', 'tag', 'summary',
          'isPublic', 'apiKeyForbidden', 'apiKeyScopes', 'svcScopes', 'permissions', 'permissionMode',
          'requiresIfMatch', 'apiExcluded', 'documented', 'auth_kind', 'unit_tests', 'e2e_tests', 'tests']
with (OUT / 'routes.csv').open('w', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=fields, extrasaction='ignore')
    w.writeheader()
    for r in sorted(routes, key=lambda x: (x.get('module', ''), x.get('file', ''), x.get('path', ''), x.get('method', ''))):
        row = dict(r)
        row['unit_tests'] = ';'.join(r.get('unit_tests', []))
        row['e2e_tests'] = ';'.join(r.get('e2e_tests', []))
        row['tests'] = ';'.join(r.get('tests', []))
        w.writerow(row)

with (OUT / 'routes.json').open('w') as fh:
    json.dump(routes, fh, indent=1)

by_module = defaultdict(list)
for r in routes:
    by_module[r.get('module') or '(root)'].append(r)

lines = ['# Route inventory by module', '',
         f'Generated from `route-manifest.json` ({len(routes)} routes) and `openapi.json` ({len(openapi.get("paths", {}))} documented paths).',
         '', '| Module | Controllers | Routes | Public | API-key allowed | OCC | Unit-ref | E2E route-ref |',
         '|---|---:|---:|---:|---:|---:|---:|---:|']
for mod in sorted(by_module):
    rs = by_module[mod]
    ctrls = len({r['controller'] for r in rs})
    pub = sum(1 for r in rs if r.get('isPublic'))
    akey = sum(1 for r in rs if not r.get('isPublic') and not r.get('apiKeyForbidden'))
    occ = sum(1 for r in rs if r.get('requiresIfMatch'))
    unit = sum(1 for r in rs if r.get('unit_tests'))
    e2e = sum(1 for r in rs if r.get('e2e_tests'))
    lines.append(f'| `{mod}` | {ctrls} | {len(rs)} | {pub} | {akey} | {occ} | {unit} | {e2e} |')
lines.append('')
lines.append('## Controller detail')
for mod in sorted(by_module):
    lines.append(f'### `{mod}`')
    lines.append('')
    for ctrl in sorted({r['controller'] for r in by_module[mod]}):
        rs = [r for r in by_module[mod] if r['controller'] == ctrl]
        rel = rs[0].get('file') or '[TODO]'
        lines.append(f'- **{ctrl}** — `{rel}` — {len(rs)} routes')
    lines.append('')
(OUT / 'routes-by-module.md').write_text('\n'.join(lines))

# auth / exposure summary
public = [r for r in routes if r.get('isPublic')]
excluded = [r for r in routes if r.get('apiExcluded')]
no_perm = [r for r in routes if not r.get('isPublic') and not r.get('requiredPermissions') and not r.get('svcScopes')]
no_test = [r for r in routes if not r.get('tests')]
no_route_test = [r for r in routes if not r.get('e2e_tests')]
no_doc = [r for r in routes if not r.get('documented')]
summary = {
    'routes': len(routes),
    'controllers': len({r['controller'] for r in routes}),
    'modules': len({r['module'] for r in routes}),
    'public_routes': len(public),
    'api_key_forbidden': sum(1 for r in routes if r.get('apiKeyForbidden')),
    'api_key_allowed': sum(1 for r in routes if not r.get('apiKeyForbidden') and not r.get('isPublic')),
    'requires_if_match': sum(1 for r in routes if r.get('requiresIfMatch')),
    'api_excluded': len(excluded),
    'no_permission_and_no_scope': len(no_perm),
    'routes_without_any_test_reference': len(no_test),
    'routes_without_e2e_route_reference': len(no_route_test),
    'routes_without_openapi_operation': len(no_doc),
    'method_counts': dict(Counter(r.get('method') for r in routes)),
    'controllers_without_any_test_reference': sorted({r['controller'] for r in no_test}),
    'openapi_paths': len(openapi.get('paths', {})),
}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=1))
print(json.dumps(summary, indent=1))
