#!/usr/bin/env python3
import pathlib, re
from collections import defaultdict

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
    'ApiProperty': 'Swagger/OpenAPI DTO schema metadata for a property.',
    'ApiPropertyOptional': 'Swagger/OpenAPI DTO schema metadata for an optional property.',
    'ApiEndpoint': 'Project-specific API/documentation/behavior decorator (inspect implementation for exact request impact).',
    'StreamScope': 'Project-specific streaming scope/authorization metadata decorator (inspect implementation for exact request impact).',
    'Version': 'Nest versioning metadata; can route requests based on API version.',
    'SerializeOptions': 'Configures response serialization behavior for class-transformer/Nest serializer.',
    'Throttle': 'Overrides throttling metadata for route/controller (nestjs/throttler; actual enforcement depends on guard).',
    'SkipThrottle': 'Skips throttling for route/controller where honored by throttler guard.',
}

def read_text(p):
    return p.read_text(encoding='utf-8', errors='replace')

def deco_name(d):
    m=re.match(r'@([A-Za-z0-9_]+)', d.strip())
    return m.group(1) if m else d.strip()

def purpose_for(name):
    return DECORATOR_PURPOSE.get(name, 'Project/custom decorator (or not in common legend); inspect source for exact request impact.')

def format_deco(d):
    return f"`{d}` — {purpose_for(deco_name(d))}"

def normalize_deco_block(block_text):
    # split into decorator entries by @ at depth 0
    parts=[]; cur=[]; depth=0
    for line in block_text.splitlines():
        s=line.strip()
        if s.startswith('@') and depth==0 and cur:
            parts.append('\n'.join(cur))
            cur=[line.rstrip()]
        elif cur:
            cur.append(line.rstrip())
        elif s.startswith('@'):
            cur=[line.rstrip()]
        else:
            # ignore stray
            pass
        depth += line.count('(') - line.count(')')
        if depth < 0: depth = 0
    if cur: parts.append('\n'.join(cur))
    out=[]
    for p in parts:
        t=re.sub(r'\s*\n\s*',' ',p.strip())
        t=re.sub(r'\s+',' ',t)
        out.append(t)
    return out

def collect_decorators_above(lines, idx):
    # idx is line index of target (class or method signature)
    j=idx-1
    # skip blanks
    while j>=0 and lines[j].strip()=='':
        j-=1
    if j<0 or not lines[j].lstrip().startswith('@'):
        # could still be part of multiline decorator block ending above? unlikely
        return []
    end=j
    start=end
    depth = lines[end].count('(')-lines[end].count(')')
    k=end-1
    # walk up including @ lines and continuation lines
    while k>=0:
        st=lines[k].strip()
        raw=lines[k]
        if st=='':
            if depth!=0:
                start=k; k-=1; continue
            else:
                k-=1; continue
        if st.startswith('@'):
            start=k
            depth += raw.count('(')-raw.count(')')
            k-=1
            continue
        # continuation if unbalanced or clearly arg line (indented, not a code stmt boundary)
        if depth!=0:
            start=k
            depth += raw.count('(')-raw.count(')')
            k-=1
            continue
        # heuristic: line ending with comma/paren/bracket often continuation in decorator args even if balanced miscount rare
        if st.endswith((',', '(', '[', '{')) or st.startswith((')',']','}','.')):
            start=k
            depth += raw.count('(')-raw.count(')')
            k-=1
            continue
        break
    block='\n'.join(lines[start:end+1])
    decos=normalize_deco_block(block)
    # ensure they look like decorators
    return [d for d in decos if d.lstrip().startswith('@')]

def find_controller_classes(lines):
    classes=[]
    for i,l in enumerate(lines):
        m=re.match(r'^export\s+(?:default\s+)?class\s+(\w+)', l.strip())
        if not m:
            continue
        decos=collect_decorators_above(lines,i)
        if any(deco_name(d)=='Controller' for d in decos):
            classes.append((i,m.group(1),decos))
    return classes

