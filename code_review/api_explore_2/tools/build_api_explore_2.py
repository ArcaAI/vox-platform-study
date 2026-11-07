#!/usr/bin/env python3
"""Build comprehensive API inventory and call-tree catalog for apps/api.

Reads only:
  - /Users/apple/repos/VOX/project-hope/apps/api
  - /Users/apple/repos/VOX/project-hope/packages/applications

Writes only:
  - /Users/apple/repos/VOX/review/api_explore_2/inventory
"""

import csv
import json
import os
import re
from collections import defaultdict
from pathlib import Path

API_DIR = Path('/Users/apple/repos/VOX/project-hope/apps/api')
PKGS_DIR = Path('/Users/apple/repos/VOX/project-hope/packages')
OUT_DIR = Path('/Users/apple/repos/VOX/review/api_explore_2/inventory')
OUT_DIR.mkdir(parents=True, exist_ok=True)

# -------------------------------------------------------------
# 1. Map controllers to file paths and parse constructor injections
# -------------------------------------------------------------
controller_info = {}

def clean_comments(text):
    # Remove single line comments
    text = re.sub(r'//.*', '', text)
    # Remove multiline comments
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    return text

def parse_controller_file(file_path):
    try:
        text = file_path.read_text(errors='ignore')
    except OSError:
        return {}

    controllers = {}
    class_matches = list(re.finditer(r'export\s+class\s+([A-Za-z0-9_]+Controller)\b', text))
    
    for i, m in enumerate(class_matches):
        cname = m.group(1)
        class_start = m.start()
        class_end = class_matches[i+1].start() if i+1 < len(class_matches) else len(text)
        class_text = text[class_start:class_end]

        # Extract class decorators
        pre_class = text[:class_start]
        # Look backwards for decorators before export class
        lines = pre_class.strip().split('\n')
        decorators = []
        for line in reversed(lines):
            line_s = line.strip()
            if line_s.startswith('@'):
                decorators.insert(0, line_s)
            elif not line_s:
                continue
            else:
                break

        # Extract constructor
        ctor_m = re.search(r'constructor\s*\((.*?)\)\s*\{', class_text, re.DOTALL)
        injected = {}
        if ctor_m:
            params_raw = clean_comments(ctor_m.group(1))
            # Match constructor params:
            # e.g. @Inject(TOKEN) private readonly name: Type
            param_pattern = re.compile(
                r'(?:@Inject\(([^)]+)\)\s+)?(?:@Optional\(\)\s+)?'
                r'(?:private|protected|public)?\s*(?:readonly)?\s*'
                r'(\w+)\??\s*:\s*([^,;)]+)'
            )
            for pm in param_pattern.finditer(params_raw):
                token, prop_name, type_name = pm.groups()
                injected[prop_name] = {
                    'token': token.strip() if token else None,
                    'type': type_name.strip()
                }

        controllers[cname] = {
            'name': cname,
            'file': str(file_path.relative_to(API_DIR)),
            'abs_file': str(file_path),
            'decorators': decorators,
            'injected': injected,
            'class_text': class_text
        }

    return controllers

for p in (API_DIR / 'src').rglob('*.ts'):
    if 'controller' in p.name:
        for cname, cinfo in parse_controller_file(p).items():
            controller_info[cname] = cinfo

print(f"Loaded {len(controller_info)} controller classes from source files.")

# -------------------------------------------------------------
# 2. Extract method bodies and their downstream calls
# -------------------------------------------------------------
def find_method_body(class_text, method_name):
    # Match: [private|protected|public] [async] method_name(...)
    pattern = rf'\b(?:(?:private|protected|public)\s+)?(?:async\s+)?{re.escape(method_name)}\s*\('
    m = re.search(pattern, class_text)
    if not m:
        return ''
    
    # Balance parens to find end of parameters
    i = m.end() - 1
    depth = 0
    while i < len(class_text):
        if class_text[i] == '(':
            depth += 1
        elif class_text[i] == ')':
            depth -= 1
            if depth == 0:
                break
        i += 1

    # Find opening brace {
    rest = class_text[i+1:]
    brace_m = re.search(r'^\s*(?::\s*[^{]+)?\{', rest)
    if not brace_m:
        return ''
    
    body_start = i + 1 + brace_m.end() - 1
    body_depth = 0
    j = body_start
    while j < len(class_text):
        if class_text[j] == '{':
            body_depth += 1
        elif class_text[j] == '}':
            body_depth -= 1
            if body_depth == 0:
                return class_text[body_start:j+1]
        j += 1
    return class_text[body_start:]

