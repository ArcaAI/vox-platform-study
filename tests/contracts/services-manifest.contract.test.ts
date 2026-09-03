/**
 * `.github/services.json` is the single source of truth for the
 * buildable service inventory. This test is what makes that claim true.
 *
 * The inventory was previously hand-maintained in five places (build.yml job
 * set, promote.sh SERVICES, scan.yml, publish.yml, SERVICE_TAG_PREFIXES). A
 * service added to four of five is a silent partial deployment: the image
 * builds, and promotion skips it with a warning nobody reads
 * (`promote.sh`: "SKIP ${svc} — no ${source_ref} found").
 *
 * Every assertion below fails in BOTH directions. A one-way check (manifest ⊆
 * reality) would pass while a real build job goes unlisted, which is the exact
 * drift this file exists to prevent.
 *
 * Deliberately compared against the GitLab config while it is still
 * authoritative. When `.gitlab/ci/**` is archived , retarget
 * these parses at the GitHub workflows rather than deleting the test — the
 * invariant outlives the transport.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SERVICE_TAG_PREFIXES, PLATFORM_TRAIN_PREFIX } from '../../packages/utils/src/version-grammar';

const REPO_ROOT = resolve(__dirname, '../..');

const read = (relativePath: string): string => readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');

interface ServiceEntry {
  name: string;
  tagPrefixes: string[];
  dockerfile: string;
  context: string;
  target: string | null;
  pythonBase: boolean;
  promotable: boolean;
  platforms: string[];
  paths: string[];
  buildArgs?: Record<string, string>;
}

const manifest = JSON.parse(read('.github/services.json')) as {
  readme: string[];
  services: ServiceEntry[];
};
const services = manifest.services;

// ── Parsers over the CI config ──────────────────────────────────────────────

const buildYml = read('.gitlab/ci/build.yml');

/**
 * Split build.yml into top-level job blocks.
 *
 * Boundaries are EVERY column-0 key, dotted ones included; only the undotted
 * ones are returned as jobs. Splitting and job-hood have to be separate
 * questions: a leading dot makes GitLab treat a key as a hidden template that
 * never runs, so `.build-vllm` is not a job — but its body still contains
 * `SERVICE_NAME: vllm`, and if a hidden key does not END the preceding block,
 * that SERVICE_NAME is silently attributed to whichever real job happens to
 * sit above it. That is not hypothetical: with vLLM on hold, `.build-vllm`
 * follows `verify-lmstudio-runtime`, which declares no SERVICE_NAME of its
 * own and therefore inherited `vllm` — reporting drift against a manifest
 * that was in fact correct.
 */
function buildJobBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  const headings = [...buildYml.matchAll(/^(\.?[a-z][a-z0-9-]*):$/gm)];

  headings.forEach((heading, index) => {
    const start = heading.index!;
    const end = index + 1 < headings.length ? headings[index + 1].index! : buildYml.length;
    if (!heading[1].startsWith('.')) blocks.set(heading[1], buildYml.slice(start, end));
  });

  return blocks;
}

/** `SERVICE_NAME: api` under a job's `variables:`. */
function serviceNameOf(block: string): string | null {
  return /^\s+SERVICE_NAME:\s*(\S+)\s*$/m.exec(block)?.[1] ?? null;
}

/**
 * Tag prefixes a job's rules react to. Handles both spellings build.yml uses:
 *   /^(TEXT|STT|GUARD|TTS|HARNESS|NLP|ALL)-/ — alternation group
 *   /^API-/ || $CI_COMMIT_TAG =~ /^ALL-/ — separate clauses
 */
function tagPrefixesOf(block: string): Set<string> {
  const found = new Set<string>();
  for (const match of block.matchAll(/\/\^\(?([A-Z][A-Z|]*)\)?-\//g)) {
    for (const prefix of match[1].split('|')) found.add(prefix);
  }
  return found;
}

const jobsByServiceName = new Map<string, { job: string; block: string }>();
for (const [job, block] of buildJobBlocks()) {
  const serviceName = serviceNameOf(block);
  if (serviceName) jobsByServiceName.set(serviceName, { job, block });
}

/** `SERVICES="api stt-ml-runtime ..."` in promote.sh. */
const promoteServices = (() => {
  const match = /^SERVICES="([^"]+)"/m.exec(read('.gitlab/ci/promote.sh'));
  if (!match) throw new Error('promote.sh: could not locate the SERVICES= line');
  return match[1].trim().split(/\s+/);
})();

const sorted = (values: Iterable<string>): string[] => [...values].sort();

