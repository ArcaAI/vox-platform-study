-- Bootstrap the SYSTEM loopback allowed-origin rows.
--
-- WHY THIS IS A MIGRATION AND NOT SEED DATA
-- =========================================
-- Made three changes that compose into a lock-out:
--   (a) `origin.enforcementEnabled` now defaults TRUE (FR-6) — enforcement is
--       on in every environment, for every tenant, with no opt-in step;
--   (b) the `NODE_ENV === 'development'` loopback branch was deleted from
--       `apps/api/src/cors.config.ts` (FR-8 / B-7) — there is no code fallback
--       left, and re-adding one is explicitly forbidden by that file's header;
-- (c) had already deleted `CORS_ALLOWED_ORIGINS`, so no env
--       var can supply an allow-list either.
-- Meanwhile made seeding OPT-IN (`RUN_SEED`, default `none`). An
-- environment that skips the seed therefore refuses EVERY browser origin,
-- loopback included, recoverable only by direct database access.
--
-- The mitigation is NOT to make the seed run unconditionally: a
-- `SEED_PHASES_ALWAYS_ON` escape hatch would break 's "no DB connection
-- when `RUN_SEED` is unset" invariant and make `RUN_SEED=none` not mean none.
-- The correct precedent is already in this directory: the SYSTEM tenant row
-- itself is guaranteed by a MIGRATION
-- (`20260527000000_task_305_phase_a_drop_sentinel_default_and_scope_uniques`,
-- step 1 — a bare `INSERT ... ON CONFLICT (id) DO NOTHING`), not by the seed.
-- Bootstrap-critical rows belong in the schema history, which every
-- environment applies; demo/fixture rows belong in the seed, which many do not.
--
-- RELATIONSHIP TO THE SEED (`seed/11b-tenant-allowed-origins.ts`)
-- ==============================================================
-- The seed keeps its idempotent upserts over the SAME six loopback rows plus
-- the ArcaAI deployment rows. Division of labour:
--   • this migration GUARANTEES EXISTENCE (every environment, seed or no seed);
--   • the seed RECONCILES metadata (`label` / `description`) on re-run.
-- The two are byte-identical for `origin`, `tenantId`, `label` and
-- `description`, so whichever runs first, the other is a no-op on content.
-- `_metadata` is deliberately left NULL here because the seed's `create` leaves
-- it NULL — writing `'{}'::jsonb` would make the two paths produce different
-- rows for no reason.
--
-- `id` is the one field that legitimately differs by path: the seed omits it and
-- lets Prisma's `@default(uuid(7))` mint one, while SQL has no such default, so
-- the literals below are hand-allocated from a fresh `C0000000-…` block (see the
-- prefix table in `seed/00-constants.ts`). Ids are opaque and the GRANT key is
-- `(origin, tenantId)` — the composite unique index this statement conflicts on
-- — so a row created by the seed in a `db push`-managed database and the same
-- row created here in a `migrate deploy` database are the same grant with
-- different surrogate keys. Nothing joins to these ids.
--
-- WHICH ROWS, AND WHY SIX RATHER THAN TWO
-- =======================================
-- The deleted `development_loopback` branch called `isLoopbackHost()`
-- (`origin-normalizer.ts:96`), which admits `localhost` ∪ `127.0.0.0/8` ∪ `::1`
-- on EITHER scheme. Two seeded rows (`http://localhost:*`, `http://127.0.0.1:*`)
-- are narrower than that in two ways, both of which bite in practice:
--   • https — a local stack fronted by mkcert/self-signed TLS sends
--     `Origin: https://localhost:<port>`, which no http row matches (the pattern
--     grammar compares scheme EXACTLY — `origin-pattern.ts`, `parsePattern`);
--   • ::1 — a browser that resolves `localhost` to the IPv6 loopback sends
--     `Origin: http://[::1]:<port>`. `http://localhost:*` parses as a CONCRETE
--     host (`localhost` contains no `*`, so `parseHostPattern` returns
--     `wildcard: false, matchHost: 'localhost'`) and `matchesOriginPattern` then
--     requires `parsedOrigin.host === parsed.matchHost` exactly. `[::1]` is not
--     `localhost` and not `127.0.0.1`, so neither existing row matches it.
-- Every one of the four added values was run through `normalizeOriginPattern`
-- before being written here and round-trips UNCHANGED, i.e. each string below is
-- already the canonical stored form.
--
-- RESIDUAL GAP, stated rather than papered over: `isLoopbackHost` accepted the
-- whole of `127.0.0.0/8`, and `127.0.0.2`-`127.0.0.255` remain uncovered. The
-- pattern grammar cannot express them — a `*` is only ever the LEFTMOST host
-- label and its suffix must carry >= 2 labels and must not be IP-shaped
-- (`parseHostPattern` floors 1 and 2, plus the ALL_DIGITS rejection), so
-- `http://127.0.0.*` and `http://*.127.0.0.1:*` are both rejected by design. A
-- developer binding to an alternate loopback address must register that exact
-- origin as a row. This is a deliberate narrowing of the deleted branch, not an
-- oversight.
--
-- IDEMPOTENT and roll-forward only. `ON CONFLICT ("origin", "tenantId")` infers
-- the `TenantAllowedOrigin_origin_tenantId_unique` index (created by
-- `20260807000000_task_610_allowed_origin_many_to_many`); `DO NOTHING` means a
-- replay, a shadow-database run, or an environment that already seeded these
-- rows all leave existing data — including an operator's edits — untouched. No
-- row is ever updated or deleted here.

