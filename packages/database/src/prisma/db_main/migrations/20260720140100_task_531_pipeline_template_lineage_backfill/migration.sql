-- TASK-531 — Backfill template lineage onto existing tenant pipeline copies.
--
-- Companion to `…_task_531_pipeline_template_lineage`, which added the columns.
-- This migration is DATA-ONLY: it decides which pre-existing tenant rows are
-- pristine template copies and locks exactly those.
--
-- ============================ THE MISLABELING RISK ==========================
--
-- Slug matching ALONE is not enough. Every tenant received a copy of each
-- SYSTEM template under the template's own slug, and a tenant admin has been
-- free to edit that copy ever since (nothing stopped them before this ticket).
-- Locking on slug alone would freeze a pipeline a customer has already
-- customized, and the resync reconciler would later fast-forward it back to the
-- SYSTEM YAML — destroying their work.
--
-- So a row is locked only when BOTH predicates hold (README §3.3):
--
--   (a) its `slug` is one of the 9 SYSTEM template slugs, and it is not itself
--       a SYSTEM row; AND
--   (b) its `configYaml` still byte-equals the config it was cloned WITH:
--         · primary  — the row's v1 `AsrPipelineVersion` snapshot, which
--                      tenant provisioning writes at clone time; or
--         · fallback — when the row has no version rows at all, the SYSTEM
--                      row's CURRENT `configYaml` for the same slug. Seeded
--                      tenant catalogs land in this branch: `seedAsrPipelines`
--                      creates pipeline rows but writes NO version rows, and
--                      it shares the very same `PIPELINE_CONFIGS` constants
--                      with the SYSTEM rows, so a pristine seeded copy matches
--                      exactly.
--
-- Anything else — a row whose YAML matches neither its own v1 snapshot nor the
-- SYSTEM current config — is AMBIGUOUS. It is left UNLOCKED and reported via
-- RAISE NOTICE for operator review. Unlocked-but-pristine is the safe failure
-- direction: resync simply skips it (it only ever fast-forwards locked rows).
-- Locked-but-customized is the unsafe one, and this predicate avoids it.
--
-- `sourceTemplateSlug` (provenance) is set on EVERY slug-matched tenant row,
-- including the ambiguous/customized ones. Lineage alone confers no lock, and
-- recording it is exactly what lets an operator answer "which tenants diverged
-- from template X, and how" (README §3.5).
--
-- The 9 slugs are inlined below because a migration cannot import TypeScript.
-- `task-531-pipeline-template-lineage-migration.test.ts` is the drift gate: it
-- asserts this list set-equals the exported `ASR_TEMPLATE_SLUGS` seed constant.
--
-- Idempotent: re-running only ever considers rows still lacking lineage/lock.

DO $$
DECLARE
    -- Mirrors `ASR_TEMPLATE_SLUGS` in seed/06-stt.ts (test-enforced).
    template_slugs CONSTANT TEXT[] := ARRAY[
        'production-whisper-large-v3',
        'turbo-whisper-large-v3',
        'production-whisper-large-v3-turbo-gguf',
        'production-faster-whisper-turbo-int8',
        'whisper-turbo-no-postprocessing',
        'whisper-turbo-no-preprocessing',
        'azure-speech-transcription',
        'azure-foundry-mai-transcribe',
        'parakeet-nemotron-streaming'
    ];
    system_tenant CONSTANT TEXT := '00000000-0000-0000-0000-000000000000';
    provenance_count INTEGER;
    locked_count INTEGER;
    ambiguous_row RECORD;
    ambiguous_count INTEGER := 0;
