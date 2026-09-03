-- ============================================================================
-- TASK-844 — dev-DB backfill (run BY HAND, by the orchestrator)
--
-- WHY THIS FILE EXISTS
--
-- The local dev database is `db push`-managed and carries NO
-- `_prisma_migrations` ledger, so the TASK-844 migration is never APPLIED to
-- it — `pnpm db:push` only reconciles the SCHEMA. `db push` will therefore:
--
--   * add the new columns and the two foreign keys;                    ✅
--   * NOT create the partial unique index (Prisma's DSL cannot express one); ❌
--   * NOT move a single `AiTaskDefault` row into `AiRoutingPolicy`.         ❌
--
-- Without this file the dev DB ends up with the new shape, an unenforced
-- election, and an EMPTY authoritative table — which looks like a successful
-- migration and is not one.
--
-- Same precedent and same reason as TASK-843's `backfill-dev-db.sql`.
--
-- HOW TO RUN IT (orchestrator, after `pnpm db:push`)
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f docs/implementation/TASK-844-AiRoutingPolicy-Absorption/backfill-dev-db.sql
--
-- IDEMPOTENT. The index creation is `IF NOT EXISTS` and the insert is guarded
-- by `NOT EXISTS (tenantId, taskKey)`, so a second run changes nothing and an
-- environment that already carries a hand-authored routing row is never
-- clobbered.
--
-- VERIFY AFTERWARDS — every one of these must hold:
--
--   SELECT count(*) FROM core."AiTaskDefault";                        -- 12
--   SELECT count(*) FROM core."AiRoutingPolicy" WHERE "isDefault";    -- 12
--   SELECT count(*) FROM core."AiRoutingPolicy" WHERE "modelId" IS NULL; -- 0
--
-- The statements below are BYTE-FOR-BYTE the data half of
-- `migrations/20260901061912_task_844_ai_routing_policy_absorption/migration.sql`,
-- with `CREATE UNIQUE INDEX` made `IF NOT EXISTS` so a re-run is safe. Any
-- environment that DOES have a ledger gets them through the migration instead —
-- never run both.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "AiRoutingPolicy_tenant_task_default_unique"
ON "core"."AiRoutingPolicy" ("tenantId", "taskKey")
WHERE "isDefault" = true AND "resourceStatus" != 'DELETED';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. THE ABSORPTION — every `AiTaskDefault` row becomes an elected default.
--
-- DATA-PRESERVING BY CONSTRUCTION. Nothing is dropped, nothing is rewritten in
-- place, and the source table is left intact (see the RETIRED banner on
-- `ai-task-default.prisma` for the staged removal). The five GGUF SYSTEM
-- selections that drive day-1 inference on LM Studio are among the rows copied
-- here, so this statement is the one that must not be wrong.
--
-- IDEMPOTENT: the `NOT EXISTS` guard keys on (tenantId, taskKey), so a re-run
-- inserts nothing and an environment that already carries a hand-authored
-- routing row for a selection is never clobbered.
--
-- FIELD-BY-FIELD, and why:
--
--   id            `uuidv7()` — native on PostgreSQL 18, matching the house
--                 `@default(uuid(7))` convention. NOT `gen_random_uuid()`,
--                 which is v4 and would break id ordering.
--   modelId       resolved from `AiTaskDefault.modelSlug` through `AiModel.slug`
--                 on the TWO-TIER cascade: the row's own tenant first, SYSTEM
--                 only on absence. This is precisely the string join finding
--                 F-6 named, executed ONCE here so that from now on it is a
--                 foreign key. NULL when the slug resolves to nothing — which
--                 is a real finding about the data, not a silent default.
--   providerConn- resolved from the selected model's `provider` through
--   ectionId      `AiProviderConnection (service='llm', provider=…)`, same
--                 two-tier cascade. Expected to be NULL for the `nlp.*` and
--                 `guardrail.*` selections: those models run IN-PROCESS inside
--                 `apps/nlp` and are not served through a provider connection
--                 at all. A NULL here is the truth about that selection, and
--                 selection stays fail-closed rather than substituting one.
--   isDefault     TRUE. An `AiTaskDefault` row WAS the default, by definition —
--                 that is the whole content of finding F-7.
--   status        ACTIVE + `activatedAt` stamped. A migrated row must SERVE
--                 immediately; landing it as DRAFT would silently stop day-1
--                 inference the moment the resolver switched over.
--   resourceStatus COPIED, never reset. `apps/guardrail` treats a tenant's
--                 DISABLED row as a VETO (not a fall-through to SYSTEM), so
--                 resetting it to ENABLED would silently re-enable a selection
--                 a tenant deliberately switched off.
--   configJson    copied verbatim (task-specific thresholds).
--   residency /   left NULL: `AiTaskDefault` never carried them, and inventing
--   baaCovered    a residency class or asserting BAA coverage nobody declared
--                 is exactly the silent PHI redirection the §3A.4 gates exist
--                 to prevent. They gate fallback HOPS, and a migrated row has
--                 no chain, so nothing regresses.
--   candidatesJson NULL — deprecated by this ticket; the chain is now the set
--                 of rows, ordered by `priority`.
--   createdBy /   carried across so the audit trail survives the move.
--   createdAt
--   _metadata     provenance, so any row here can be traced back to the
--                 `AiTaskDefault` it came from without consulting this file.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO "core"."AiRoutingPolicy" (
    "id", "_metadata", "_version",
    "tenantId", "taskKey", "taskKind",
    "displayName", "providerConnectionId", "modelId", "modelRef",
    "isDefault", "enabled", "residency", "baaCovered", "configJson",
    "policyVersion", "status", "strategy", "explicitProviderMode",
    "priority", "killSwitch", "candidatesJson", "activatedAt",
    "resourceStatus", "resourceStatusUpdatedAt", "resourceStatusUpdatedBy",
    "createdBy", "updatedBy", "createdAt", "updatedAt"
)
SELECT
    uuidv7(),
    jsonb_build_object(
        'absorbedFrom', 'AiTaskDefault',
        'absorbedFromId', d."id",
        'absorbedModelSlug', d."modelSlug",
        'absorbedBy', 'TASK-844',
        'ownerDecision', 'OD-3'
    ),
    1,
    d."tenantId",
    d."taskKey",
    -- ⚠ COALESCE, not a straight copy — and this is a real defect being repaired,
    -- not belt-and-braces. TASK-843 added `AiTaskDefault.taskKind` and backfilled
    -- the DEV DB through a side-car `backfill-dev-db.sql`, but neither
    -- `seedAiTaskDefault` (seed/16-ai-task-default.ts) nor
    -- `AiTaskDefaultService.upsertRow` was taught to WRITE the column. So on a
    -- freshly seeded database all 12 rows carry `taskKind = NULL`, and a straight
    -- copy would faithfully propagate 12 unclassified rows into the table that is
    -- now the source of truth. Verified on a ledger-replayed + seeded shadow DB
    -- (TASK-844 §Verification: "taskKind came out NULL for all 12").
    --
    -- The CASE below is CHARACTER-FOR-CHARACTER the arm list of the TASK-843
    -- migration's own backfill, which `ai-task-kind.test.ts` reads and fails on
    -- drift against `AI_TASK_KIND_BY_TASK_KEY`. Keeping it identical means the
    -- mapping is still declared exactly once and still pinned by that test.
    -- `ELSE NULL` is deliberate and fail-closed: an unrecognised key stays
    -- unclassified rather than being guessed into a plausible-but-wrong kind.
    COALESCE(
        d."taskKind",
        (CASE
            WHEN d."taskKey" IN ('text.live', 'text.finalize', 'text.live.fallback', 'text.finalize.fallback', 'text.test', 'harness.judge') THEN 'TEXT_GENERATION'
            WHEN d."taskKey" = 'vlm.extract' THEN 'VISION_EXTRACTION'
            WHEN d."taskKey" = 'nlp.ner' THEN 'NAMED_ENTITY_RECOGNITION'
            WHEN d."taskKey" IN ('nlp.classification', 'nlp.diagnosis', 'nlp.sentiment', 'nlp.toxicity', 'nlp.topic', 'nlp.intent') THEN 'TEXT_CLASSIFICATION'
            WHEN d."taskKey" IN ('guardrail.validate', 'guardrail.safety') THEN 'CONTENT_SAFETY'
            WHEN d."taskKey" = 'guardrail.groundedness' THEN 'GROUNDEDNESS'
            WHEN d."taskKey" IN ('guardrail.pii', 'guardrail.pii.spans') THEN 'PII_DETECTION'
            ELSE NULL
        END)::"core"."AiTaskKind"
    ),
    d."modelSlug",
    conn."id",
    m."id",
    NULL,
    true,
    true,
    NULL,
    NULL,
    d."configJson",
    1,
    'ACTIVE'::"core"."AiRoutingPolicyStatus",
    'PRIORITY'::"core"."AiRoutingStrategy",
    'STRICT'::"core"."AiExplicitProviderMode",
    0,
    false,
    NULL,
    CURRENT_TIMESTAMP,
    d."resourceStatus",
    d."resourceStatusUpdatedAt",
    d."resourceStatusUpdatedBy",
    d."createdBy",
    d."updatedBy",
    d."createdAt",
    CURRENT_TIMESTAMP
FROM "core"."AiTaskDefault" d
-- Two-tier catalogue resolution: the row's own tenant wins, SYSTEM on absence.
-- LATERAL + LIMIT 1 rather than a join, so a tenant-owned slug can never
-- multiply the row against its SYSTEM namesake.
LEFT JOIN LATERAL (
    SELECT am."id", am."provider"
    FROM "core"."AiModel" am
    WHERE am."slug" = d."modelSlug"
      AND am."tenantId" IN (d."tenantId", '00000000-0000-0000-0000-000000000000')
      AND am."resourceStatus" != 'DELETED'
    ORDER BY (am."tenantId" = d."tenantId") DESC
    LIMIT 1
) m ON true
LEFT JOIN LATERAL (
    SELECT ac."id"
    FROM "core"."AiProviderConnection" ac
    WHERE ac."service" = 'llm'
      AND ac."provider" = m."provider"
      AND ac."tenantId" IN (d."tenantId", '00000000-0000-0000-0000-000000000000')
      AND ac."resourceStatus" != 'DELETED'
    ORDER BY (ac."tenantId" = d."tenantId") DESC
    LIMIT 1
) conn ON true
WHERE d."resourceStatus" != 'DELETED'
  AND NOT EXISTS (
    SELECT 1 FROM "core"."AiRoutingPolicy" p
    WHERE p."tenantId" = d."tenantId"
      AND p."taskKey" = d."taskKey"
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 3. REPAIR the retired projection's own `taskKind`, with the SAME mapping.
--
-- TASK-843 backfilled `AiTaskDefault.taskKind` on the dev DB through a side-car
-- `backfill-dev-db.sql`, but left `seedAiTaskDefault` and
-- `AiTaskDefaultService.upsertRow` unable to WRITE the column — so any
-- environment seeded after that ticket carries 12 unclassified rows. TASK-844
-- teaches both writers to set it; this repairs the rows they already wrote.
--
-- It runs AFTER the absorption on purpose: step 2 is the statement that must
-- not be wrong, and it no longer depends on this one having succeeded (it
-- derives its own value). This is housekeeping on a retired table.
-- ────────────────────────────────────────────────────────────────────────────
UPDATE "core"."AiTaskDefault"
SET "taskKind" = (CASE
        WHEN "taskKey" IN ('text.live', 'text.finalize', 'text.live.fallback', 'text.finalize.fallback', 'text.test', 'harness.judge') THEN 'TEXT_GENERATION'
        WHEN "taskKey" = 'vlm.extract' THEN 'VISION_EXTRACTION'
        WHEN "taskKey" = 'nlp.ner' THEN 'NAMED_ENTITY_RECOGNITION'
        WHEN "taskKey" IN ('nlp.classification', 'nlp.diagnosis', 'nlp.sentiment', 'nlp.toxicity', 'nlp.topic', 'nlp.intent') THEN 'TEXT_CLASSIFICATION'
        WHEN "taskKey" IN ('guardrail.validate', 'guardrail.safety') THEN 'CONTENT_SAFETY'
        WHEN "taskKey" = 'guardrail.groundedness' THEN 'GROUNDEDNESS'
        WHEN "taskKey" IN ('guardrail.pii', 'guardrail.pii.spans') THEN 'PII_DETECTION'
        ELSE NULL
    END)::"core"."AiTaskKind"
WHERE "taskKind" IS NULL;