INSERT INTO "core"."TenantAllowedOrigin" (
  "id",
  "tenantId",
  "origin",
  "label",
  "description",
  "_version",
  "resourceStatus",
  "createdBy",
  "createdAt",
  "updatedAt"
)
VALUES
  (
    'C0000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'http://localhost:*',
    'Local development (any port)',
    'Loopback for SDK/playground/admin-console development. SYSTEM-owned so a developer can work against any tenant. `http` is permitted here and ONLY here — browsers treat loopback as a secure context.',
    1,
    'ENABLED',
    '60000000-0000-0000-0000-000000000000',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'C0000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'http://127.0.0.1:*',
    'Local development — loopback IP (any port)',
    'Loopback for SDK/playground/admin-console development via the literal 127.0.0.1 address (does not match the localhost hostname pattern above). SYSTEM-owned so a developer can work against any tenant. `http` is permitted here and ONLY here — browsers treat loopback as a secure context.',
    1,
    'ENABLED',
    '60000000-0000-0000-0000-000000000000',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'C0000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'https://localhost:*',
    'Local development — local TLS (any port)',
    'Loopback served over local TLS (mkcert/self-signed). The pattern grammar matches the scheme EXACTLY, so the http row does not cover an https local stack. Restores the https half of the loopback coverage the deleted NODE_ENV development_loopback branch had via isLoopbackHost.',
    1,
    'ENABLED',
    '60000000-0000-0000-0000-000000000000',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'C0000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'https://127.0.0.1:*',
    'Local development — loopback IP over local TLS (any port)',
    'Loopback IP literal served over local TLS (mkcert/self-signed). Scheme is matched exactly and 127.0.0.1 is a distinct host from localhost, so this needs its own row.',
    1,
    'ENABLED',
    '60000000-0000-0000-0000-000000000000',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'C0000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000000',
    'http://[::1]:*',
    'Local development — IPv6 loopback (any port)',
    'IPv6 loopback literal. A browser that resolves localhost to ::1 sends Origin: http://[::1]:<port>, which matches NEITHER http://localhost:* (concrete host localhost) NOR http://127.0.0.1:*. SYSTEM-owned so a developer can work against any tenant.',
    1,
    'ENABLED',
    '60000000-0000-0000-0000-000000000000',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'C0000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-000000000000',
    'https://[::1]:*',
    'Local development — IPv6 loopback over local TLS (any port)',
    'IPv6 loopback literal served over local TLS (mkcert/self-signed). Scheme is matched exactly, so the http row above does not cover it.',
    1,
    'ENABLED',
    '60000000-0000-0000-0000-000000000000',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("origin", "tenantId") DO NOTHING;