BEGIN
    -- ---------------------------------------------------------------------
    -- 1. Provenance on every slug-matched tenant row (no lock implied).
    -- ---------------------------------------------------------------------
    UPDATE "core"."AsrPipeline" p
       SET "sourceTemplateSlug" = p."slug"
     WHERE p."slug" = ANY(template_slugs)
       AND p."tenantId" <> system_tenant
       AND p."sourceTemplateSlug" IS NULL
       AND p."resourceStatus" <> 'DELETED';

    GET DIAGNOSTICS provenance_count = ROW_COUNT;

    -- ---------------------------------------------------------------------
    -- 2. Lock ONLY the pristine copies (predicate (a) AND (b)).
    -- ---------------------------------------------------------------------
    WITH clone_time AS (
        -- The v1 snapshot: the earliest version row per pipeline.
        SELECT DISTINCT ON (v."asrPipelineId")
               v."asrPipelineId" AS pipeline_id,
               v."configYaml"    AS config_yaml
          FROM "core"."AsrPipelineVersion" v
         ORDER BY v."asrPipelineId", v."versionNumber" ASC
    ),
    system_current AS (
        SELECT s."slug" AS slug, s."configYaml" AS config_yaml
          FROM "core"."AsrPipeline" s
         WHERE s."tenantId" = system_tenant
           AND s."resourceStatus" <> 'DELETED'
    ),
    pristine AS (
        SELECT p."id"
          FROM "core"."AsrPipeline" p
          LEFT JOIN clone_time ct ON ct.pipeline_id = p."id"
          LEFT JOIN system_current sc ON sc.slug = p."slug"
         WHERE p."slug" = ANY(template_slugs)
           AND p."tenantId" <> system_tenant
           AND p."resourceStatus" <> 'DELETED'
           AND p."templateLocked" = false
           AND (
                 -- primary: unchanged since its clone-time v1 snapshot
                 (ct.config_yaml IS NOT NULL AND p."configYaml" = ct.config_yaml)
                 -- fallback: no version history, but identical to SYSTEM today
              OR (ct.config_yaml IS NULL AND sc.config_yaml IS NOT NULL
                  AND p."configYaml" = sc.config_yaml)
               )
    )
    UPDATE "core"."AsrPipeline" p
       SET "templateLocked" = true
      FROM pristine
     WHERE p."id" = pristine."id";

    GET DIAGNOSTICS locked_count = ROW_COUNT;

    -- ---------------------------------------------------------------------
    -- 3. Report the ambiguous rows — slug-matched but NOT provably pristine.
    --    These stay unlocked and editable; an operator decides case by case.
    -- ---------------------------------------------------------------------
    FOR ambiguous_row IN
        WITH clone_time AS (
            SELECT DISTINCT ON (v."asrPipelineId")
                   v."asrPipelineId" AS pipeline_id,
                   v."configYaml"    AS config_yaml
              FROM "core"."AsrPipelineVersion" v
             ORDER BY v."asrPipelineId", v."versionNumber" ASC
        ),
        system_current AS (
            SELECT s."slug" AS slug, s."configYaml" AS config_yaml
              FROM "core"."AsrPipeline" s
             WHERE s."tenantId" = system_tenant
               AND s."resourceStatus" <> 'DELETED'
        )
        SELECT p."id", p."tenantId", p."slug",
               (ct.config_yaml IS NOT NULL) AS has_snapshot
          FROM "core"."AsrPipeline" p
          LEFT JOIN clone_time ct ON ct.pipeline_id = p."id"
          LEFT JOIN system_current sc ON sc.slug = p."slug"
         WHERE p."slug" = ANY(template_slugs)
           AND p."tenantId" <> system_tenant
           AND p."resourceStatus" <> 'DELETED'
           AND p."templateLocked" = false
    LOOP
        ambiguous_count := ambiguous_count + 1;
        RAISE NOTICE
            'TASK-531 backfill: pipeline % (tenant %, slug %) left UNLOCKED — config differs from its % ; review manually.',
            ambiguous_row."id",
            ambiguous_row."tenantId",
            ambiguous_row."slug",
            CASE WHEN ambiguous_row.has_snapshot
                 THEN 'clone-time v1 snapshot'
                 ELSE 'SYSTEM template config (no version history)'
            END;
    END LOOP;

    RAISE NOTICE 'TASK-531 backfill complete: % rows given provenance, % locked as pristine template copies, % left unlocked for review.',
        provenance_count, locked_count, ambiguous_count;
END $$;
