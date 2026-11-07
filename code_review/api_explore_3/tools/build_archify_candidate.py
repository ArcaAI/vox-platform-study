#!/usr/bin/env python3
"""
Create the API Gateway overview candidate from the frozen deep-dive baseline.

The baseline is read-only. This script clones it, repoints the revision to HEAD,
reflows the bottom half into a readable path (routes -> controllers ->
application services -> microservice block -> data/platform block), and adds the
Python services the deep dive only summarized: NLP, Guardrail, Harness,
Temporal, Qdrant and Prometheus.
"""
from __future__ import annotations

import copy
import json
import subprocess
from pathlib import Path

ROOT = Path('/Users/apple/repos/VOX')
REPO = ROOT / 'project-hope'
BASELINE = ROOT / 'review/api_explore/diagrams/api-gateway-internals-deep-dive.candidate.json'
TARGET = ROOT / 'review/api_explore_3/diagrams/api-gateway-overview.candidate.json'
REVISION = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip()

candidate = copy.deepcopy(json.loads(BASELINE.read_text()))
candidate['meta']['title'] = 'HOPE API Gateway - Runtime Path & Downstream Services'
candidate['meta']['subtitle'] = '818 routes, 148 controllers, the global request pipeline, application services, Python microservices and data infrastructure'
candidate['meta']['output'] = 'review/api_explore_3/api-gateway-overview.html'
candidate['meta']['quality_profile'] = 'showcase'
candidate['meta']['repository']['revision'] = REVISION
candidate['meta']['repository']['link_mode'] = 'web'
candidate['layout']['cols'] = 4
candidate['layout']['cellW'] = 232
candidate['layout']['cellH'] = 112
candidate['layout']['gapX'] = 20
candidate['layout']['gapY'] = 40

components = {c['id']: c for c in candidate['components']}
SIZE = [222, 88]

# Five-column flow. Top half: boot, guards, interceptors, filters, auth.
# Bottom half: route surface, controllers/modules, then a contiguous
# microservice block (cols 1-4), with data/platform in the left/bottom band.
POS = {
    'main_boot': (0, 0), 'app_module': (0, 1), 'config': (0, 2), 'boot_audits': (0, 3),
    'g_throttle': (1, 0), 'g_cls': (1, 1), 'g_unified': (1, 2), 'g_tenantlock': (1, 3),
    'g_consent': (2, 3), 'g_sse': (2, 2), 'g_origin': (2, 1), 'g_occ': (2, 0),
    'i_metrics': (3, 0), 'i_ratelim': (3, 1), 'i_context': (3, 2), 'i_exception': (3, 3),
    'i_maint': (4, 2), 'i_imperson': (4, 1), 'i_etag': (4, 0),
    'f_all': (5, 0), 'f_envelope': (5, 1), 'f_notfound': (5, 2), 'f_consentf': (5, 3),
    'authz_guard': (6, 0), 'auth_svc': (6, 1), 'apikey_svc': (6, 2), 'svcacct_svc': (6, 3),
    'consent_svc': (7, 0), 'origin_reg': (7, 1), 'route_catalog': (7, 2),

    # Controllers/modules, then application services and a contiguous
    # downstream microservice block.
    'mod_clinical': (8, 0), 'mod_agent': (8, 1), 'mod_ai': (8, 2), 'mod_tenancy': (8, 3),
    'app_services': (9, 0), 'ext_harness': (9, 1), 'ext_text': (9, 2), 'ext_nlp': (9, 3),
    'prisma': (10, 0), 'ext_temporal': (10, 1), 'ext_guardrail': (10, 2), 'ext_stt': (10, 3),
    'postgres': (11, 0), 'ext_tts': (11, 1), 'ext_ai': (11, 2),

    # Data, storage and background platform.
    'qdrant': (12, 0), 's3': (12, 1), 'redis': (12, 2), 'otel': (12, 3),
    'vault': (13, 0), 'mod_storage': (13, 1), 'bullmq': (13, 2), 'mod_ops': (13, 3),
    'workers': (14, 0), 'checkpoint': (14, 1), 'prometheus': (14, 2), 'stream': (14, 3),
}
for cid, (row, col) in POS.items():
    if cid in components:
        components[cid]['row'] = row
        components[cid]['col'] = col
        components[cid]['size'] = SIZE.copy()


def add(node: dict) -> None:
    node.setdefault('size', SIZE.copy())
    components[node['id']] = node


