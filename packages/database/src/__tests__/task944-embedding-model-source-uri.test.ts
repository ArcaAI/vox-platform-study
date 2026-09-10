/**
 * TASK-944 B2 — the built-in speaker-embedding row names the repo that is
 * actually PUBLISHED, and the repair migration says the same thing the seed does.
 *
 * The defect, measured in-pod on `hope-v2-dev` (pipeline #1169): the weights are
 * published and the mount is wired correctly —
 * `HF_HOME=/mnt/models-bucket/hf`, `HF_HUB_CACHE=/mnt/models-bucket/hf/hub`,
 * `HF_HUB_OFFLINE=1`, and `/mnt/models-bucket/hf/hub/models--pyannote--wespeaker-voxceleb-resnet34-LM`
 * exists — but the load asked for something the cache does not contain and spent
 * ~16.6 s of the cold start failing.
 *
 * THE DECISION THIS FILE ENCODES: the hub repo id is **DATA on the `AiModel`
 * row**, never a slug -> repo map inside a loader.
 *
 *  - `09-infrastructure-devops.md` §"No hardcoded configuration": a model id is
 *    configuration and never a literal in application code. A `built-in` slug
 *    table in `apps/stt` would be exactly "a constant with a real default
 *    wearing a config costume".
 *  - The column already exists and is already plumbed end to end —
 *    `AiModel.sourceUri` -> `ResolvedAgentModel.sourceUri` ->
 *    `AsrSpecModel.sourceUri` -> `AiModelConfig.source_uri` ->
 *    `resolve_weights_or_hf_id`. Nothing is missing; one row holds a wrong
 *    value. A resolution map would add a SECOND statement of the same fact,
 *    which is the drift this rule exists to prevent.
 *  - `provider = 'built-in'` is a catalogue LABEL, not a resolution tier. Every
 *    other HuggingFace row resolves through `sourceUri`; a map for built-in rows
 *    alone would make this one row resolve unlike its siblings.
 *
 * Text-level pins only — no database, no Prisma client — in the idiom of
 * `global-setting-tenant-key-migration.test.ts` in this directory.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODELS } from '../prisma/db_main/seed/06-ai-models';
import { AiModelSource } from '../prisma/db_main/seed/ai-models/shared';

/** The row the SYSTEM ASR template binds for diarization (`seed/25-agents.ts`). */
const EMBEDDING_SLUG = 'wespeaker-voxceleb-resnet34';

/** The repo whose snapshot IS in the models bucket, verified in-pod 2026-09-10. */
const PUBLISHED_REPO = 'pyannote/wespeaker-voxceleb-resnet34-LM';

/** What `huggingface_hub` calls that repo's directory under `HF_HUB_CACHE`. */
const PUBLISHED_CACHE_DIR = 'models--pyannote--wespeaker-voxceleb-resnet34-LM';

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../prisma/db_main/migrations/20260910190000_task_944_wespeaker_embedding_source_uri/migration.sql'),
  'utf8',
);

const bySlug = (slug: string) => DEFAULT_AI_MODELS.find((m) => m.slug === slug);

/** `huggingface_hub`'s repo -> cache-directory rule. */
const cacheDirFor = (repoId: string) => `models--${repoId.replace(/\//g, '--')}`;

describe('TASK-944 B2: the built-in embedding row resolves to the published repo', () => {
  it('pins the seeded `sourceUri` to the repo the cache actually holds', () => {
    const row = bySlug(EMBEDDING_SLUG);
    expect(row, `${EMBEDDING_SLUG} must be in the catalogue`).toBeDefined();
    expect(row!.source).toBe(AiModelSource.HUGGINGFACE);
    expect(row!.sourceUri).toBe(PUBLISHED_REPO);
    // The pin that would actually have caught this: the id has to name the
    // directory on the mount, not merely look plausible.
    expect(cacheDirFor(row!.sourceUri)).toBe(PUBLISHED_CACHE_DIR);
  });

  it('never lets a HuggingFace row locate itself by its own bare slug', () => {
    // The observed failure mode generalised: a `sourceUri` that is not an
    // `<org>/<repo>` hub id matches neither the Hub nor any cached directory,
    // and `HF_HUB_OFFLINE=1` turns that into a ~16 s failed load rather than a
    // fast, legible error.
    const hubRows = DEFAULT_AI_MODELS.filter((m) => m.source === AiModelSource.HUGGINGFACE);
    expect(hubRows.length).toBeGreaterThan(0);
    hubRows.forEach((m) => {
      const id = m.sourceUri.startsWith('hf:') ? m.sourceUri.slice('hf:'.length) : m.sourceUri;
      expect(id, m.slug).not.toBe(m.slug);
      expect(id, m.slug).toMatch(/^[^/\s]+\/[^/\s]+$/);
    });
  });
});

describe('TASK-944 B2: the repair migration that reaches an already-seeded database', () => {
  it('writes exactly the value the seed declares — one fact, stated twice, pinned together', () => {
    const seeded = bySlug(EMBEDDING_SLUG)!.sourceUri;
    expect(MIGRATION_SQL).toContain(`SET "sourceUri" = '${seeded}'`);
    expect(MIGRATION_SQL).toContain(`WHERE "slug" = '${EMBEDDING_SLUG}'`);
  });

  it('is guarded so re-running it is a no-op', () => {
    // `prisma migrate deploy` applies a migration once, but the same SQL is
    // also the operator's hand-runnable repair; an unguarded UPDATE would
    // rewrite a value someone had already corrected.
    expect(MIGRATION_SQL).toMatch(/AND\s+"sourceUri"\s+IS DISTINCT FROM\s+'pyannote\/wespeaker-voxceleb-resnet34-LM'/);
  });

  it('changes DATA only — no schema statement, no hard delete', () => {
    const statements = MIGRATION_SQL.split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i);
    expect(statements).not.toMatch(/\b(DELETE|TRUNCATE)\b/i);
  });
});
