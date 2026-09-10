/**
 * TASK-944 — the built-in speaker-embedding row names the repo that is
 * actually PUBLISHED, and no HuggingFace row locates itself by a bare slug.
 *
 * ## What these pins are, and what they are NOT
 *
 * They were written for a diagnosis that turned out to be WRONG. The premise was
 * that `AiModel.sourceUri` for `wespeaker-voxceleb-resnet34` was stale, so a
 * repair migration was authored alongside them. Verified in-pod on `hope-v2-dev`
 * 2026-09-10, that is false: the seed has declared
 * `pyannote/wespeaker-voxceleb-resnet34-LM` since TASK-860 and the LIVE row
 * already holds exactly that. The migration was a guarded no-op and has been
 * dropped rather than added to the ledger for a defect that does not exist.
 *
 * The REAL cause of the failing warm is a LOADER mismatch, tracked as B2 in the
 * ticket: the published snapshot is a pyannote.audio checkpoint
 * (`config.yaml` with `_target_: pyannote.audio.models.embedding.WeSpeakerResNet34`,
 * plus `pytorch_model.bin`, and NO `config.json`), while `HuggingFaceLoader`
 * drives `transformers.from_pretrained`, which requires `config.json`. Under
 * `HF_HUB_OFFLINE=1` transformers reports that as "couldn't connect ... and
 * couldn't find them in the cached files" — a message that reads identically to
 * a missing model, which is precisely what made the wrong diagnosis plausible.
 *
 * These two pins survive that correction because they are true and load-bearing
 * either way: whatever loads the checkpoint still has to be pointed at the repo
 * the bucket actually holds.
 *
 * Text-level pins only — no database, no Prisma client — in the idiom of
 * `global-setting-tenant-key-migration.test.ts` in this directory.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODELS } from '../prisma/db_main/seed/06-ai-models';
import { AiModelSource } from '../prisma/db_main/seed/ai-models/shared';

/** The row the SYSTEM ASR template binds for diarization (`seed/25-agents.ts`). */
const EMBEDDING_SLUG = 'wespeaker-voxceleb-resnet34';

/** The repo whose snapshot IS in the models bucket, verified in-pod 2026-09-10. */
const PUBLISHED_REPO = 'pyannote/wespeaker-voxceleb-resnet34-LM';

/** What `huggingface_hub` calls that repo's directory under `HF_HUB_CACHE`. */
const PUBLISHED_CACHE_DIR = 'models--pyannote--wespeaker-voxceleb-resnet34-LM';

const bySlug = (slug: string) => DEFAULT_AI_MODELS.find((m) => m.slug === slug);

/** `huggingface_hub`'s repo -> cache-directory rule. */
const cacheDirFor = (repoId: string) => `models--${repoId.replace(/\//g, '--')}`;

describe('TASK-944: the built-in embedding row resolves to the published repo', () => {
  it('pins the seeded `sourceUri` to the repo the cache actually holds', () => {
    const model = bySlug(EMBEDDING_SLUG);
    expect(model, `${EMBEDDING_SLUG} must exist in the seeded catalogue`).toBeDefined();
    expect(model?.source).toBe(AiModelSource.HUGGINGFACE);
    expect(model?.sourceUri).toBe(PUBLISHED_REPO);
    // The pin that would have caught the original confusion: the id must derive
    // the directory that is genuinely on the mount, not merely look plausible.
    expect(cacheDirFor(model?.sourceUri ?? '')).toBe(PUBLISHED_CACHE_DIR);
  });

  it('never lets a HuggingFace row locate itself by its own bare slug', () => {
    const offenders = DEFAULT_AI_MODELS.filter(
      (m) =>
        m.source === AiModelSource.HUGGINGFACE &&
        typeof m.sourceUri === 'string' &&
        // a hub id is `<org>/<repo>`; a bare slug (or anything without exactly
        // one slash) cannot resolve on the hub OR in an offline cache
        (m.sourceUri === m.slug || m.sourceUri.split('/').length !== 2),
    ).map((m) => `${m.slug} -> ${String(m.sourceUri)}`);

    expect(offenders, 'every HuggingFace-source model must carry an <org>/<repo> hub id').toEqual([]);
  });
});