def parse_methods(lines, class_idx):
    methods=[]
    # determine class indent
    cls_indent=len(lines[class_idx]) - len(lines[class_idx].lstrip(' '))
    i=class_idx+1
    n=len(lines)
    # crude brace tracking to stay inside class
    # find opening brace line at or after class decl
    brace_depth=0
    seen_open=False
    # initialize from class line onward until first {
    j=class_idx
    while j<n and not seen_open:
        brace_depth += lines[j].count('{') - lines[j].count('}')
        if '{' in lines[j]: seen_open=True
        j+=1
    i=j
    member_indent=cls_indent+2
    while i<n and (seen_open and brace_depth>0):
        line=lines[i]
        s=line.strip()
        # track braces but be mindful of strings? heuristic only
        if s=='':
            brace_depth += line.count('{')-line.count('}')
            i+=1; continue
        ind=len(line)-len(line.lstrip(' '))
        # method decorator/signature at member indent inside class body
        if ind==member_indent and s.startswith('@'):
            # find signature
            k=i
            while k<n:
                st=lines[k].strip()
                indk=len(lines[k])-len(lines[k].lstrip(' '))
                if st=='':
                    k+=1; continue
                if indk==member_indent and st.startswith('@'):
                    k+=1; continue
                break
            if k<n and (len(lines[k])-len(lines[k].lstrip(' '))==member_indent):
                sig=lines[k].strip()
                if not sig.startswith('constructor') and not sig.startswith('private constructor'):
                    mm=re.match(r'(?:public\s+|private\s+|protected\s+|readonly\s+|async\s+|static\s+|get\s+|set\s+)*([A-Za-z0-9_]+)\s*[<(]', sig)
                    if mm and not re.match(r'^(if|for|while|switch|catch)\b', sig):
                        name=mm.group(1)
                        if name not in ('constructor',):
                            decos=collect_decorators_above(lines,k)
                            # but collect_decorators_above from signature will pick the block; good
                            methods.append((name,decos,sig,k+1))
                brace_depth += lines[k].count('{')-lines[k].count('}')
                i=k+1
                # advance through body of method by continuing brace tracking in outer loop
                continue
        elif ind==member_indent and re.match(r'(?:public\s+|private\s+|protected\s+|readonly\s+|async\s+|static\s+|get\s+|set\s+)*[A-Za-z0-9_]+\s*[<(]', s) and not s.startswith('constructor'):
            mm=re.match(r'(?:public\s+|private\s+|protected\s+|readonly\s+|async\s+|static\s+|get\s+|set\s+)*([A-Za-z0-9_]+)\s*[<(]', s)
            if mm and not re.match(r'^(if|for|while|switch|catch)\b', s):
                methods.append((mm.group(1), collect_decorators_above(lines,i), s, i+1))
        brace_depth += line.count('{')-line.count('}')
        i+=1
    return methods

def is_real_controller_file(path, text):
    # exclude user.module.ts style false positives and audit files mentioning @Controller in text only
    if path.name.endswith('.module.ts'):
        return False
    return True

files=[]
for p in ROOT.rglob('*.ts'):
    if '__tests__' in p.parts: continue
    txt=read_text(p)
    if '@Controller' not in txt: continue
    if not is_real_controller_file(p, txt): continue
    lines=txt.splitlines()
    classes=find_controller_classes(lines)
    if not classes:
        continue
    rel=p.relative_to(ROOT)
    parts=rel.parts
    module = parts[1] if len(parts)>2 and parts[0]=='modules' else '(global)'
    for cidx,cname,cdecos in classes:
        methods=parse_methods(lines,cidx)
        files.append({'module':module,'path':str(rel),'class':cname,'class_decos':cdecos,'methods':methods})

by_mod=defaultdict(list)
for f in sorted(files, key=lambda x:(x['module'], x['path'], x['class'])):
    by_mod[f['module']].append(f)

out=[]
out.append('# Controller Decorator Trace (Modules → Controllers → Methods)')
out.append('')
out.append('**Scope:** `project-hope/apps/api/src` (non-test Nest controllers)  ')
out.append('**Generated by:** `code_review/api_explore_3/tools/extract_controller_decorators.py` (heuristic AST-lite extraction)  ')
out.append('**Companion docs:** `nestjs-request-pipeline.md`, `bootstrap-and-global-config.md`')
out.append('')
out.append('> This inventory lists decorators declared on controller classes and their route handler methods. Effective request behavior is the combination of global/bootstrap config, global guards/pipes/interceptors/filters, module wiring, controller-level decorators, method-level decorators, and parameter-level decorators/pipes. "Purpose and how it impacts the request" is provided from Nest semantics and project conventions observed in `apps/api`; verify custom decorator implementations in source for exact behavior.')
out.append('')
out.append('## Decorator purpose legend (common)')
out.append('')
for k in sorted(DECORATOR_PURPOSE.keys()):
    out.append(f'- `@{k}`: {DECORATOR_PURPOSE[k]}')
out.append('')
out.append('## Inventory')
out.append('')

mods = sorted(by_mod.keys(), key=lambda m: (m!='(global)', m))
for mod in mods:
    out.append(f'### Module: `{mod}`')
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
                http = [deco_name(d) for d in decos if deco_name(d) in {'Get','Post','Put','Patch','Delete','Options','Head','All','Sse'}]
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
print(f'wrote {OUT} with {len(files)} controllers in {len(by_mod)} groups')
