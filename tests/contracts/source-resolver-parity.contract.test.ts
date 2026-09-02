/**
 * `models/source_resolver.py` exists in FOUR copies — stt, nlp, tts, harness.
 * Nothing in CI has ever compared them, and they have now drifted twice on the
 * same line of reasoning:
 *
 *   1. TASK-855 L6 mirrored the resolver into nlp and tts rather than sharing it.
 *   2. The HF_HUB_OFFLINE fix (2502ac387) landed in stt and nlp only, leaving tts
 *      and harness raising pre-emptively for a further day. tts is a
 *      bucket-mounted service running with HF_HUB_OFFLINE=1, so every resolve
 *      reaching `_resolve_hf` failed even with the weights mounted and present.
 *
 * Consolidating the four into one shared package is the real answer and is its
 * own ticket: every suite monkeypatches `<svc>.models.source_resolver.
 * _hf_snapshot_download`, so a naive re-export rebinds the SHIM's attribute
 * while the shared body resolves its own global — stubs silently bypassed and
 * hermetic suites reaching the network, failing as a hang rather than a red
 * test. Until that lands, this guard is the cheap thing that would have caught
 * both drifts at the introducing commit.
 *
 * It deliberately does NOT demand byte-identity: the copies carry legitimate
 * per-service differences (harness uses boto3 because it already ships it and
 * no `minio`; tts documents having no `AiModel.localPath`). A brittle guard is
 * one somebody weakens. These two assertions are the load-bearing ones.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');

const RESOLVERS: Record<string, string> = {
  stt: 'apps/stt/src/stt/models/source_resolver.py',
  nlp: 'apps/nlp/src/nlp/models/source_resolver.py',
  tts: 'apps/tts/src/tts/models/source_resolver.py',
  harness: 'apps/harness/src/harness/models/source_resolver.py',
};

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8');

/** Every `def`/`async def` name in a module, in source order. */
function defNames(source: string): string[] {
  return [...source.matchAll(/^(?:async )?def ([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
}

/** The body of `_resolve_hf`, up to the next top-level `def`. */
function resolveHfBody(source: string): string {
  const start = source.search(/^(?:async )?def _resolve_hf\b/m);
  if (start === -1) return '';
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^(?:async )?def /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('source_resolver.py — the four copies stay in step', () => {
  it('every copy declares the same shared core functions', () => {
    // Not "the same functions" — a service may add its own. Every function the
    // SHARED core defines must exist everywhere, or one copy has lost a
    // capability the others still advertise.
    const shared = ['resolve_model_dir', '_resolve_hf', '_resolve_s3', '_resolve_file', '_verify_checksum_sync', '_hf_snapshot_download'];
    for (const [service, path] of Object.entries(RESOLVERS)) {
      const names = defNames(read(path));
      for (const fn of shared) {
        expect(names, `${service} (${path}) is missing ${fn}()`).toContain(fn);
      }
    }
  });

  it('no copy raises on HF_HUB_OFFLINE before trying the cache', () => {
    // THE regression that drifted twice. huggingface_hub honours HF_HUB_OFFLINE
    // by serving the LOCAL CACHE and never touching the network, so a raise
    // placed BEFORE the download call pre-empts exactly the behaviour its own
    // error message recommends ("pre-populate the hub cache"). The offline case
    // must be reported from the except path, after a real cache MISS.
    for (const [service, path] of Object.entries(RESOLVERS)) {
      const body = resolveHfBody(read(path));
      expect(body, `${service}: _resolve_hf() not found in ${path}`).not.toBe('');

      const download = body.search(/_hf_snapshot_download/);
      const offlineRaise = body.search(/^\s+if offline:/m);
      expect(download, `${service}: _resolve_hf() never calls _hf_snapshot_download`).toBeGreaterThan(-1);

      if (offlineRaise !== -1) {
        expect(
          offlineRaise,
          `${service} (${path}) raises on HF_HUB_OFFLINE BEFORE calling _hf_snapshot_download. ` +
            'That makes a mounted, fully-populated cache unreadable and turns a cache hit into a hard ' +
            'failure. Report the offline case from the except path instead — see commit 2502ac387.',
        ).toBeGreaterThan(download);
      }
    }
  });
});
