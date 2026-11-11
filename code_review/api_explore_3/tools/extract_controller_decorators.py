#!/usr/bin/env python3
import pathlib, re
from collections import defaultdict, Counter

ROOT = pathlib.Path('/Users/apple/repos/VOX/project-hope/apps/api/src')
OUT = pathlib.Path('/Users/apple/repos/VOX/vox-platform-study/code_review/api_explore_3/cross-cutting/controller-decorator-trace.md')

DECORATOR_PURPOSE = {
    'Controller': 'Declares a Nest controller and its base route/path prefix; groups HTTP handlers.',
    'Get': 'Maps HTTP GET requests on the given route to the method.',
    'Post': 'Maps HTTP POST requests on the given route to the method.',
    'Put': 'Maps HTTP PUT requests on the given route to the method.',
    'Patch': 'Maps HTTP PATCH requests on the given route to the method.',
    'Delete': 'Maps HTTP DELETE requests on the given route to the method.',
    'Options': 'Maps HTTP OPTIONS requests on the given route to the method.',
    'Head': 'Maps HTTP HEAD requests on the given route to the method.',
    'All': 'Maps all HTTP methods on the given route to the method.',
    'Sse': 'Maps a route to a Server-Sent Events stream response.',
    'UseGuards': 'Attaches guard(s) at controller or method scope; guards run before handler (and before interceptors) and can allow/deny/transform access.',
    'UseInterceptors': 'Attaches interceptor(s) at controller or method scope; interceptors can run logic before/after handler and transform request/response/stream.',
    'UsePipes': 'Attaches pipe(s) at controller or method scope; pipes transform/validate handler arguments before method execution.',
    'UseFilters': 'Attaches exception filter(s) at controller or method scope; filters handle exceptions thrown from the route context they cover.',
    'Public': 'Marks route/controller as public to bypass global auth enforcement where honored (e.g. UnifiedAuthGuard opt-out metadata).',
    'Authorize': 'Applies authorization/policy requirements for the route/controller (project-specific decorator; typically used with global auth/policy guards).',
    'RequiredScopes': 'Declares required user/API scopes for access checks (metadata consumed by auth/authorization guards).',
    'RequiredSvcScopes': 'Declares required service scopes for service-to-service access checks (metadata consumed by guards).',
    'RequiresConsent': 'Declares consent/ABAC requirement metadata; enforced by PatientConsentGuard when present.',
    'RequiresIfMatch': 'Marks route as requiring/propagating If-Match precondition handling for optimistic concurrency flow (paired with ExpectedVersion).',
    'TenantOwnedResource': 'Declares resource ownership metadata used by tenant-ownership interceptor/SSE guard to enforce tenant/resource access.',
    'TenantLockExempt': 'Exempts handler/controller from tenant restore-lock blocking where honored by TenantLockGuard.',
    'HttpCode': 'Overrides the HTTP status code returned for successful responses from the handler.',
    'Header': 'Sets/overrides response headers for the handler (Nest built-in).',
    'Redirect': 'Issues a redirect response for the handler (Nest built-in).',
    'ApiBearerAuth': 'Swagger/OpenAPI metadata: marks endpoint/controller as bearer-authenticated.',
    'ApiSecurity': 'Swagger/OpenAPI metadata: declares security scheme requirement.',
    'ApiTags': 'Swagger/OpenAPI metadata: groups endpoints under a tag.',
    'ApiExcludeController': 'Swagger/OpenAPI metadata: excludes controller from generated API docs.',
    'ApiExcludeEndpoint': 'Swagger/OpenAPI metadata: excludes endpoint from generated API docs.',
    'ApiOperation': 'Swagger/OpenAPI metadata: documents operation summary/description.',
    'ApiParam': 'Swagger/OpenAPI metadata: documents path parameter.',
    'ApiQuery': 'Swagger/OpenAPI metadata: documents query parameter.',
    'ApiHeader': 'Swagger/OpenAPI metadata: documents request header.',
    'ApiBody': 'Swagger/OpenAPI metadata: documents request body.',
    'ApiResponse': 'Swagger/OpenAPI metadata: documents response status/type.',
    'ApiOkResponse': 'Swagger/OpenAPI metadata: documents 200 response.',
    'ApiCreatedResponse': 'Swagger/OpenAPI metadata: documents 201 response.',
    'ApiConsumes': 'Swagger/OpenAPI metadata: declares accepted request content types.',
    'ApiProduces': 'Swagger/OpenAPI metadata: declares produced response content types.',
    'ApiDeprecated': 'Swagger/OpenAPI metadata: marks endpoint/controller as deprecated.',
    'ApiEndpoint': 'Project-specific API/documentation/behavior decorator (inspect implementation for exact request impact).',
    'StreamScope': 'Project-specific streaming scope/authorization metadata decorator (inspect implementation for exact request impact).',
    'ForbidApiKey': 'Project-specific auth policy metadata: forbids API-key credential usage for the route/controller where enforced.',
    'Version': 'Nest versioning metadata; can route requests based on API version.',
    'SerializeOptions': 'Configures response serialization behavior for class-transformer/Nest serializer.',
    'Throttle': 'Overrides throttling metadata for route/controller (nestjs/throttler; actual enforcement depends on guard).',
    'SkipThrottle': 'Skips throttling for route/controller where honored by throttler guard.',
}

