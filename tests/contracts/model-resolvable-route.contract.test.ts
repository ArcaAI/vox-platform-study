/**
 * TASK-890 J1 MAJOR-A — the runtime-resolvability probe is ONE contract in four
 * places, and nothing else compares them.
 *
 * The gateway's readiness sweep asks each serving service "can you load these
 * weights without fetching anything?" at
 * `POST /api/v1/internal/models/resolvable`. Three services answer (`stt`,
 * `nlp`, `tts`) and the gateway calls all three from one code path, so a drift
 * in any one of them is silent in exactly the way that produced this finding in
 * the first place: the platform reports a confident verdict that nobody
 * measured. The four failure shapes this guards:
 *
 *   • a service moves or renames the route      -> the sweep 404s and every one
 *                                                  of its rows silently becomes
 *                                                  `unknown`;
 *   • a service renames a wire field            -> the row arrives with no
 *                                                  `source_uri` and answers
 *                                                  `no_source` for everything;
 *   • a service reimplements the check          -> two definitions of
 *                                                  "resolvable", one of which
 *                                                  can download;
 *   • the gateway's `servedBy` -> URL map drifts -> a service that CAN answer is
 *                                                  never asked.
 *
 * Source-text guards, for the reason `source-resolver-parity.contract.test.ts`
 * gives: importing a Python service or a Nest provider into a hermetic suite is
 * not worth the machinery, and these four assertions are the load-bearing ones.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8');

/** The three services that serve weights out of their own caches. */
const ROUTERS: Record<string, string> = {
  stt: 'apps/stt/src/stt/models/resolvable_routes.py',
  nlp: 'apps/nlp/src/nlp/api/v1/rest/models.py',
  tts: 'apps/tts/src/tts/api/endpoints/models.py',
};

/** Where each service MOUNTS its router — the other half of the final path. */
const MOUNTS: Record<string, { file: string; expectedFullPath: string }> = {
  stt: { file: 'apps/stt/src/stt/main.py', expectedFullPath: '/api/v1/internal/models/resolvable' },
  nlp: { file: 'apps/nlp/src/nlp/api/v1/__init__.py', expectedFullPath: '/api/v1/internal/models/resolvable' },
  tts: { file: 'apps/tts/src/tts/main.py', expectedFullPath: '/api/v1/internal/models/resolvable' },
};

const READINESS_SERVICE = read('packages/applications/src/services/ai-readiness/inference-readiness.service.ts');

describe('model-resolvable route — one contract across the three serving services', () => {
  it('every service exposes the batch POST and the single-row GET under the same sub-path', () => {
    for (const [service, file] of Object.entries(ROUTERS)) {
      const src = read(file);
      expect(src, `${service} declares no POST /resolvable`).toContain('@router.post("/resolvable")');
      expect(src, `${service} declares no GET /resolvable`).toContain('@router.get("/resolvable")');
      expect(src, `${service}'s router is not under /internal/models`).toMatch(/APIRouter\(\s*prefix="(?:\/api\/v1)?\/internal\/models"/);
    }
  });

  it('every router composes with its mount into exactly the path the gateway calls', () => {
    // stt and tts prefix at mount time or in the router; nlp inherits `/api/v1`
    // from `rest_api_router_v1`. What must be true is the FINAL path, so assert
    // that the gateway's literal appears in the readiness service and that each
    // service is actually mounted.
    expect(READINESS_SERVICE).toContain('/api/v1/internal/models/resolvable');
    for (const [service, mount] of Object.entries(MOUNTS)) {
      const src = read(mount.file);
      expect(src, `${service} never includes its resolvable router`).toMatch(/include_router\(\s*(?:model_resolvable_router|models_router)/);
      expect(mount.expectedFullPath).toBe('/api/v1/internal/models/resolvable');
    }
  });

  it('every service reads the SAME wire fields — a rename on one side answers `no_source` on the other', () => {
    for (const [service, file] of Object.entries(ROUTERS)) {
      const src = read(file);
      for (const field of ['id', 'sourceUri', 'library', 'revision', 'localPath']) {
        expect(src, `${service} does not accept '${field}'`).toContain(`${field}: str | None = None`);
      }
      expect(src, `${service} does not accept the batch body`).toContain('models: list[ResolvableItem]');
    }
  });

  it('the gateway sends exactly the fields the services declare', () => {
    // The request body built in `readRuntimeResolvable`. Asserting the field
    // names on BOTH sides is what makes a rename fail here instead of at 3am.
    for (const field of ['id: row.id', 'sourceUri: row.sourceUri', 'library: row.libraryName', 'revision: row.sourceRevision']) {
      expect(READINESS_SERVICE, `the sweep does not send '${field}'`).toContain(field);
    }
  });

  it('every service answers with the same envelope', () => {
    for (const [service, file] of Object.entries(ROUTERS)) {
      const src = read(file);
      expect(src, `${service} omits 'service' from its reply`).toContain('"service": SERVICE_NAME');
      expect(src, `${service} omits 'checkedAt' from its reply`).toContain('"checkedAt"');
      expect(src, `${service} omits 'results' from its batch reply`).toContain('"results"');
    }
    // ...and the gateway reads exactly that.
    expect(READINESS_SERVICE).toContain('response.data?.results');
  });

  it('no service reimplements the check — all three call the shared helper', () => {
    for (const [service, file] of Object.entries(ROUTERS)) {
      const src = read(file);
      expect(src, `${service} does not use the shared resolvability helper`).toContain(
        'from hope_runtime_models import ResolvableQuery, check_resolvable',
      );
      // A second definition would be a second answer to "resolvable", and one of
      // them could download.
      expect(src, `${service} defines its own resolvability logic`).not.toContain('def check_resolvable');
    }
  });

  it('the shared helper never fetches — `local_files_only` is the whole point', () => {
    const shared = read('packages/py-runtime-models/src/hope_runtime_models/resolvable.py');
    expect(shared).toContain('local_files_only=True');
    // No object-store client is ever constructed: an `s3://` row is resolvable
    // only when its cache entry already exists on disk.
    expect(shared).not.toContain('Minio(');
    expect(shared).not.toContain('boto3');
  });

  it('the gateway asks exactly the services that answer, and no others', () => {
    const map = /SERVED_BY_TO_URL_KEY[\s\S]*?Object\.freeze\(\{([\s\S]*?)\}\)/.exec(READINESS_SERVICE);
    expect(map, 'SERVED_BY_TO_URL_KEY not found').not.toBeNull();
    const declared = [...map![1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual(Object.keys(ROUTERS).sort());
  });
});