add({
    'id': 'route_catalog', 'type': 'backend', 'label': 'Route inventory',
    'sublabel': '818 routes · 148 controllers · 3 surfaces',
    'tag': 'routes', 'row': 7, 'col': 2, 'size': SIZE.copy(),
    'sources': [
        {'path': 'apps/api/route-manifest.json', 'line': 1, 'label': 'Authoritative 818-route manifest'},
        {'path': 'apps/api/openapi.json', 'line': 1, 'label': '607 public OpenAPI paths'},
    ],
})
add({
    'id': 'app_services', 'type': 'backend', 'label': 'Application services',
    'sublabel': 'Domain rules, clients, persistence',
    'tag': 'services', 'row': 9, 'col': 0, 'size': SIZE.copy(),
    'sources': [
        {'path': 'packages/applications/src/services/index.ts', 'line': 1, 'label': 'Application-service barrel'},
        {'path': 'packages/applications/src/services/consultation/jobs/consultation-job.service.ts', 'line': 102,
         'label': 'Idempotent consultation job service'},
    ],
})
add({
    'id': 'ext_nlp', 'type': 'external', 'label': 'NLP Service',
    'sublabel': 'NLP on :8864 (apps/nlp)',
    'tag': 'external', 'row': 9, 'col': 3, 'size': SIZE.copy(),
    'sources': [
        {'path': 'apps/api/src/modules/ai-inference/ai-inference.client.ts', 'line': 81,
         'label': 'classifyTokens call to NLP'},
        {'path': 'apps/api/src/modules/ai-inference/ai-inference.client.ts', 'line': 105,
         'label': 'NLP_URL resolution'},
    ],
})
add({
    'id': 'ext_guardrail', 'type': 'external', 'label': 'Guardrail Service',
    'sublabel': 'Safety on :8863 (apps/guardrail)',
    'tag': 'external', 'row': 10, 'col': 2, 'size': SIZE.copy(),
    'sources': [
        {'path': 'apps/api/src/modules/ai-inference/ai-inference.client.ts', 'line': 76,
         'label': 'analyzeGuardrail call'},
        {'path': 'apps/api/src/modules/ai-inference/ai-inference.client.ts', 'line': 101,
         'label': 'GUARDRAIL_URL resolution'},
    ],
})
add({
    'id': 'ext_harness', 'type': 'external', 'label': 'Harness Service',
    'sublabel': 'Workflow API on :8866',
    'tag': 'external', 'row': 9, 'col': 1, 'size': SIZE.copy(),
    'sources': [
        {'path': 'packages/applications/src/services/consultation/harness/harness-gateway.service.ts', 'line': 475,
         'label': 'start() harness workflow'},
        {'path': 'apps/harness/src/harness/main.py', 'line': 99, 'label': 'Harness FastAPI application'},
    ],
})
add({
    'id': 'ext_temporal', 'type': 'external', 'label': 'Temporal',
    'sublabel': 'Durable activities & signals',
    'tag': 'external', 'row': 10, 'col': 1, 'size': SIZE.copy(),
    'sources': [
        {'path': 'apps/harness/src/harness/temporal/workflows.py', 'line': 337,
         'label': 'HarnessDocWorkflow definition'},
        {'path': 'apps/harness/src/harness/main.py', 'line': 1, 'label': 'Harness Temporal worker bootstrap'},
    ],
})
add({
    'id': 'qdrant', 'type': 'database', 'label': 'Qdrant',
    'sublabel': 'Knowledge vectors / retrieval',
    'tag': 'vector', 'row': 12, 'col': 0, 'size': SIZE.copy(),
    'sources': [
        {'path': 'apps/api/src/modules/knowledge/knowledge.controller.ts', 'line': 86,
         'label': 'Qdrant vector cleanup path'},
        {'path': 'apps/api/src/modules/consultation/harness-internal.controller.ts', 'line': 1,
         'label': 'Harness knowledge callbacks'},
    ],
})
add({
    'id': 'prometheus', 'type': 'cloud', 'label': 'Prometheus',
    'sublabel': 'Metrics scrape /metrics',
    'tag': 'observability', 'row': 14, 'col': 2, 'size': SIZE.copy(),
    'sources': [
        {'path': 'apps/api/src/observability/metrics.ts', 'line': 1, 'label': 'API-process Prometheus metrics'},
        {'path': 'apps/api/src/main.ts', 'line': 50, 'label': 'Global prefix excludes /metrics'},
    ],
})

candidate['components'] = sorted(components.values(), key=lambda c: (c['row'], c['col'], c['id']))