def extract_calls_from_body(body, injected, class_text, visited_locals=None):
    if visited_locals is None:
        visited_locals = set()

    service_calls = []
    # Find this.<field>.<method>(
    direct_calls = re.findall(r'this\.(\w+)\.([A-Za-z0-9_]+)\(', body)
    for field, method in direct_calls:
        if field in injected:
            service_calls.append({
                'kind': 'injected_service',
                'field': field,
                'method': method,
                'service_type': injected[field]['type'],
                'token': injected[field]['token']
            })
        elif field in {'httpService', 'http'}:
            service_calls.append({
                'kind': 'http_call',
                'field': field,
                'method': method,
                'service_type': 'HttpService (Downstream HTTP)',
                'token': None
            })
        elif field in {'eventEmitter', 'events'}:
            service_calls.append({
                'kind': 'event_emit',
                'field': field,
                'method': method,
                'service_type': 'EventEmitter2',
                'token': None
            })
        elif 'queue' in field.lower():
            service_calls.append({
                'kind': 'queue_operation',
                'field': field,
                'method': method,
                'service_type': 'BullMQ Queue',
                'token': None
            })
        else:
            service_calls.append({
                'kind': 'member_call',
                'field': field,
                'method': method,
                'service_type': 'unknown',
                'token': None
            })

    # Check for calls to local helper methods: this.<method>(
    local_calls = re.findall(r'this\.([A-Za-z0-9_]+)\(', body)
    known_fields = set(injected.keys()) | {
        'logger', 'cls', 'config', 'httpService', 'eventEmitter', 'databaseService'
    }
    candidate_locals = [x for x in local_calls if x not in known_fields and x not in visited_locals]

    sub_trees = []
    for loc in set(candidate_locals):
        visited_locals.add(loc)
        loc_body = find_method_body(class_text, loc)
        if loc_body:
            sub_calls, _ = extract_calls_from_body(loc_body, injected, class_text, visited_locals)
            if sub_calls:
                sub_trees.append({
                    'helper_method': loc,
                    'calls': sub_calls
                })

    return service_calls, sub_trees

# -------------------------------------------------------------
# 3. Read OpenAPI & Route Manifest to stitch together complete record
# -------------------------------------------------------------
manifest_path = API_DIR / 'route-manifest.json'
manifest = json.loads(manifest_path.read_text())

openapi_path = API_DIR / 'openapi.json'
openapi = json.loads(openapi_path.read_text()) if openapi_path.exists() else {}

op_by_id = {}
op_by_path = {}
for path, item in openapi.get('paths', {}).items():
    for method, op in item.items():
        if method.lower() not in {'get', 'post', 'put', 'patch', 'delete', 'head', 'options'}:
            continue
        rec = {
            'summary': op.get('summary', ''),
            'description': op.get('description', ''),
            'tags': op.get('tags', []),
            'operationId': op.get('operationId', ''),
            'parameters': op.get('parameters', []),
            'responses': list(op.get('responses', {}).keys())
        }
        op_by_id[rec['operationId']] = rec
        op_by_path[(path, method.upper())] = rec

catalog = []
for r in manifest['routes']:
    ctrl_name = r.get('controller', '')
    handler_name = r.get('handler', '')
    method = r.get('method', 'GET')
    path = r.get('path', '')
    route_path = r.get('routePath', '')

    ctrl = controller_info.get(ctrl_name)
    file_rel = ctrl['file'] if ctrl else ''
    
    # Determine module directory
    module_name = '(root)'
    if file_rel:
        if 'src/modules/' in file_rel:
            module_name = file_rel.split('src/modules/')[1].split('/')[0]
        elif 'src/' in file_rel:
            module_name = file_rel.split('src/')[1].split('/')[0]

    # OpenAPI match
    op = op_by_id.get(f"{ctrl_name}_{handler_name}") or op_by_path.get((path, method))

    # Parse call tree
    calls = []
    helper_trees = []
    if ctrl and handler_name:
        body = find_method_body(ctrl['class_text'], handler_name)
        if body:
            calls, helper_trees = extract_calls_from_body(body, ctrl['injected'], ctrl['class_text'])

    # Format permissions and scopes
    perms = r.get('requiredPermissions') or []
    def fmt_perm(p):
        if isinstance(p, list):
            return ':'.join(str(x) for x in p)
        return str(p)
    formatted_perms = [fmt_perm(p) for p in perms]

    entry = {
        'id': f"{method} {path}",
        'method': method,
        'path': path,
        'routePath': route_path,
        'controller': ctrl_name,
        'handler': handler_name,
        'file': file_rel,
        'module': module_name,
        'summary': op.get('summary', '') if op else '',
        'description': op.get('description', '') if op else '',
        'tags': op.get('tags', []) if op else [],
        'isPublic': r.get('isPublic', False),
        'apiKeyForbidden': r.get('apiKeyForbidden', False),
        'apiKeyScopes': r.get('apiKeyScopes', []),
        'svcScopes': r.get('svcScopes', []),
        'requiredPermissions': formatted_perms,
        'requiresIfMatch': r.get('requiresIfMatch', False),
        'apiExcluded': r.get('apiExcluded', False),
        'injected_services_available': list(ctrl['injected'].keys()) if ctrl else [],
        'direct_service_calls': calls,
        'helper_method_calls': helper_trees,
    }
    catalog.append(entry)

print(f"Built catalog with {len(catalog)} routes.")

# Save JSON catalog
(OUT_DIR / 'api-route-call-tree-catalog.json').write_text(json.dumps(catalog, indent=2))
print("Saved inventory/api-route-call-tree-catalog.json")