// ── The contract ────────────────────────────────────────────────────────────

describe('services manifest — internal consistency', () => {
  it('is non-empty and every name is unique', () => {
    expect(services.length).toBeGreaterThan(0);
    expect(sorted(services.map((s) => s.name))).toEqual(sorted(new Set(services.map((s) => s.name))));
  });

  it('every declared Dockerfile exists on disk', () => {
    for (const service of services) {
      expect(() => read(service.dockerfile), `${service.name}: ${service.dockerfile} not found`).not.toThrow();
    }
  });

  it('never lists ALL in tagPrefixes — the platform train is implicit', () => {
    for (const service of services) {
      expect(service.tagPrefixes, `${service.name} lists ${PLATFORM_TRAIN_PREFIX} explicitly`).not.toContain(
        PLATFORM_TRAIN_PREFIX,
      );
    }
  });

  it('declares at least one path filter per service', () => {
    for (const service of services) {
      expect(service.paths.length, `${service.name} has no paths — it would never rebuild`).toBeGreaterThan(0);
    }
  });
});

describe('services manifest ⟷ version-grammar.ts', () => {
  it('every tagPrefix used is a known SERVICE_TAG_PREFIX', () => {
    const known = new Set<string>(SERVICE_TAG_PREFIXES);
    for (const service of services) {
      for (const prefix of service.tagPrefixes) {
        expect(known, `${service.name}: "${prefix}" is not in SERVICE_TAG_PREFIXES`).toContain(prefix);
      }
    }
  });

  it('every SERVICE_TAG_PREFIX builds at least one image', () => {
    // A prefix nobody claims yields a tag that passes the release-tag gate,
    // runs a pipeline, and builds nothing — a release the console can name and
    // the registry cannot serve.
    const claimed = new Set(services.flatMap((s) => s.tagPrefixes));
    const unclaimed = SERVICE_TAG_PREFIXES.filter((p) => p !== PLATFORM_TRAIN_PREFIX && !claimed.has(p));
    expect(unclaimed, `prefixes that build nothing: ${unclaimed.join(', ')}`).toEqual([]);
  });
});

describe('services manifest ⟷ .gitlab/ci/build.yml', () => {
  it('the SERVICE_NAME set matches the manifest exactly', () => {
    expect(sorted(jobsByServiceName.keys())).toEqual(sorted(services.map((s) => s.name)));
  });

  it('each service builds from the Dockerfile and target the manifest declares', () => {
    for (const service of services) {
      const entry = jobsByServiceName.get(service.name);
      if (!entry) continue; // covered by the set-equality test above

      // build-python-base overrides `script:` wholesale and passes its context
      // inline, so it declares no DOCKERFILE/BUILD_TARGET variables to compare.
      if (!/^\s+DOCKERFILE:/m.test(entry.block)) continue;

      const dockerfile = /^\s+DOCKERFILE:\s*(\S+)\s*$/m.exec(entry.block)?.[1];
      expect(dockerfile, `${service.name}: DOCKERFILE mismatch in job ${entry.job}`).toBe(service.dockerfile);

      const target = /^\s+BUILD_TARGET:\s*(\S+)\s*$/m.exec(entry.block)?.[1] ?? null;
      expect(target, `${service.name}: BUILD_TARGET mismatch in job ${entry.job}`).toBe(service.target);
    }
  });

  it('each service reacts to exactly the tag prefixes the manifest declares (plus ALL)', () => {
    for (const service of services) {
      const entry = jobsByServiceName.get(service.name);
      if (!entry) continue;

      const expected = sorted(new Set([...service.tagPrefixes, PLATFORM_TRAIN_PREFIX]));
      expect(sorted(tagPrefixesOf(entry.block)), `${service.name}: tag rules drifted in job ${entry.job}`).toEqual(
        expected,
      );
    }
  });
});

describe('services manifest ⟷ .gitlab/ci/promote.sh', () => {
  it('the promotable set matches SERVICES= exactly', () => {
    // Both directions matter. An entry in promote.sh with no build job warns
    // and continues; a promotable service missing from promote.sh is never
    // pinned into the overlay and silently keeps running the old digest.
    const promotable = services.filter((s) => s.promotable).map((s) => s.name);
    expect(sorted(promoteServices)).toEqual(sorted(promotable));
  });

  it('non-promotable services are build-time only', () => {
    for (const service of services.filter((s) => !s.promotable)) {
      expect(promoteServices, `${service.name} is marked non-promotable but appears in SERVICES=`).not.toContain(
        service.name,
      );
    }
  });
});