candidate['boundaries'] = [
    {'kind': 'region', 'label': 'Bootstrap & configuration', 'wraps': ['main_boot', 'app_module', 'config', 'boot_audits']},
    {'kind': 'security-group', 'label': 'Global guards (order 1-8)',
     'wraps': ['g_throttle', 'g_cls', 'g_unified', 'g_tenantlock', 'g_consent', 'g_sse', 'g_origin', 'g_occ']},
    {'kind': 'region', 'label': 'Global interceptors',
     'wraps': ['i_metrics', 'i_ratelim', 'i_context', 'i_exception', 'i_maint', 'i_imperson', 'i_etag']},
    {'kind': 'security-group', 'label': 'Global exception filters (last wins)',
     'wraps': ['f_all', 'f_envelope', 'f_notfound', 'f_consentf']},
    {'kind': 'security-group', 'label': 'AuthN / AuthZ & tenancy services',
     'wraps': ['authz_guard', 'auth_svc', 'apikey_svc', 'svcacct_svc', 'consent_svc', 'origin_reg']},
    {'kind': 'region', 'label': 'Route surface & domain modules',
     'wraps': ['route_catalog', 'mod_clinical', 'mod_agent', 'mod_ai', 'mod_tenancy']},
    {'kind': 'region', 'label': 'Application-service layer', 'wraps': ['app_services']},
    {'kind': 'region', 'label': 'Downstream microservices',
     'wraps': ['ext_harness', 'ext_text', 'ext_nlp', 'ext_temporal', 'ext_guardrail', 'ext_stt', 'ext_tts', 'ext_ai']},
    {'kind': 'region', 'label': 'Application persistence', 'wraps': ['prisma', 'postgres']},
    {'kind': 'region', 'label': 'Data, storage & background platform',
     'wraps': ['qdrant', 's3', 'redis', 'otel', 'vault', 'mod_storage', 'bullmq', 'mod_ops',
               'workers', 'checkpoint', 'prometheus', 'stream']},
]

# Keep only edges whose endpoints still exist, then add a small, readable
# service path. Unlabeled edges keep the showcase label-clearance gates happy.
connections = [c for c in candidate['connections'] if c['id'][:1] in ('k', 'g', 'i', 'f')]
seen = {(c['from'], c['to']) for c in connections}
next_id = 0


def edge(src: str, dst: str) -> None:
    global next_id
    if src not in components or dst not in components or (src, dst) in seen:
        return
    connections.append({'id': f'e{next_id}', 'from': src, 'to': dst})
    seen.add((src, dst))
    next_id += 1


edge('mod_clinical', 'app_services')
edge('mod_ai', 'ext_nlp')
edge('app_services', 'ext_harness')
edge('app_services', 'prisma')
edge('ext_harness', 'ext_temporal')
edge('ext_harness', 'ext_text')
edge('prisma', 'postgres')
edge('mod_storage', 's3')
edge('bullmq', 'redis')
edge('mod_ops', 'prometheus')
edge('workers', 'checkpoint')
candidate['connections'] = connections

candidate['meta']['views'] = [
    {
        'id': 'pipeline',
        'label': 'Request pipeline',
        'focus': ['g_throttle', 'g_cls', 'g_unified', 'g_tenantlock', 'g_consent', 'g_sse', 'g_origin', 'g_occ',
                  'i_metrics', 'i_ratelim', 'i_context', 'i_exception', 'i_maint', 'i_imperson', 'i_etag',
                  'f_all', 'f_envelope', 'f_notfound', 'f_consentf', 'route_catalog', 'app_services'],
        'note': 'Guards, then interceptors, then filters; controller handlers delegate into application services.',
    },
    {
        'id': 'surface',
        'label': '818-route surface',
        'focus': ['route_catalog', 'mod_clinical', 'mod_agent', 'mod_ai', 'mod_tenancy',
                  'app_services', 'ext_harness', 'ext_text', 'ext_nlp', 'ext_guardrail'],
        'note': '148 controllers across 77 module files; 607 operations are in the public OpenAPI document.',
    },
    {
        'id': 'downstream',
        'label': 'Downstream services',
        'focus': ['app_services', 'ext_harness', 'ext_text', 'ext_nlp', 'ext_guardrail',
                  'ext_temporal', 'ext_stt', 'ext_tts', 'ext_ai', 'qdrant', 'prisma', 'postgres'],
        'note': 'Proxies and clients are the verified hop. Harness owns Temporal and calls Text/Guardrail/Qdrant inside the workflow.',
    },
    {
        'id': 'data',
        'label': 'Data & side processes',
        'focus': ['prisma', 'postgres', 'redis', 'bullmq', 's3', 'vault', 'qdrant', 'prometheus',
                  'workers', 'checkpoint', 'stream', 'otel'],
        'note': 'Postgres is transactional, Redis backs throttling/tickets/BullMQ, S3 stores media/weights and Qdrant stores knowledge vectors.',
    },
    {
        'id': 'boot',
        'label': 'Boot audits',
        'focus': ['main_boot', 'app_module', 'config', 'boot_audits', 'g_unified', 'g_consent', 'g_occ'],
        'note': 'Startup audits fail closed on permission, scope, consent, WebSocket and CASL drift; OCC is warn-only.',
    },
]