# -------------------------------------------------------------
# 4. Generate CSV export
# -------------------------------------------------------------
csv_file = OUT_DIR / 'api-catalog.csv'
with open(csv_file, 'w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f)
    writer.writerow([
        'Method', 'Path', 'Module', 'Controller', 'Handler', 
        'Summary', 'Auth / Permissions', 'API Key Scopes', 'Service Scopes', 
        'OCC (If-Match)', 'Primary Downstream Calls', 'File'
    ])
    for r in catalog:
        downstream = []
        for c in r['direct_service_calls']:
            downstream.append(f"{c['service_type']}.{c['method']}")
        for h in r['helper_method_calls']:
            for c in h['calls']:
                downstream.append(f"{h['helper_method']}()->{c['service_type']}.{c['method']}")
        
        auth_info = "Public" if r['isPublic'] else (', '.join(r['requiredPermissions']) or 'Authenticated')
        writer.writerow([
            r['method'],
            r['path'],
            r['module'],
            r['controller'],
            r['handler'],
            r['summary'],
            auth_info,
            ', '.join(r['apiKeyScopes']),
            ', '.join(r['svcScopes']),
            'Yes' if r['requiresIfMatch'] else 'No',
            '; '.join(sorted(set(downstream))),
            r['file']
        ])
print("Saved inventory/api-catalog.csv")

# -------------------------------------------------------------
# 5. Generate Markdown Call-Trees By Module
# -------------------------------------------------------------
routes_by_module = defaultdict(list)
for r in catalog:
    routes_by_module[r['module']].append(r)

md_lines = [
    "# API Route Catalog & Call-Trees By Module\n",
    f"Total Routes Documented: **{len(catalog)}** across **{len(routes_by_module)}** modules.\n",
    "This document details every route, its handling controller method, and the hierarchical service call tree.\n",
    "---\n"
]

for mod in sorted(routes_by_module.keys()):
    mod_routes = routes_by_module[mod]
    md_lines.append(f"## Module: `{mod}` ({len(mod_routes)} routes)\n")
    
    # Group by controller within module
    routes_by_ctrl = defaultdict(list)
    for r in mod_routes:
        routes_by_ctrl[r['controller']].append(r)

    for ctrl_name, c_routes in sorted(routes_by_ctrl.items()):
        file_path = c_routes[0]['file']
        md_lines.append(f"### Controller: `{ctrl_name}`")
        md_lines.append(f"**File:** [`{file_path}`](file:///Users/apple/repos/VOX/project-hope/apps/api/{file_path})\n")
        
        md_lines.append("| Method | Path | Handler | Auth & Scopes | OCC | Summary |")
        md_lines.append("|---|---|---|---|---|---|")
        for r in c_routes:
            auth_str = "Public" if r['isPublic'] else (
                f"Perms: `{':'.join(r['requiredPermissions'])}`" if r['requiredPermissions'] else "Auth"
            )
            if r['apiKeyScopes']:
                auth_str += f"<br/>API Key: `{','.join(r['apiKeyScopes'])}`"
            if r['svcScopes']:
                auth_str += f"<br/>Svc: `{','.join(r['svcScopes'])}`"
            occ_str = "Yes" if r['requiresIfMatch'] else "-"
            summary_str = r['summary'] or "-"
            md_lines.append(f"| `{r['method']}` | `{r['path']}` | `{r['handler']}` | {auth_str} | {occ_str} | {summary_str} |")
        md_lines.append("")

        # Add call tree details for handlers with calls
        md_lines.append("#### Handler Call Trees:\n")
        has_any_calls = False
        for r in c_routes:
            calls = r['direct_service_calls']
            helpers = r['helper_method_calls']
            if not calls and not helpers:
                continue
            has_any_calls = True
            md_lines.append(f"**`{r['method']} {r['path']}` → `{ctrl_name}.{r['handler']}`**")
            md_lines.append("```text")
            md_lines.append(f"[{r['method']} {r['path']}]")
            md_lines.append(f"  └── Controller: {ctrl_name}.{r['handler']}()")
            for c in calls:
                token_info = f" [token: {c['token']}]" if c['token'] else ""
                md_lines.append(f"        ├── calls: this.{c['field']}.{c['method']}()")
                md_lines.append(f"        │     └─ Service: {c['service_type']}{token_info}")
            for h in helpers:
                md_lines.append(f"        ├── calls helper: this.{h['helper_method']}()")
                for hc in h['calls']:
                    token_info = f" [token: {hc['token']}]" if hc['token'] else ""
                    md_lines.append(f"        │     ├── calls: this.{hc['field']}.{hc['method']}()")
                    md_lines.append(f"        │     │     └─ Service: {hc['service_type']}{token_info}")
            md_lines.append("```\n")
        
        if not has_any_calls:
            md_lines.append("_Handlers in this controller delegate directly or return static/mapped payloads._\n")

    md_lines.append("---\n")

(OUT_DIR / 'call-trees-by-module.md').write_text('\n'.join(md_lines))
print("Saved inventory/call-trees-by-module.md")