HTTP_METHOD_DECOS = {'Get','Post','Put','Patch','Delete','Options','Head','All','Sse'}
REQUEST_AFFECTING = {'UseGuards','UseInterceptors','UsePipes','UseFilters','Public','Authorize','RequiredScopes','RequiredSvcScopes','RequiresConsent','RequiresIfMatch','TenantOwnedResource','TenantLockExempt','ForbidApiKey','HttpCode','Header','Redirect','Throttle','SkipThrottle','Version','ApiEndpoint','StreamScope'}


def read_text(p):
    return p.read_text(encoding='utf-8', errors='replace')

def slugify(text):
    s = text.lower()
    s = re.sub(r'[`*~\[\](){}<>:,."\'/\\|?!@#$%^&+=]', '', s)
    s = re.sub(r'\s+', '-', s.strip())
    s = re.sub(r'-+', '-', s)
    return s.strip('-')

def deco_name(d):
    m=re.match(r'@([A-Za-z0-9_]+)', d.strip())
    return m.group(1) if m else d.strip()

def purpose_for(name):
    return DECORATOR_PURPOSE.get(name, 'Project/custom decorator (or not in common legend); inspect source for exact request impact.')

def format_deco(d):
    return f"`{d}` — {purpose_for(deco_name(d))}"

def normalize_deco_block(block_text):
    parts=[]; cur=[]; depth=0
    for line in block_text.splitlines():
        s=line.strip()
        if s.startswith('@') and depth==0 and cur:
            parts.append('\n'.join(cur)); cur=[line.rstrip()]
        elif cur:
            cur.append(line.rstrip())
        elif s.startswith('@'):
            cur=[line.rstrip()]
        depth += line.count('(') - line.count(')')
        if depth < 0: depth = 0
    if cur: parts.append('\n'.join(cur))
    out=[]
    for p in parts:
        t=re.sub(r'\s*\n\s*',' ',p.strip())
        t=re.sub(r'\s+',' ',t)
        out.append(t)
    return [d for d in out if d.lstrip().startswith('@')]

def collect_decorators_above(lines, idx):
    j=idx-1
    while j>=0 and lines[j].strip()=='':
        j-=1
    if j<0 or not lines[j].lstrip().startswith('@'):
        return []
    end=j; start=end
    depth = lines[end].count('(')-lines[end].count(')')
    k=end-1
    while k>=0:
        st=lines[k].strip(); raw=lines[k]
        if st=='':
            if depth!=0:
                start=k; k-=1; continue
            else:
                k-=1; continue
        if st.startswith('@'):
            start=k
            depth += raw.count('(')-raw.count(')')
            k-=1; continue
        if depth!=0:
            start=k
            depth += raw.count('(')-raw.count(')')
            k-=1; continue
        if st.endswith((',', '(', '[', '{')) or st.startswith((')',']','}','.')):
            start=k
            depth += raw.count('(')-raw.count(')')
            k-=1; continue
        break
    block='\n'.join(lines[start:end+1])
    return normalize_deco_block(block)

def find_controller_classes(lines):
    classes=[]
    for i,l in enumerate(lines):
        m=re.match(r'^export\s+(?:default\s+)?class\s+(\w+)', l.strip())
        if not m: continue
        decos=collect_decorators_above(lines,i)
        if any(deco_name(d)=='Controller' for d in decos):
            classes.append((i,m.group(1),decos))
    return classes

