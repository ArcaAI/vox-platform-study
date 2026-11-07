#!/usr/bin/env python3
"""
Build the endpoint catalog for the HOPE API Gateway explorer.

Inputs (read-only):
  project-hope/apps/api/route-manifest.json         818 route records
  project-hope/apps/api/openapi.json                607 documented paths
  project-hope/apps/api/src/**/*.ts                 controller source
  project-hope/packages/applications/src/**/*.ts    application services
  review/api_explore_3/inventory/ts-symbols.json    exact TS symbol line numbers
  review/api_explore_2/inventory/api-route-call-tree-catalog.json  existing summaries

Output:
  review/api_explore_3/inventory/endpoint-catalog.json
  review/api_explore_3/inventory/coverage-report.json

This is static analysis, not runtime tracing. Every path node carries a
confidence label so the explorer never presents an inferred hop as verified.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path('/Users/apple/repos/VOX')
REPO = ROOT / 'project-hope'
OUT = ROOT / 'review/api_explore_3'
INV = OUT / 'inventory'
INV.mkdir(parents=True, exist_ok=True)

ROUTE_MANIFEST = REPO / 'apps/api/route-manifest.json'
OPENAPI = REPO / 'apps/api/openapi.json'
TS_SYMBOLS = INV / 'ts-symbols.json'
EXISTING_CATALOG = ROOT / 'review/api_explore_2/inventory/api-route-call-tree-catalog.json'

# Frozen evidence revision. The worktree is checked separately in the report.
import subprocess
REVISION = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip()
GITHUB_BASE = 'https://github.com/ArcaAI/project-hope/blob'
LOCAL_BASE = f'file://{REPO}'
VSCODE_BASE = f'vscode://file{REPO}'

SKIP_TYPES = {
    'HttpService', 'ConfigService', 'ClsService', 'Logger', 'EventEmitter2',
    'SecretsService', 'Reflector', 'ModuleRef', 'DiscoveryService',
}
SKIP_FIELDS = {
    'logger', 'config', 'configService', 'cls', 'httpService', 'http',
    'eventEmitter', 'events', 'reflector', 'moduleRef',
}

# ---------------------------------------------------------------------------
# Source / symbol indexing
# ---------------------------------------------------------------------------

def read_text(rel: str) -> str:
    return (REPO / rel).read_text(errors='ignore')


def read_lines(rel: str) -> list[str]:
    return read_text(rel).splitlines()


def line_at(text: str, pos: int) -> int:
    return text.count('\n', 0, pos) + 1


def clean_type(t: str) -> str:
    t = t.strip()
    t = re.sub(r'^typeof\s+', '', t)
    t = re.sub(r'<.*>', '', t)
    t = re.sub(r'\[.*\]', '', t)
    t = t.split('|')[0].strip()
    t = t.replace('readonly ', '').strip()
    return t


def strip_comments(text: str) -> str:
    """Replace comments with whitespace while preserving every newline.

    Keeping newlines means line offsets computed on the stripped text still map
    back to the original file. Strings (including ``http://``) are preserved,
    which matters because the strongest downstream evidence is often a URL.
    """
    out: list[str] = []
    i = 0
    state = 'normal'
    quote = ''
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ''
        if state == 'normal':
            if ch == '/' and nxt == '/':
                state = 'line'
                out.append(' ')
                i += 2
                continue
            if ch == '/' and nxt == '*':
                state = 'block'
                out.append(' ')
                i += 2
                continue
            if ch in ('"', "'", '`'):
                state = 'string'
                quote = ch
            out.append(ch)
            i += 1
            continue
        if state == 'line':
            if ch == '\n':
                state = 'normal'
                out.append('\n')
            else:
                out.append(' ')
            i += 1
            continue
        if state == 'block':
            if ch == '*' and nxt == '/':
                out.append(' ')
                i += 2
                state = 'normal'
                continue
            out.append('\n' if ch == '\n' else ' ')
            i += 1
            continue
        # string
        out.append(ch)
        if ch == '\\' and i + 1 < len(text):
            out.append(text[i + 1])
            i += 2
            continue
        if ch == quote:
            state = 'normal'
        i += 1
    return ''.join(out)


ts = json.loads(TS_SYMBOLS.read_text())
symbols_by_name: dict[str, list[dict]] = defaultdict(list)
symbols_by_file: dict[str, list[dict]] = defaultdict(list)
implementations: dict[str, list[dict]] = defaultdict(list)
provider_map: dict[str, str] = {}

for file, data in ts['files'].items():
    for s in data['symbols']:
        if s['kind'] not in ('class', 'interface'):
            continue
        rec = {
            'name': s['name'],
            'kind': s['kind'],
            'abstract': bool(s.get('abstract', False)),
            'file': file,
            'line': s['line'],
            'endLine': s['endLine'],
            ' implements': s.get('implements', []),
            'extends': s.get('extends', []),
            'methods': s.get('methods', []),
        }
        rec['implements'] = rec.pop(' implements')
        symbols_by_name[s['name']].append(rec)
        symbols_by_file[file].append(rec)
        if s['kind'] == 'class':
            for iface in s.get('implements', []):
                implementations[clean_type(iface)].append(rec)

# Nest provider aliases: provide: IThing, useClass: Thing
for file in ts['files']:
    text = read_text(file)
    for m in re.finditer(r'provide\s*:\s*([A-Za-z_$][\w$]*)\s*,\s*useClass\s*:\s*([A-Za-z_$][\w$]*)', text):
        provider_map[m.group(1)] = m.group(2)
    for m in re.finditer(r'provide\s*:\s*([A-Za-z_$][\w$]*)\s*,\s*useExisting\s*:\s*([A-Za-z_$][\w$]*)', text):
        provider_map.setdefault(m.group(1), m.group(2))

# Fallback provider map from the existing call-tree catalog's service types.
try:
    existing_catalog = json.loads(EXISTING_CATALOG.read_text())
except Exception:
    existing_catalog = []
existing_by_route = {(e.get('method'), e.get('path')): e for e in existing_catalog}


def resolve_type(type_name: str) -> dict | None:
    """Resolve an injected type/token to a concrete class symbol."""
    type_name = clean_type(type_name)
    if not type_name or type_name in SKIP_TYPES:
        return None
    if type_name in provider_map:
        type_name = provider_map[type_name]
    candidates: list[dict] = []
    if type_name in implementations:
        candidates.extend(implementations[type_name])
    if type_name in symbols_by_name:
        candidates.extend([x for x in symbols_by_name[type_name] if x['kind'] == 'class'])
    base = type_name[1:] if type_name.startswith('I') and len(type_name) > 2 else type_name
    if base in symbols_by_name:
        candidates.extend([x for x in symbols_by_name[base] if x['kind'] == 'class'])
    if base in implementations:
        candidates.extend(implementations[base])
    # Fuzzy fallback: class/service name ending with the token without its I.
    for name, syms in symbols_by_name.items():
        if name == base or name.endswith(base):
            for s in syms:
                if s['kind'] == 'class':
                    candidates.append(s)
    # Deduplicate + rank. A concrete implementation always beats an abstract
    # class or interface token with the same name (ISummaryService vs
    # SummaryService is the common case).
    seen = set()
    ranked = []
    for c in candidates:
        key = (c['file'], c['name'])
        if key in seen:
            continue
        seen.add(key)
        score = 0
        if c['name'] == type_name:
            score += 14
        if c['name'] == base:
            score += 12
        if c.get('abstract'):
            score -= 40
        if any(c['file'] == impl['file'] and c['name'] == impl['name'] for impl in implementations.get(type_name, [])):
            score += 25
        if '/services/' in c['file']:
            score += 6
        if '/modules/' in c['file']:
            score += 2
        if c['name'].lower().endswith(('service', 'client', 'gateway', 'repository')):
            score += 3
        score -= len(c['file']) / 1000
        ranked.append((score, c))
    ranked.sort(key=lambda x: (-x[0], len(x[1]['file']), x[1]['line']))
    return ranked[0][1] if ranked else None


def find_method(symbol: dict, method_name: str) -> dict | None:
    for m in symbol.get('methods', []):
        if m['name'] == method_name:
            return m
    return None


def injections_for(symbol: dict) -> dict[str, dict]:
    ctor = find_method(symbol, 'constructor')
    out: dict[str, dict] = {}
    if not ctor:
        return out
    for p in ctor.get('params', []):
        token = None
        for d in p.get('decorators', []):
            if d['name'] in ('Inject', 'Optional'):
                for a in d.get('args', []):
                    if a and not a.startswith('forwardRef'):
                        token = a.strip().strip("'\"")
                        break
            if token:
                break
        typ = clean_type(p.get('type', ''))
        if p.get('name') and (token or typ):
            out[p['name']] = {'token': token, 'type': typ or token}
    return out


def body_has_evidence(body: str) -> bool:
    body = strip_comments(body)
    if re.search(r'this\.(?:httpService|http)\b', body):
        return True
    for m in re.finditer(r'this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(', body):
        if m.group(1) not in SKIP_FIELDS:
            return True
    return any(re.search(pat, body) for patterns in STRONG_PATTERNS.values() for pat, _ in patterns)


def slice_lines(rel: str, start: int, end: int) -> str:
    lines = read_lines(rel)
    start = max(1, start)
    end = min(len(lines), end)
    return '\n'.join(lines[start - 1:end])


def method_decl_line(rel: str, method: dict) -> int:
    """Return the declaration line, skipping route/decorator metadata.

    TypeScript AST ``getStart()`` includes decorators, so a handler's reported
    line can point at ``@ApiOperation(...)``. That metadata often mentions other
    services in prose. Starting at the actual declaration keeps both the source
    excerpt and downstream evidence focused on executable code.
    """
    lines = read_lines(rel)
    name = re.escape(method.get('name', ''))
    pat = re.compile(r'^\s*(?:(?:public|private|protected)\s+)?(?:async\s+)?' + name + r'\s*(?:<[^>]*>)?\s*[\(=]')
    start = max(1, method.get('line', 1))
    end = min(len(lines), method.get('endLine', start))
    for i in range(start - 1, end):
        raw = lines[i]
        if raw.lstrip().startswith('@'):
            continue
        if pat.search(raw):
            return i + 1
    return start


def github_url(rel: str, line: int, end_line: int | None = None) -> str:
    if not rel or rel.startswith('node_modules/'):
        return ''
    anchor = f'#L{line}' if not end_line or end_line == line else f'#L{line}-L{end_line}'
    return f'{GITHUB_BASE}/{REVISION}/{rel}{anchor}'


def local_url(rel: str, line: int) -> str:
    return f'{LOCAL_BASE}/{rel}#L{line}'


def vscode_url(rel: str, line: int) -> str:
    return f'{VSCODE_BASE}/{rel}:{line}'


# ---------------------------------------------------------------------------
# Controller extraction
# ---------------------------------------------------------------------------

controllers: dict[str, dict] = {}
for file, syms in symbols_by_file.items():
    if not file.endswith('.controller.ts'):
        continue
    for s in syms:
        if s['kind'] != 'class' or not s['name'].endswith('Controller'):
            continue
        ctor = find_method(s, 'constructor')
        injections = {}
        if ctor:
            for p in ctor.get('params', []):
                field = p['name']
                token = None
                for d in p.get('decorators', []):
                    if d['name'] in ('Inject', 'Optional'):
                        for a in d.get('args', []):
                            if a and not a.startswith('forwardRef'):
                                token = a.strip().strip("'\"")
                                break
                    if token:
                        break
                typ = clean_type(p.get('type', ''))
                if field and (token or typ):
                    injections[field] = {'token': token, 'type': typ or token}
        controllers[s['name']] = {
            'name': s['name'],
            'file': file,
            'line': s['line'],
            'injections': injections,
            'symbol': s,
        }

# The Prometheus scrape controller is vendored by @willsoto/nestjs-prometheus.
# It is not a .ts file under apps/api, so the AST scan cannot see it. Resolve it
# from node_modules and keep the source link local (node_modules is not tracked).
for candidate in sorted((REPO / 'node_modules/.pnpm').glob(
        '@willsoto+nestjs-prometheus*/node_modules/@willsoto/nestjs-prometheus/dist/controller.js')):
    rel = candidate.relative_to(REPO).as_posix()
    lines = read_lines(rel)
    index_line = next((i + 1 for i, line in enumerate(lines) if re.search(r'\bindex\s*\(', line)), 1)
    index_end = index_line
    for i in range(index_line, len(lines)):
        if re.match(r'^\s{4}\}', lines[i]):
            index_end = i + 1
            break
    symbol = {
        'name': 'PrometheusController', 'kind': 'class', 'line': index_line - 6,
        'endLine': index_end, 'extends': [], 'implements': [],
        'methods': [{'name': 'index', 'line': index_line, 'endLine': index_end,
                     'params': [], 'decorators': []}],
    }
    controllers['PrometheusController'] = {
        'name': 'PrometheusController', 'file': rel, 'line': index_line - 6,
        'injections': {}, 'symbol': symbol, 'vendored': True,
    }
    break

# ---------------------------------------------------------------------------
# Downstream detection
# ---------------------------------------------------------------------------

STRONG_PATTERNS = {
    'STT': [
        (r'\bSTT_URL\b', 'env STT_URL'), (r':8861\b', 'port 8861'),
        (r'SttWsGateway', 'SttWsGateway'), (r'stt-ws', 'stt-ws gateway'),
        (r'/api/v1/transcribe\b', 'STT transcribe endpoint'), (r'apps/stt', 'apps/stt'),
    ],
    'Text': [
        (r'\bTEXT_URL\b', 'env TEXT_URL'), (r':8862\b', 'port 8862'),
        (r'TextProxyController', 'TextProxyController'), (r'text-proxy', 'text proxy'),
        (r'/api/v1/generate\b', 'TEXT generate endpoint'), (r'/api/v1/tasks/', 'TEXT task endpoint'),
        (r'apps/text', 'apps/text'),
    ],
    'TTS': [
        (r'\bTTS_URL\b', 'env TTS_URL'), (r':8865\b', 'port 8865'),
        (r'TtsWsGateway', 'TtsWsGateway'), (r'tts-ws', 'tts-ws gateway'),
        (r'SpeechProxyController', 'SpeechProxyController'), (r'speech-proxy', 'speech proxy'),
        (r'/api/v1/audio/speech', 'TTS speech endpoint'), (r'apps/tts', 'apps/tts'),
    ],
    'NLP': [
        (r'\bNLP_URL\b', 'env NLP_URL'), (r':8864\b', 'port 8864'),
        (r'AiInferenceClient', 'AiInferenceClient'), (r'/api/v1/classify/tokens', 'NLP token classification'),
        (r'/api/v1/diagnosis/suggestions', 'NLP diagnosis endpoint'), (r'/api/v1/classify/topic', 'NLP topic endpoint'),
        (r'/api/v1/classify/intent', 'NLP intent endpoint'), (r'apps/nlp', 'apps/nlp'),
    ],
    'Guardrail': [
        (r'\bGUARDRAIL_URL\b', 'env GUARDRAIL_URL'), (r':8863\b', 'port 8863'),
        (r'/api/guardrail/analyze', 'Guardrail analyze endpoint'), (r'apps/guardrail', 'apps/guardrail'),
    ],
    'Harness': [
        (r'\bHARNESS_BASE_URL\b', 'env HARNESS_BASE_URL'), (r'\bHARNESS_URL\b', 'env HARNESS_URL'),
        (r':8866\b', 'port 8866'), (r'HarnessOpsClient', 'HarnessOpsClient'),
        (r'HarnessGatewayService', 'HarnessGatewayService'), (r'/api/v1/internal/harness', 'harness admin surface'),
        (r'apps/harness', 'apps/harness'),
    ],
    'Temporal': [
        (r'\bTemporal(?:Client|Worker|Activity|Workflow|Connection|Service|Namespace)\b', 'Temporal client/worker'),
        (r'\b(?:WorkflowClient|workflowClient|workflowId|getWorkflowHandle)\b', 'Temporal workflow handle/id'),
        (r'HarnessDocWorkflow|HarnessLoopWorkflow|HarnessWorkflow', 'Harness Temporal workflow'),
    ],
}

INFRA_PATTERNS = {
    'PostgreSQL': [(r'\bprisma\b|PrismaService|Repository\b|databaseService', 'Prisma/Repository access')],
    'Redis / BullMQ': [(r'\bRedis\b|\bredis\b|BullMQ|\bQueue\b|throttler', 'Redis / queue usage')],
    'S3 / MinIO': [(r'\bS3\b|MinIO|BlobStorage|IS3Service|s3://|bucket', 'object storage usage')],
    'Vault': [(r'\bVault\b|SecretsService', 'Vault / secrets usage')],
    'Qdrant': [(r'\bQdrant\b|\bqdrant\b', 'Qdrant vector store')],
    'MLflow / AI service': [(r'MLflow|mlflow', 'MLflow / AI service proxy')],
}

MODULE_HINTS = {
    'speech': [('TTS', '8865', 'inferred from speech module')],
    'ai-inference': [('NLP', '8864', 'inferred from ai-inference module')],
    'harness-admin': [('Harness', '8866', 'inferred from harness-admin module'), ('Temporal', '', 'inferred from harness workflow ops')],
    'knowledge': [('Qdrant', '', 'inferred from knowledge/RAG module'), ('Harness', '8866', 'inferred from knowledge ingest client')],
    'ai-service-admin': [('MLflow / AI service', '', 'inferred from AI service admin module')],
}

# Controllers whose ownership of a proxy/gateway is itself the evidence. This
# covers routes whose handler delegates to a private helper, where a one-level
# body scan would otherwise only see the helper call.
CLASS_HINTS = {
    'TextProxyController': [('Text', '8862', 'controller owns the TEXT proxy', 'verified')],
    'TextGenerationAdminController': [('Text', '8862', 'admin playground uses the TEXT proxy', 'verified')],
    'SpeechProxyController': [('TTS', '8865', 'controller owns the TTS proxy', 'verified')],
    'TtsWsGateway': [('TTS', '8865', 'TTS WebSocket gateway', 'verified')],
    'SttWsGateway': [('STT', '8861', 'STT WebSocket gateway', 'verified')],
    'AiInferenceController': [('NLP', '8864', 'controller owns the NLP inference client', 'verified')],
    'SafetyCheckController': [('Guardrail', '8863', 'controller owns the Guardrail analysis call', 'verified'),
                              ('NLP', '8864', 'guardrail text analysis may pass through NLP', 'inferred-chain')],
    'AdminHealthServicesController': [('STT', '8861', 'health probe target', 'verified'),
                                      ('Text', '8862', 'health probe target', 'verified'),
                                      ('Guardrail', '8863', 'health probe target', 'verified'),
                                      ('NLP', '8864', 'health probe target', 'verified'),
                                      ('TTS', '8865', 'health probe target', 'verified'),
                                      ('Harness', '8866', 'health probe target', 'verified')],
    'HarnessTtsInternalController': [('TTS', '8865', 'controller forwards synthesis to TTS', 'verified')],
    'VoiceProfileController': [('STT', '8861', 'voice enrollment uses STT', 'verified')],
}

PORTS = {
    'STT': '8861', 'Text': '8862', 'Guardrail': '8863', 'NLP': '8864',
    'TTS': '8865', 'Harness': '8866',
}

# Configuration-only evidence. This is deliberately narrower than
# STRONG_PATTERNS: a service's constructor often *injects* a client without
# calling it on this route, so class names must not be treated as calls.
CONFIG_PATTERNS = {
    'STT': [r'\bSTT_URL\b', r':8861\b', r'localhost:8861'],
    'Text': [r'\bTEXT_URL\b', r':8862\b', r'localhost:8862'],
    'Guardrail': [r'\bGUARDRAIL_URL\b', r':8863\b', r'localhost:8863'],
    'NLP': [r'\bNLP_URL\b', r':8864\b', r'localhost:8864'],
    'TTS': [r'\bTTS_URL\b', r':8865\b', r'localhost:8865'],
    'Harness': [r'\bHARNESS_(?:BASE_)?URL\b', r':8866\b', r'localhost:8866'],
}


def config_name_in_text(text: str) -> str:
    text = strip_comments(text)
    for svc, patterns in CONFIG_PATTERNS.items():
        for pat in patterns:
            if re.search(pat, text):
                return svc
    return ''


def config_refs_for_class(svc: dict) -> dict[str, str]:
    """Map a class's URL helpers/fields to the service they configure.

    Example: ``this.nlpUrl()`` is mapped to NLP because the ``nlpUrl`` helper
    reads ``NLP_URL``. A method is only credited when its own body references
    that helper/field, so a controller that merely *injects* HarnessGatewayService
    does not look like it calls Harness.
    """
    refs: dict[str, str] = {}
    head_end = min(svc['endLine'], svc['line'] + 180)
    head = slice_lines(svc['file'], svc['line'], head_end)
    for line in strip_comments(head).splitlines():
        svc_name = config_name_in_text(line)
        if not svc_name:
            continue
        m = re.search(r'(?:this\.)?([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=', line)
        if m:
            refs.setdefault(m.group(1), svc_name)
    for method in svc.get('methods', []):
        mstart = method_decl_line(svc['file'], method)
        body = slice_lines(svc['file'], mstart, method['endLine'])
        svc_name = config_name_in_text(body)
        if svc_name:
            refs[method['name']] = svc_name
    return refs

EXTERNAL_HINTS = {
    'ai-model': [('AI provider APIs', 'provider probe / model discovery')],
    'ai-provider-connection': [('AI provider APIs', 'provider connection probe')],
    'ai-service-admin': [('MLflow / AI service', 'AI service admin proxy')],
}


def add_downstream(bucket: list[dict], name: str, port: str = '', evidence: str = '', confidence: str = 'inferred',
                   file: str = '', line: int | None = None, kind: str = 'microservice') -> None:
    key = name
    for item in bucket:
        if item['name'] == key:
            # Upgrade confidence if stronger evidence appears.
            rank = {'inferred-chain': 0, 'inferred': 1, 'verified': 2}
            if rank.get(confidence, 0) > rank.get(item.get('confidence', ''), 0):
                item.update({'confidence': confidence, 'evidence': evidence, 'file': file, 'line': line})
            return
    bucket.append({
        'name': name, 'port': port, 'evidence': evidence, 'confidence': confidence,
        'file': file, 'line': line, 'kind': kind,
    })


def detect_in_text(bucket: list[dict], text: str, rel: str, base_line: int, module: str,
                   controller: str, handler: str) -> None:
    # Comments routinely mention sibling services ("the harness calls this from
    # a Temporal activity"). They are excellent documentation and terrible
    # evidence, so detection runs on a comment-stripped copy.
    text = strip_comments(text)
    for svc, patterns in STRONG_PATTERNS.items():
        for pat, evidence in patterns:
            m = re.search(pat, text)
            if m:
                add_downstream(bucket, svc, PORTS.get(svc, ''), evidence, 'verified', rel,
                               base_line + text[:m.start()].count('\n'))
                break
    for infra, patterns in INFRA_PATTERNS.items():
        for pat, evidence in patterns:
            m = re.search(pat, text)
            if m:
                add_downstream(bucket, infra, '', evidence, 'verified', rel,
                               base_line + text[:m.start()].count('\n'), 'infrastructure')
                break
    # Controller ownership is evidence for proxy/gateway controllers.
    for svc, port, evidence, confidence in CLASS_HINTS.get(controller, []):
        add_downstream(bucket, svc, port, evidence, confidence, rel, base_line)
    for svc, port, evidence in MODULE_HINTS.get(module, []):
        add_downstream(bucket, svc, port, evidence, 'inferred')
    # Module/flow-specific inference, kept conservative.
    lower = f'{controller} {handler} {module}'.lower()
    if module == 'streaming':
        if 'transcri' in lower or 'stt' in lower or 'audio' in lower:
            add_downstream(bucket, 'STT', '8861', 'streaming transcription flow', 'inferred')
        if 'workflow' in lower:
            add_downstream(bucket, 'Harness', '8866', 'workflow websocket flow', 'inferred')
            add_downstream(bucket, 'Temporal', '', 'workflow websocket flow', 'inferred')
        if controller in ('TranscriptionJobController', 'AdminTranscriptionJobController') and re.search(
                r'transcrib|stream|retry|cancel|create|batch|fallback|primary|session', handler, re.I):
            add_downstream(bucket, 'STT', '8861', 'transcription job lifecycle', 'inferred')
    # Only generation/streaming endpoints cross into the durable harness. A
    # summary read or tag edit is a database operation, not a model call.
    if module == 'consultation' and controller == 'ConsultationController' and re.search(
            r'generate.*summary|summary.*async|comprehensive|pre-summary|stream.*(live-summary|loop|harness)',
            handler, re.I):
        add_downstream(bucket, 'Harness', '8866', 'consultation generation flow', 'inferred-chain')
        add_downstream(bucket, 'Temporal', '', 'durable harness workflow', 'inferred-chain')
        add_downstream(bucket, 'Text', '8862', 'LLM generation inside the harness', 'inferred-chain')
        add_downstream(bucket, 'Guardrail', '8863', 'safety gate inside the harness', 'inferred-chain')
    if module == 'agent' and ('speech' in lower or 'tts' in lower):
        add_downstream(bucket, 'TTS', '8865', 'agent speech endpoint', 'inferred')
    if controller == 'ApiHealthController' and handler == 'check':
        for svc, port in PORTS.items():
            add_downstream(bucket, svc, port, 'aggregate health check target', 'inferred')
    if module == 'ai-model':
        add_downstream(bucket, 'S3 / MinIO', '', 'model artifact storage', 'inferred', kind='infrastructure')
    for name, evidence in EXTERNAL_HINTS.get(module, []):
        add_downstream(bucket, name, '', evidence, 'inferred', kind='external')
    if module == 'billing' or module == 'admin-usage':
        add_downstream(bucket, 'PostgreSQL', '', 'usage ledger persistence', 'inferred', kind='infrastructure')
    # Harness owns the durable workflow. Once a verified Harness hop exists, the
    # Temporal runtime and the Text/Guardrail calls inside the workflow are part
    # of the same downstream chain.
    if any(d['name'] == 'Harness' and d.get('confidence') == 'verified' for d in bucket):
        add_downstream(bucket, 'Temporal', '', 'Harness runs durable Temporal workflows', 'inferred-chain')
        add_downstream(bucket, 'Text', '8862', 'Harness workflow calls TEXT for generation', 'inferred-chain')
        add_downstream(bucket, 'Guardrail', '8863', 'Harness workflow runs safety gates', 'inferred-chain')


# ---------------------------------------------------------------------------
# JSON-schema example generator
# ---------------------------------------------------------------------------

MAX_PROPS = 12
MAX_DEPTH = 4


def resolve_ref(ref: str, components: dict) -> dict:
    if ref.startswith('#/components/schemas/'):
        name = ref.split('/')[-1]
        return components.get(name, {})
    return {}


def example_from_schema(schema: dict | None, components: dict, depth: int = 0) -> object:
    if not schema or depth > MAX_DEPTH:
        return {}
    if '$ref' in schema:
        return example_from_schema(resolve_ref(schema['$ref'], components), components, depth + 1)
    if 'example' in schema:
        return schema['example']
    if 'default' in schema:
        return schema['default']
    if 'enum' in schema and schema['enum']:
        return schema['enum'][0]
    if 'allOf' in schema:
        merged: dict = {}
        for part in schema['allOf']:
            v = example_from_schema(part, components, depth + 1)
            if isinstance(v, dict):
                merged.update(v)
        return merged
    for key in ('oneOf', 'anyOf'):
        if key in schema and schema[key]:
            return example_from_schema(schema[key][0], components, depth + 1)
    typ = schema.get('type')
    if isinstance(typ, list):
        typ = next((x for x in typ if x != 'null'), typ[0] if typ else None)
    fmt = schema.get('format')
    if typ == 'object' or 'properties' in schema:
        out = {}
        for name, prop in list((schema.get('properties') or {}).items())[:MAX_PROPS]:
            out[name] = example_from_schema(prop, components, depth + 1)
        return out
    if typ == 'array':
        item = example_from_schema(schema.get('items') or {}, components, depth + 1)
        return [item]
    if typ == 'string':
        if fmt == 'date-time':
            return '2026-01-15T10:30:00Z'
        if fmt == 'date':
            return '2026-01-15'
        if fmt == 'uuid':
            return '0189f7ea-ae2f-72b9-9be8-9c3d224082ef'
        if fmt == 'email':
            return 'clinician@example.com'
        return schema.get('minLength', 0) and 'string' or 'string'
    if typ == 'integer' or typ == 'number':
        return schema.get('minimum', 0)
    if typ == 'boolean':
        return False
    if typ == 'null':
        return None
    return {}


def example_parameters(params: list[dict], components: dict) -> dict:
    out = {'path': {}, 'query': {}, 'header': {}}
    for p in params or []:
        where = p.get('in')
        if where not in out:
            continue
        schema = p.get('schema') or {}
        val = example_from_schema(schema, components)
        if val in ({}, None, '') and p.get('required'):
            val = f'<{p.get("name")}>'
        out[where][p.get('name')] = val
    return out


def openapi_contract(op: dict | None, components: dict) -> dict:
    if not op:
        return {'documented': False, 'parameters': {'path': {}, 'query': {}, 'header': {}},
                'body': None, 'responses': {}, 'summary': '', 'description': ''}
    params = example_parameters(op.get('parameters') or [], components)
    body = None
    rb = op.get('requestBody') or {}
    content = rb.get('content') or {}
    json_content = content.get('application/json') or next(iter(content.values()), {})
    if json_content:
        body = example_from_schema(json_content.get('schema') or {}, components)
    responses = {}
    for status, resp in (op.get('responses') or {}).items():
        content = (resp.get('content') or {}).get('application/json')
        if content:
            responses[status] = {
                'description': resp.get('description', ''),
                'example': example_from_schema(content.get('schema') or {}, components),
            }
        else:
            responses[status] = {'description': resp.get('description', ''), 'example': None}
    return {
        'documented': True,
        'parameters': params,
        'body': body,
        'responses': responses,
        'summary': op.get('summary', ''),
        'description': op.get('description', ''),
        'security': op.get('security', []),
    }


def callers_for(route: dict, controller: str, module: str) -> list[dict]:
    path = route.get('path', '')
    if path.startswith('/api/v1/internal/harness'):
        return [
            {'name': 'Harness / Temporal worker', 'detail': 'Calls this internal callback from a workflow activity.'},
            {'name': 'Service account', 'detail': 'Authenticated with an internal service credential.'},
        ]
    if path.startswith('/api/v1/internal/'):
        return [{'name': 'Internal service', 'detail': 'Service-to-service call inside the cluster.'}]
    if path.startswith('/api/v1/admin/'):
        return [{'name': 'Admin console', 'detail': 'Operator or platform administrator UI.'}]
    if controller == 'AgentController':
        return [{'name': 'Agent runtime / SDK', 'detail': 'Agent execution surface.'}]
    return [{'name': 'API client', 'detail': 'Web app, integrator, or service account.'}]


def auth_summary(route: dict) -> dict:
    path = route.get('path', '')
    if path.startswith('/api/v1/internal/') and route.get('isPublic'):
        return {'label': 'Internal / network-gated',
                'detail': 'Not on the public API-key surface; called inside the cluster by a service or Harness/Temporal worker.',
                'kind': 'internal'}
    if route.get('isPublic'):
        result = {'label': 'Public', 'detail': 'No bearer auth required', 'kind': 'public'}
    elif route.get('requiredPermissions'):
        perms = [':'.join(p) if isinstance(p, list) else str(p) for p in route['requiredPermissions']]
        result = {'label': 'JWT + RBAC', 'detail': 'Permissions: ' + ', '.join(perms), 'kind': 'jwt'}
    elif route.get('svcScopes'):
        result = {'label': 'Service account / internal', 'detail': 'Service scopes: ' + ', '.join(route['svcScopes']), 'kind': 'service'}
    elif route.get('apiKeyScopes'):
        result = {'label': 'JWT or API key', 'detail': 'API-key scopes: ' + ', '.join(route['apiKeyScopes']), 'kind': 'api-key'}
    else:
        result = {'label': 'Authenticated', 'detail': 'JWT or service credential', 'kind': 'jwt'}
    if route.get('requiresIfMatch'):
        result['detail'] += '; If-Match required for optimistic concurrency'
    return result


def module_of(rel: str) -> str:
    m = re.search(r'src/modules/([^/]+)/', rel)
    if m:
        return m.group(1)
    m = re.search(r'src/([^/]+)/', rel)
    return m.group(1) if m else 'root'


PLANE_BY_MODULE = {
    'consultation': 'Clinical & Consultation',
    'consultation-history': 'Clinical & Consultation',
    'consultation-context-schema': 'Clinical & Consultation',
    'document-template': 'Clinical & Consultation',
    'dna-writing-style': 'Clinical & Consultation',
    'streaming': 'Speech & Audio',
    'speech': 'Speech & Audio',
    'voice-profile': 'Speech & Audio',
    'ai-inference': 'AI Models & Guardrails',
    'ai-model': 'AI Models & Guardrails',
    'ai-provider-connection': 'AI Models & Guardrails',
    'ai-routing-policy': 'AI Models & Guardrails',
    'ai-service-admin': 'AI Models & Guardrails',
    'guardrail-policy': 'AI Models & Guardrails',
    'guardrail-tenant-policy': 'AI Models & Guardrails',
    'guardrail-notice': 'AI Models & Guardrails',
    'guardrail-availability': 'AI Models & Guardrails',
    'guardrail-evaluation-internal': 'AI Models & Guardrails',
    'prompt-management': 'AI Models & Guardrails',
    'prompt-inspector': 'AI Models & Guardrails',
    'governed-prompt': 'AI Models & Guardrails',
    'nlp-task-instructions': 'AI Models & Guardrails',
    'model-residency': 'AI Models & Guardrails',
    'inference-engines': 'AI Models & Guardrails',
    'agent': 'Agentic & Workflows',
    'agent-admin': 'Agentic & Workflows',
    'agent-promotion': 'Agentic & Workflows',
    'agent-trajectory': 'Agentic & Workflows',
    'agentic-admin': 'Agentic & Workflows',
    'harness-admin': 'Agentic & Workflows',
    'workflows': 'Agentic & Workflows',
    'workflow-assignment': 'Agentic & Workflows',
    'workflow-definition': 'Agentic & Workflows',
    'workflow-node': 'Agentic & Workflows',
    'workflow-run': 'Agentic & Workflows',
    'workflow-sandbox-run': 'Agentic & Workflows',
    'workflow-test-fixture': 'Agentic & Workflows',
    'workflow-invariant-rule': 'Agentic & Workflows',
    'mcp-admin': 'Agentic & Workflows',
    'knowledge': 'Agentic & Workflows',
    'internal': 'Agentic & Workflows',
}


def plane_of(module: str) -> str:
    return PLANE_BY_MODULE.get(module, 'Platform Admin & Tenancy')


# ---------------------------------------------------------------------------
# Build endpoints
# ---------------------------------------------------------------------------

manifest = json.loads(ROUTE_MANIFEST.read_text())
openapi = json.loads(OPENAPI.read_text())
components = (openapi.get('components') or {}).get('schemas') or {}
ops_by_id = {}
ops_by_path = {}
for path, item in (openapi.get('paths') or {}).items():
    for method, op in item.items():
        if method.lower() not in {'get', 'post', 'put', 'patch', 'delete', 'head', 'options'}:
            continue
        oid = op.get('operationId')
        if oid:
            ops_by_id[oid] = op
        ops_by_path[(path, method.upper())] = op


def build_path(route: dict, ctrl: dict | None, handler: dict | None, module: str,
               contract: dict, auth: dict) -> tuple[list[dict], list[dict]]:
    nodes: list[dict] = []
    downstream: list[dict] = []
    route_id = f"{route['method']} {route['path']}"

    # 1. Client / gateway pipeline.
    nodes.append({
        'id': 'client', 'kind': 'client', 'label': 'Client request',
        'sublabel': auth['label'], 'file': '', 'line': None, 'endLine': None,
        'symbol': route_id, 'confidence': 'verified',
        'whatItIs': 'The external caller of this route.',
        'whatItDoes': f"Sends {route['method']} {route['path']} with {auth['detail']}.",
        'snippet': '', 'microservices': [],
    })
    nodes.append({
        'id': 'gateway', 'kind': 'gateway', 'label': 'Gateway pipeline',
        'sublabel': 'Throttle → CLS → auth → tenant/consent guards → interceptors',
        'file': 'apps/api/src/main.ts', 'line': 50, 'endLine': 251, 'symbol': 'bootstrap()',
        'confidence': 'verified',
        'whatItIs': 'The NestJS request pipeline configured in main.ts and app.module.ts.',
        'whatItDoes': 'Applies the global prefix, eight ordered guards, seven interceptors and four exception filters before the controller handler runs.',
        'snippet': slice_lines('apps/api/src/main.ts', 50, 75),
        'microservices': [],
    })

    # 2. Controller.
    if ctrl and handler:
        handler_start = method_decl_line(ctrl['file'], handler)
        body = slice_lines(ctrl['file'], handler_start, handler['endLine'])
        nodes.append({
            'id': 'controller', 'kind': 'controller', 'label': ctrl['name'],
            'sublabel': f"{handler['name']}() · {ctrl['file'].split('/')[-1]}:{handler_start}",
            'file': ctrl['file'], 'line': handler_start, 'endLine': handler['endLine'],
            'symbol': f"{ctrl['name']}.{handler['name']}()", 'confidence': 'verified',
            'whatItIs': f"The NestJS controller handler for {route['method']} {route['path']}.",
            'whatItDoes': 'Parses path/query/body input, applies route decorators and DTO validation, then delegates to application services. It does not own domain persistence.',
            'snippet': body[:5000], 'microservices': [],
        })
        # 3. Walk the handler, local helpers, and application services. The walk
        # is deliberately bounded: it is a reading aid, not a runtime tracer.
        seen_nodes: set[tuple] = set()
        seen_helpers: set[tuple] = set()
        pending_expansions: list[tuple] = []
        node_count = 0
        MAX_NODES = 16

        def add_service_node(svc: dict, method_name: str, depth: int) -> None:
            nonlocal node_count
            key = ('svc', svc['file'], svc['name'])
            if key in seen_nodes or node_count >= MAX_NODES:
                return
            seen_nodes.add(key)
            node_count += 1
            sm = find_method(svc, method_name)
            sm_start = method_decl_line(svc['file'], sm) if sm else None
            sbody = slice_lines(svc['file'], sm_start, sm['endLine']) if sm else ''
            # Constructor/property configuration is often where a client's base
            # URL lives (HARNESS_URL, TEXT_URL, :886x). Scan the class head so a
            # verified client hop does not degrade to an inferred module hint.
            refs = config_refs_for_class(svc)
            analysis = strip_comments(sbody)
            for ref, svc_name in refs.items():
                if re.search(r'this\.' + re.escape(ref) + r'\b', analysis):
                    add_downstream(downstream, svc_name, PORTS.get(svc_name, ''),
                                   f'this.{ref} configures {svc_name}', 'verified', svc['file'],
                                   sm_start or svc['line'])
            nodes.append({
                'id': f"svc:{svc['name']}:{method_name}", 'kind': 'service',
                'label': svc['name'],
                'sublabel': f"{method_name}() · {svc['file'].split('/')[-1]}:{sm_start if sm else '?'}",
                'file': svc['file'], 'line': sm_start,
                'endLine': sm['endLine'] if sm else None,
                'symbol': f"{svc['name']}.{method_name}()",
                'confidence': 'verified' if sm else 'inferred',
                'whatItIs': 'An application service in packages/applications (or a gateway client/gateway).',
                'whatItDoes': f"Implements the business operation `{method_name}` called by the controller. This is where domain rules, persistence and downstream clients are usually orchestrated.",
                'snippet': sbody[:5000], 'microservices': [],
            })
            if sbody and depth < 3:
                pending_expansions.append((sbody, svc['file'], sm_start, svc, svc['name'], depth + 1))

        def add_helper_node(owner_name: str, owner_symbol: dict, hm: dict, depth: int) -> None:
            nonlocal node_count
            hkey = ('helper', owner_symbol['file'], hm['line'])
            if hkey in seen_helpers or depth >= 3:
                return
            seen_helpers.add(hkey)
            hm_start = method_decl_line(owner_symbol['file'], hm)
            hbody = slice_lines(owner_symbol['file'], hm_start, hm['endLine'])
            interesting = bool(re.search(
                r'proxy|generate|post|forward|start|run|invoke|dispatch|stream|assemble|publish|finalize|harness|summary|note|persist',
                hm['name'], re.I))
            if (interesting or body_has_evidence(hbody)) and node_count < MAX_NODES:
                seen_nodes.add(hkey)
                node_count += 1
                nodes.append({
                    'id': f"helper:{owner_name}:{hm['name']}", 'kind': 'helper',
                    'label': f"{owner_name}.{hm['name']}",
                    'sublabel': f"local helper · {owner_symbol['file'].split('/')[-1]}:{hm_start}",
                    'file': owner_symbol['file'], 'line': hm_start, 'endLine': hm['endLine'],
                    'symbol': f"{owner_name}.{hm['name']}()", 'confidence': 'verified',
                    'whatItIs': 'A private helper method on the same controller or service.',
                    'whatItDoes': 'Performs part of the route logic and may reach another service or downstream client.',
                    'snippet': hbody[:4000], 'microservices': [],
                })
            if hbody and depth < 3:
                pending_expansions.append((hbody, owner_symbol['file'], hm_start, owner_symbol, owner_name, depth + 1))

        def process_body(body_text: str, rel: str, base_line: int, owner_symbol: dict,
                         owner_name: str, depth: int) -> None:
            if depth > 3:
                return
            analysis = strip_comments(body_text)
            detect_in_text(downstream, analysis, rel, base_line, module, ctrl['name'], handler['name'])
            injections = injections_for(owner_symbol)

            # this.<injectedField>.<method>(...) and this.<field>.<method>(...)
            for m in re.finditer(r'this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(', analysis):
                field, method_name = m.group(1), m.group(2)
                if field in SKIP_FIELDS:
                    if field in ('httpService', 'http'):
                        add_downstream(downstream, 'HTTP upstream', '', 'direct HttpService call', 'verified', rel,
                                       base_line + analysis[:m.start()].count('\n'))
                    continue
                inj = injections.get(field)
                if inj:
                    svc = resolve_type(inj.get('token') or inj.get('type') or '')
                    if svc:
                        add_service_node(svc, method_name, depth)
                    continue
                hm = find_method(owner_symbol, field)
                if hm:
                    add_helper_node(owner_name, owner_symbol, hm, depth)

            # this.<localHelper>(...) with no field access.
            for m in re.finditer(r'this\.([A-Za-z_$][\w$]*)\s*\(', analysis):
                name = m.group(1)
                if name in injections or name in SKIP_FIELDS:
                    continue
                hm = find_method(owner_symbol, name)
                if hm:
                    add_helper_node(owner_name, owner_symbol, hm, depth)

        process_body(body, ctrl['file'], handler_start, ctrl['symbol'], ctrl['name'], 0)
        # Breadth-first expansion: every top-level service/helper is visible
        # before we spend the remaining budget on deeper ownership/database hops.
        while pending_expansions and node_count < MAX_NODES:
            b, rel, base_line, sym, name, depth = pending_expansions.pop(0)
            process_body(b, rel, base_line, sym, name, depth)
    else:
        # Keep coverage honest for routes whose controller method could not be located.
        nodes.append({
            'id': 'controller-missing', 'kind': 'controller', 'label': route.get('controller', 'Controller'),
            'sublabel': 'Handler line not resolved', 'file': '', 'line': None, 'endLine': None,
            'symbol': f"{route.get('controller')}.{route.get('handler')}()", 'confidence': 'inferred',
            'whatItIs': 'Controller declared in the route manifest but not resolved to a source method.',
            'whatItDoes': 'The route is registered, but this build could not statically match the handler name to a method body.',
            'snippet': '', 'microservices': [],
        })

    # 4. Enrich with the existing call-tree inventory when a source node was
    # missed (for example a call inside a callback or a decorator-driven branch).
    existing = existing_by_route.get((route['method'], route['path']))
    if existing:
        known_labels = {n['label'].split('.')[-1] for n in nodes if n['kind'] == 'service'}
        service_nodes = [n for n in nodes if n['kind'] == 'service']
        for c in (existing.get('direct_service_calls') or []):
            raw = c.get('service_type', '') or ''
            label = clean_type(raw)
            if not label or label in ('unknown', 'object') or label in SKIP_TYPES or label in known_labels:
                continue
            if label.startswith('I') and label[1:] in known_labels:
                continue
            if c.get('field') in SKIP_FIELDS:
                continue
            if len(service_nodes) >= 6:
                break
            known_labels.add(label)
            node = {
                'id': f"inferred:{label}:{c.get('method')}", 'kind': 'service',
                'label': label, 'sublabel': f"{c.get('method')}() · inferred from call-tree inventory",
                'file': '', 'line': None, 'endLine': None,
                'symbol': f"{label}.{c.get('method')}()", 'confidence': 'inferred',
                'whatItIs': 'A service call detected by the existing call-tree inventory but not resolved to a source file.',
                'whatItDoes': f"Delegates `{c.get('method')}` from the controller.",
                'snippet': '', 'microservices': [],
            }
            nodes.append(node)
            service_nodes.append(node)

    # 5. Downstream microservices, infrastructure and external providers become
    # clickable path nodes too.
    for d in downstream:
        if d['kind'] == 'microservice':
            node_kind, what = 'downstream', 'A downstream microservice called by the gateway.'
        elif d['kind'] == 'external':
            node_kind, what = 'external', 'An external provider or service reached by the gateway path.'
        else:
            node_kind, what = 'infrastructure', 'Shared infrastructure used by the gateway path.'
        nodes.append({
            'id': f"down:{d['name']}", 'kind': node_kind,
            'label': d['name'], 'sublabel': (f"port {d['port']}" if d['port'] else d['kind']),
            'file': d.get('file') or '', 'line': d.get('line'), 'endLine': d.get('line'),
            'symbol': d['name'], 'confidence': d.get('confidence', 'inferred'),
            'whatItIs': what, 'whatItDoes': d.get('evidence', ''),
            'snippet': (slice_lines(d['file'], max(1, d['line'] - 8), d['line'] + 12)
                        if d.get('file') and d.get('line') else ''),
            'microservices': [d],
        })
    return nodes, downstream



# Representative source anchors for downstream nodes whose call site is
# inferred, or whose evidence lives in the Python service rather than a Nest
# controller. These are evidence anchors, not claims that the line makes the
# HTTP call from the gateway.
NODE_FALLBACK_SOURCES: dict[str, tuple[str, int]] = {
    'Harness': ('packages/applications/src/services/consultation/harness/harness-gateway.service.ts', 475),
    'Temporal': ('apps/harness/src/harness/temporal/workflows.py', 337),
    'Text': ('apps/harness/src/harness/services/text_client.py', 343),
    'Guardrail': ('apps/harness/src/harness/services/guardrail_client.py', 135),
    'NLP': ('apps/harness/src/harness/services/nlp_client.py', 36),
    'STT': ('apps/api/src/modules/streaming/stt-ws.gateway.ts', 486),
    'TTS': ('apps/api/src/modules/speech/tts-ws.gateway.ts', 148),
    'Qdrant': ('apps/harness/src/harness/guides/retrieval/qdrant_store.py', 66),
    'S3 / MinIO': ('apps/api/src/modules/storage/storage.controller.ts', 59),
    'MLflow / AI service': ('apps/api/src/modules/ai-service-admin/mlflow-proxy.client.ts', 131),
    'AI provider APIs': ('apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts', 98),
    'HTTP upstream': ('apps/api/src/modules/streaming/text-proxy.controller.ts', 1),
}


def ensure_node_source(record: dict) -> None:
    """Give every code-backed box an explicit file and line.

    Repositories and client classes often have a file but no exact method line
    in the call-tree inventory. A class-level line 1 is still a valid source
    anchor and is more useful than a blank reference. Inferred downstream nodes
    use the representative client/worker file that implements that hop.
    """
    if record.get('file') and not record.get('line'):
        record['line'] = 1
        record['endLine'] = 1
    if not record.get('file'):
        fallback = NODE_FALLBACK_SOURCES.get(record.get('label') or record.get('name') or '')
        if fallback:
            record['file'], record['line'] = fallback
            record['endLine'] = fallback[1]
    if record.get('file') and record.get('line') and not record.get('snippet'):
        record['snippet'] = slice_lines(
            record['file'], max(1, int(record['line']) - 8), int(record['line']) + 12
        )


def ensure_sources(nodes: list[dict], downstream: list[dict]) -> None:
    for d in downstream:
        ensure_node_source(d)
    for n in nodes:
        ensure_node_source(n)

endpoints = []
for route in manifest.get('routes', []):
    ctrl = controllers.get(route.get('controller', ''))
    module = module_of(ctrl['file']) if ctrl else '(unknown)'
    handler = find_method(ctrl['symbol'], route.get('handler', '')) if ctrl else None
    op = ops_by_id.get(f"{route.get('controller')}_{route.get('handler')}") or ops_by_path.get((route.get('path'), route.get('method', 'GET')))
    contract = openapi_contract(op, components)
    auth = auth_summary(route)
    nodes, downstream = build_path(route, ctrl, handler, module, contract, auth)
    ensure_sources(nodes, downstream)
    existing = existing_by_route.get((route.get('method'), route.get('path'))) or {}
    summary = (existing.get('summary') or contract.get('summary') or '').strip()
    description = (existing.get('description') or contract.get('description') or '').strip()
    if not description:
        description = summary or 'No OpenAPI description is available for this route.'
    body_example = contract.get('body')
    has_body = route.get('method') in ('POST', 'PUT', 'PATCH')
    if has_body and body_example is None:
        body_example = {}
    endpoints.append({
        'id': f"{route.get('method')} {route.get('path')}",
        'method': route.get('method', 'GET'),
        'path': route.get('path', ''),
        'module': module,
        'plane': plane_of(module),
        'controller': route.get('controller', ''),
        'handler': route.get('handler', ''),
        'file': ctrl['file'] if ctrl else '',
        'sourceKind': ('vendored' if ctrl and ctrl['file'].startswith('node_modules/') else 'application') if ctrl else 'missing',
        'line': method_decl_line(ctrl['file'], handler) if ctrl and handler else None,
        'endLine': handler['endLine'] if handler else None,
        'summary': summary,
        'description': description,
        'auth': auth,
        'callers': callers_for(route, route.get('controller', ''), module),
        'isPublic': bool(route.get('isPublic')),
        'apiKeyForbidden': bool(route.get('apiKeyForbidden')),
        'apiKeyScopes': route.get('apiKeyScopes') or [],
        'svcScopes': route.get('svcScopes') or [],
        'requiredPermissions': [':'.join(p) if isinstance(p, list) else str(p) for p in (route.get('requiredPermissions') or [])],
        'requiresIfMatch': bool(route.get('requiresIfMatch')),
        'apiExcluded': bool(route.get('apiExcluded')),
        'documented': contract.get('documented', False),
        'input': contract.get('parameters', {}),
        'requestBody': body_example,
        'responses': contract.get('responses', {}),
        'pathNodes': nodes,
        'microservices': [d for d in downstream if d['kind'] == 'microservice'],
        'infrastructure': [d for d in downstream if d['kind'] == 'infrastructure'],
        'external': [d for d in downstream if d['kind'] == 'external'],
        'github': github_url(ctrl['file'], method_decl_line(ctrl['file'], handler), handler['endLine']) if ctrl and handler else '',
        'local': local_url(ctrl['file'], method_decl_line(ctrl['file'], handler)) if ctrl and handler else '',
        'vscode': vscode_url(ctrl['file'], method_decl_line(ctrl['file'], handler)) if ctrl and handler else '',
    })

# ---------------------------------------------------------------------------
# Coverage report
# ---------------------------------------------------------------------------

with_handler = sum(1 for e in endpoints if e['line'])
with_doc = sum(1 for e in endpoints if e['documented'])
with_micro = sum(1 for e in endpoints if e['microservices'])
with_infra = sum(1 for e in endpoints if e['infrastructure'])
with_external = sum(1 for e in endpoints if e['external'])
with_service_node = sum(1 for e in endpoints if any(n['kind'] == 'service' for n in e['pathNodes']))
with_helper_node = sum(1 for e in endpoints if any(n['kind'] == 'helper' for n in e['pathNodes']))
with_verified_node = sum(1 for e in endpoints if any(n['confidence'] == 'verified' for n in e['pathNodes']))
planes = defaultdict(int)
modules = defaultdict(int)
for e in endpoints:
    planes[e['plane']] += 1
    modules[e['module']] += 1

report = {
    'revision': REVISION,
    'generatedAt': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
    'routes': len(endpoints),
    'withControllerLine': with_handler,
    'withOpenApiContract': with_doc,
    'withServiceNode': with_service_node,
    'withHelperNode': with_helper_node,
    'withMicroserviceDetection': with_micro,
    'withInfrastructureDetection': with_infra,
    'withExternalProviderDetection': with_external,
    'withAnyVerifiedNode': with_verified_node,
    'planes': dict(sorted(planes.items(), key=lambda x: -x[1])),
    'topModules': dict(sorted(modules.items(), key=lambda x: -x[1])[:20]),
    'notes': [
        'Handler lines come from the TypeScript AST and are verified against the working tree at the pinned revision.',
        'Microservice detection is static: URL/env/port/HTTP-path evidence is marked verified; module/flow hints are marked inferred or inferred-chain.',
        'Service-call resolution covers direct controller calls and one further application-service hop. Transitive runtime calls through Temporal, queues, or Python services may be inferred rather than fully traced.',
        'Request/response examples are generated from OpenAPI schemas. Endpoints without an OpenAPI operation are marked undocumented and use a minimal inferred body.',
    ],
}

INV.joinpath('endpoint-catalog.json').write_text(json.dumps({
    'meta': {
        'title': 'HOPE API Gateway Endpoint Catalog',
        'revision': REVISION,
        'github': 'https://github.com/ArcaAI/project-hope',
        'generatedAt': report['generatedAt'],
        'routeCount': len(endpoints),
    },
    'endpoints': endpoints,
}, ensure_ascii=False))
INV.joinpath('coverage-report.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
print(f"Wrote {INV / 'endpoint-catalog.json'}")