candidate['cards'] = [
    {
        'dot': 'cyan',
        'title': 'Request lifecycle (order is load-bearing)',
        'items': [
            'Guards run before interceptors: 429/401/403 never reach MetricsInterceptor; an Express response middleware counts them instead.',
            '1 TieredThrottlerGuard -> 2 ClsGuard -> 3 UnifiedAuthGuard -> 4 TenantLockGuard -> 5 PatientConsentGuard -> 6 TenantOwnedResourceSSEGuard -> 7 OriginTenantBindingGuard -> 8 RequiresIfMatchGuard.',
            'Interceptors: Metrics -> RateLimitHeaders -> Context -> Exception -> Maintenance -> ImpersonationAudit -> ETag (ETag is registered from main.ts).',
            'Filters: AllExceptions -> HttpExceptionEnvelope -> DataNotFound -> Consent; Nest consults the LAST registered matching filter first.',
        ],
    },
    {
        'dot': 'rose',
        'title': 'Identity, authz and tenancy',
        'items': [
            'UnifiedAuthGuard is deny-by-default and accepts JWT, API key, service account and stream tickets; unknown credential classes fail closed.',
            'AuthorizationGuard applies CASL/RBAC abilities at controller/route level; PatientConsentGuard adds patient-scoped consent/ABAC.',
            'Tenant isolation: CLS store -> TenantContextProvider/Prisma tenant scope; OriginTenantBindingGuard binds origins; the SSE guard checks resource ownership.',
            'Errors are shaped as 404-over-403 where existence must not leak.',
        ],
    },
    {
        'dot': 'violet',
        'title': '818 routes and the controller layer',
        'items': [
            'The route manifest is the inventory: 818 route-methods across 148 controllers and 77 module files. 607 operations are in the public OpenAPI document.',
            'Clinical & Consultation: 166 routes. Agentic & Workflows: 165. AI Models & Guardrails: 135. Speech & Audio: 40. Platform Admin & Tenancy: 312.',
            'Controllers parse input and delegate; application services in packages/applications own domain rules, clients and persistence.',
            'Every route-method appears in the companion explorer with controller/service line numbers, input/output and client examples.',
        ],
    },
    {
        'dot': 'amber',
        'title': 'Downstream service matrix',
        'items': [
            'STT :8861, Text :8862, Guardrail :8863, NLP :8864, TTS :8865, Harness :8866. Proxy/gateway controllers and ai-inference.client.ts provide verified URL evidence.',
            'Harness owns durable HarnessDocWorkflow execution in Temporal; the gateway only speaks HTTP to Harness, so Temporal concerns do not leak into NestJS.',
            'Harness workflow calls Text for generation, Guardrail for safety gates and Qdrant for retrieval. These are inferred-chain hops when the verified upstream is Harness.',
            'External AI providers are reached through routing policy and provider connections, not through the Python text service.',
        ],
    },
    {
        'dot': 'emerald',
        'title': 'Data, workers and side processes',
        'items': [
            'Prisma is tenant-scoped through TenantContextProvider; Postgres is the transactional store; Redis backs throttling, tickets and BullMQ.',
            'BullMQ jobs cover consultation summaries/entities, DNA reports, RAG ingest, webhook delivery, AI usage outbox, fact ledger, checkpoints and model download.',
            'The checkpoint worker is a separate process for tenant export/restore; the API process keeps only producers.',
            'S3/MinIO stores tenant media and model artifacts; Vault supplies secrets; Qdrant stores knowledge vectors; Prometheus scrapes /metrics.',
        ],
    },
    {
        'dot': 'slate',
        'title': 'Evidence and how to use this with the explorer',
        'items': [
            f'All source links are pinned to {REVISION[:12]}. Open the companion explorer at review/api_explore_3/api-gateway-explorer.html for all 818 endpoints.',
            'Explorer boxes carry code file/function/line, request input/output, curl/fetch examples and a verified/inferred/inferred-chain confidence label.',
            'The deep dive diagram remains pinned to its original revision in review/api_explore/diagrams; this overview is the new HEAD snapshot.',
            'Static analysis is not runtime tracing: queues, Temporal activities and Python-internal calls can be wider than the gateway code shows.',
        ],
    },
]

TARGET.parent.mkdir(parents=True, exist_ok=True)
TARGET.write_text(json.dumps(candidate, indent=2) + '\n')
print(f'Wrote {TARGET}')
print(f'components={len(candidate["components"])} connections={len(candidate["connections"])} boundaries={len(candidate["boundaries"])} cards={len(candidate["cards"])}')