def parse_methods(lines, class_idx):
    methods=[]
    cls_indent=len(lines[class_idx]) - len(lines[class_idx].lstrip(' '))
    n=len(lines)
    brace_depth=0; seen_open=False
    j=class_idx
    while j<n and not seen_open:
        brace_depth += lines[j].count('{') - lines[j].count('}')
        if '{' in lines[j]: seen_open=True
        j+=1
    i=j; member_indent=cls_indent+2
    while i<n and (seen_open and brace_depth>0):
        line=lines[i]; s=line.strip()
        if s=='':
            brace_depth += line.count('{')-line.count('}'); i+=1; continue
        ind=len(line)-len(line.lstrip(' '))
        if ind==member_indent and s.startswith('@'):
            k=i
            while k<n:
                st=lines[k].strip(); indk=len(lines[k])-len(lines[k].lstrip(' '))
                if st=='': k+=1; continue
                if indk==member_indent and st.startswith('@'): k+=1; continue
                break
            if k<n and (len(lines[k])-len(lines[k].lstrip(' '))==member_indent):
                sig=lines[k].strip()
                if not sig.startswith('constructor'):
                    mm=re.match(r'(?:public\s+|private\s+|protected\s+|readonly\s+|async\s+|static\s+|get\s+|set\s+)*([A-Za-z0-9_]+)\s*[<(]', sig)
                    if mm and not re.match(r'^(if|for|while|switch|catch)\b', sig):
                        name=mm.group(1)
                        if name!='constructor':
                            decos=collect_decorators_above(lines,k)
                            # avoid including class-level block if parser over-captured: keep decorators that are adjacent to method signature only
                            # heuristic: keep until we have seen a mapping/decorator that commonly appears on methods? easier: filter out @Controller class block duplicates
                            m_decos=[]
                            for d in decos:
                                if deco_name(d)=='Controller':
                                    continue
                                # class-level common swagger/auth decorators may be duplicated if formatting odd; but keep
                                m_decos.append(d)
                            methods.append((name,m_decos,sig,k+1))
                brace_depth += lines[k].count('{')-lines[k].count('}')
                i=k+1; continue
        elif ind==member_indent and re.match(r'(?:public\s+|private\s+|protected\s+|readonly\s+|async\s+|static\s+|get\s+|set\s+)*[A-Za-z0-9_]+\s*[<(]', s) and not s.startswith('constructor'):
            mm=re.match(r'(?:public\s+|private\s+|protected\s+|readonly\s+|async\s+|static\s+|get\s+|set\s+)*([A-Za-z0-9_]+)\s*[<(]', s)
            if mm and not re.match(r'^(if|for|while|switch|catch)\b', s):
                decos=[d for d in collect_decorators_above(lines,i) if deco_name(d)!='Controller']
                methods.append((mm.group(1), decos, s, i+1))
        brace_depth += line.count('{')-line.count('}')
        i+=1
    return methods

files=[]
for p in ROOT.rglob('*.ts'):
    if '__tests__' in p.parts: continue
    if p.name.endswith('.module.ts'): continue
    txt=read_text(p)
    if '@Controller' not in txt: continue
    lines=txt.splitlines()
    classes=find_controller_classes(lines)
    if not classes: continue
    rel=p.relative_to(ROOT); parts=rel.parts
    module = parts[1] if len(parts)>2 and parts[0]=='modules' else '(global)'
    for cidx,cname,cdecos in classes:
        methods=parse_methods(lines,cidx)
        files.append({'module':module,'path':str(rel),'class':cname,'class_decos':cdecos,'methods':methods})

by_mod=defaultdict(list)
for f in sorted(files, key=lambda x:(x['module'], x['path'], x['class'])):
    by_mod[f['module']].append(f)

# stats
module_count = len(by_mod)
controller_count = len(files)
method_count = sum(len(f['methods']) for f in files)
controllers_with_methods = sum(1 for f in files if f['methods'])

class_deco_counter=Counter(); method_deco_counter=Counter(); http_counter=Counter()
mod_method_counts=[]; mod_controller_counts=[]
for mod in sorted(by_mod.keys(), key=lambda m:(m!='(global)',m)):
    mc=sum(len(f['methods']) for f in by_mod[mod])
    mod_method_counts.append((mod, len(by_mod[mod]), mc))
    mod_controller_counts.append((mod, len(by_mod[mod])))

for f in files:
    for d in f['class_decos']: class_deco_counter[deco_name(d)] += 1
    for _, decos, _, _ in f['methods']:
        names=[deco_name(d) for d in decos]
        for n in names: method_deco_counter[n]+=1
        for n in names:
            if n in HTTP_METHOD_DECOS: http_counter[n]+=1

def count_any(deco):
    return class_deco_counter.get(deco,0)+method_deco_counter.get(deco,0)

useguards = count_any('UseGuards')
useinterceptors = count_any('UseInterceptors')
usepipes = count_any('UsePipes')
usefilters = count_any('UseFilters')
public_n = count_any('Public')
authorize_n = count_any('Authorize')
req_scopes = count_any('RequiredScopes')
req_svc_scopes = count_any('RequiredSvcScopes')
consent_n = count_any('RequiresConsent')
ifmatch_n = count_any('RequiresIfMatch')
forbid_api = count_any('ForbidApiKey')
tenant_owned = count_any('TenantOwnedResource')
sse_n = http_counter.get('Sse',0)

top_modules_by_handlers = sorted(mod_method_counts, key=lambda x:(-x[2], x[0]))[:10]
top_modules_by_controllers = sorted(mod_method_counts, key=lambda x:(-x[1], x[0]))[:10]

mods = sorted(by_mod.keys(), key=lambda m: (m!='(global)', m))

out=[]
out.append('# Controller Decorator Trace (Modules → Controllers → Methods)')
out.append('')
out.append('**Scope:** `project-hope/apps/api/src` (non-test Nest controllers)  ')
out.append('**Generated by:** `code_review/api_explore_3/tools/extract_controller_decorators.py` (heuristic AST-lite extraction)  ')
out.append('**Companion docs:** `nestjs-request-pipeline.md`, `bootstrap-and-global-config.md`')
out.append('')
out.append('## Executive summary (quick read)')
out.append('')
out.append('This document inventories **Nest controller and route-handler decorators** in the API gateway so you can trace request behavior from **module → controller → method** without reading every source file.')
out.append('')
out.append('### Snapshot counts')
out.append('')
out.append(f'- **Modules (groups):** {module_count} (controllers outside `apps/api/src/modules/` are grouped as `(global)`)')
out.append(f'- **Controllers:** {controller_count}')
out.append(f'- **Detected route handler methods:** {method_count} ({controllers_with_methods} controllers with detected methods; heuristic parse)')
out.append(f'- **HTTP/SSE mapping decorators (method-level, detected):** {sum(http_counter.values())} total' + (f" — " + ', '.join(f"`@{k}` {v}" for k,v in sorted(http_counter.items(), key=lambda x:(-x[1],x[0])) ) if http_counter else ''))
out.append('')
out.append('### Request-pipeline/security signals (declared decorators, class + method)')
out.append('')
out.append(f'- **Scoped guards (`@UseGuards`) declarations:** {useguards} — explicit controller/method guard attachment in addition to global guards in `app.module.ts`.')
out.append(f'- **Scoped interceptors (`@UseInterceptors`) declarations:** {useinterceptors} — explicit controller/method interceptors (e.g. upload/file and response-vocabulary interceptors).')
out.append(f'- **Scoped pipes/filters (`@UsePipes` / `@UseFilters`) declarations:** {usepipes} / {usefilters} — rare in this snapshot (global pipe/filter strategy dominates).')
out.append(f'- **Auth/policy metadata:** `@Public` {public_n}, `@Authorize` {authorize_n}, `@RequiredScopes` {req_scopes}, `@RequiredSvcScopes` {req_svc_scopes}, `@ForbidApiKey` {forbid_api}.')
out.append(f'- **Domain/consistency metadata:** `@RequiresConsent` {consent_n}, `@RequiresIfMatch` {ifmatch_n}, `@TenantOwnedResource` {tenant_owned}, `@Sse` routes {sse_n}.')
out.append('')
out.append('### What this means (for non-readers)')
out.append('')
out.append('- **Most request enforcement is layered:** global bootstrap/middleware + global guards/interceptors/pipes/filters + controller/method decorators + parameter/DTO validation. A controller with few local decorators can still be heavily protected globally.')
out.append('- **`@UseGuards` at controller/method scope is significant:** it usually marks internal/service-token boundaries, SSE/resource-specific checks, or endpoint-specific policy beyond the global chain.')
out.append('- **`@UseInterceptors` at controller/method scope is targeted:** in this codebase it commonly appears for multipart/file upload handling and specific response/event vocabulary shaping.')
out.append('- **Auth metadata is widespread:** decorators like `@Authorize`, `@RequiredScopes`, `@RequiredSvcScopes`, and `@Public` communicate intended access policy and are consumed by guards/audits (not all enforcement happens in the decorator itself).')
out.append('- **Use this doc as an index:** start with the TOC/module summaries below, then jump to a controller to inspect class-level defaults and per-method overrides.')
out.append('')
out.append('### Largest modules by detected handlers (top 10)')
out.append('')
out.append('| Module | Controllers | Detected handlers |')
out.append('|---|---:|---:|')
for mod, c, m in top_modules_by_handlers:
    out.append(f'| `{mod}` | {c} | {m} |')
out.append('')
out.append('## Table of contents')
out.append('')
out.append('- [Executive summary (quick read)](#executive-summary-quick-read)')
out.append('  - [Snapshot counts](#snapshot-counts)')
out.append('  - [Request-pipeline/security signals (declared decorators, class + method)](#request-pipelinesecurity-signals-declared-decorators-class--method)')
out.append('  - [What this means (for non-readers)](#what-this-means-for-non-readers)')
out.append('  - [Largest modules by detected handlers (top 10)](#largest-modules-by-detected-handlers-top-10)')
out.append('- [Decorator purpose legend (common)](#decorator-purpose-legend-common)')
out.append('- [Inventory](#inventory)')
for mod in mods:
    mod_title = f'Module: `{mod}`'
    mod_anchor = slugify(mod_title)
    mc=len(by_mod[mod]); mm=sum(len(f["methods"]) for f in by_mod[mod])
    out.append(f'  - [{mod_title}](#{mod_anchor}) ({mc} controllers, {mm} handlers)')
    for f in by_mod[mod]:
        ctitle = f'Controller: `{f["class"]}`'
        c_anchor = slugify(ctitle)
        out.append(f'    - [{ctitle}](#{c_anchor}) — `{f["path"]}` ({len(f["methods"]) } handlers)')
out.append('- [Extraction notes](#extraction-notes)')
out.append('')
out.append('> Note: GitHub-style heading anchors are used. If your renderer generates anchors differently, use the module/controller headings in the Inventory section as the source of truth.')
out.append('')
out.append('## Decorator purpose legend (common)')
out.append('')
for k in sorted(DECORATOR_PURPOSE.keys()):
    out.append(f'- `@{k}`: {DECORATOR_PURPOSE[k]}')
out.append('')
out.append('## Inventory')
out.append('')

for mod in mods:
    mod_title = f'Module: `{mod}`'
    out.append(f'### {mod_title}')
    mod_handlers=sum(len(f['methods']) for f in by_mod[mod])
    out.append('')
    out.append(f'**Module summary:** {len(by_mod[mod])} controller(s), {mod_handlers} detected handler method(s)')
    out.append('')
    for f in by_mod[mod]:
        ctrl_route = next((d for d in f['class_decos'] if deco_name(d)=='Controller'), '')
        out.append(f'#### Controller: `{f["class"]}`')
        out.append(f'- **File:** `project-hope/apps/api/src/{f["path"]}`')
        if ctrl_route:
            out.append(f'- **Base route:** `{ctrl_route}`')
        out.append('- **Class-level decorators (applied to all routes in controller unless overridden/narrowed):**')
        if f['class_decos']:
            for d in f['class_decos']:
                out.append(f'  - {format_deco(d)}')
        else:
            out.append('  - _(none detected)_')
        out.append('- **Methods / handlers:**')
        if f['methods']:
            for name, decos, sig, ln in f['methods']:
                http = [deco_name(d) for d in decos if deco_name(d) in HTTP_METHOD_DECOS]
                http_s = ', '.join(f'@{h}' for h in http) if http else '_(no HTTP/SSE mapping decorator detected)_'
                out.append(f'  - **`{name}`** (line {ln}) — {http_s}')
                out.append(f'    - Signature: `{sig}`')
                if decos:
                    out.append('    - Decorators (request impact):')
                    for d in decos:
                        out.append(f'      - {format_deco(d)}')
                else:
                    out.append('    - Decorators (request impact): _(none detected; inherits controller/global behavior)_')
        else:
            out.append('  - _(no method handlers detected by heuristic parser; inspect source)_')
        out.append('')

out.append('## Extraction notes')
out.append('')
out.append('- Grouping: `apps/api/src/modules/<module>/...` -> `<module>`; controllers outside `modules/` -> `(global)`.')
out.append('- Heuristic parser: regex/indentation/brace-based extraction (not a full TypeScript AST). Complex formatting, unusual indentation, or decorators inside comments/strings may affect results; verify against source when needed.')
out.append('- This report emphasizes class/method decorators. Parameter decorators/pipes (e.g. `@Body()`, `@Param()`, `@Query()`, inline pipes) and DTO validation rules also affect request handling but are not exhaustively expanded here.')
out.append('- Global pipeline effects from `main.ts` and `app.module.ts` (middleware, global guards/interceptors/pipes/filters, ETag, validation, auth context) apply in addition to controller/method decorators; see `nestjs-request-pipeline.md`.')

OUT.write_text('\n'.join(out), encoding='utf-8')
print(f'wrote {OUT} with {len(files)} controllers in {len(by_mod)} groups, {method_count} methods')
