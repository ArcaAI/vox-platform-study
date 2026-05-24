-- TASK-302 Phase 5 Task 5.1 (Stream B) — Vault DB-Engine bootstrap.
--
-- ⚠ MANUAL SQL — NOT A PRISMA MIGRATION ⚠
-- Run ONCE per environment as the PostgreSQL superuser (e.g. `postgres`)
-- BEFORE configuring Vault's `database/config/hope-main`. The script
-- creates the two roles Vault needs:
--
--   1. `vault_admin` — the connection role Vault uses to mint dynamic
--      app users. Holds `CREATEROLE` so it can CREATE/DROP child users.
--      MUST be granted to `hope_app_template` for INHERIT to delegate
--      privileges (PG ≥ 16 requires the parent role to be a member of
--      the child to delegate; see footnote).
--
--   2. `hope_app_template` — a NOLOGIN template role; Vault clones its
--      privilege set into each short-lived user via
--      `INHERIT IN ROLE hope_app_template`. The template's grants are
--      the ONLY app-side privilege surface — keep it tight.
--
-- Why a manual step (not a Prisma migration):
--   - These are SUPERUSER ops (CREATE ROLE, GRANT … ON DATABASE).
--   - Prisma Migrate would attempt to revert on rollback, which is
--     dangerous for production role state.
--   - The SRE runbook (research/deployments/deploy-vm430-432-vault.md
--     section 15) references this script during environment bootstrap.
--
-- Idempotency:
--   The DO-block guards every CREATE so the script can be re-run
--   safely on a partially-bootstrapped cluster.
--
-- ⚠ The placeholder `<RUNTIME>` below is replaced by the SRE when
-- pasting into psql; the value is then passed to Vault via
--   `vault write database/config/hope-main … password=<value>`.
-- Never commit a populated copy of this file.

\set ON_ERROR_STOP 1

BEGIN;

DO $do$
BEGIN
  -- 1. vault_admin (Vault's connection role)
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'vault_admin') THEN
    EXECUTE format(
      'CREATE ROLE vault_admin LOGIN PASSWORD %L',
      :'vault_admin_password'
    );
  END IF;

  ALTER ROLE vault_admin WITH CREATEROLE;

  -- 2. hope_app_template (privilege carrier for dynamic users)
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hope_app_template') THEN
    CREATE ROLE hope_app_template NOLOGIN;
  END IF;
END
$do$;

-- 3. Grants on the database. Outside the DO block because GRANT is
--    not allowed inside a function in some PG versions.
GRANT CONNECT ON DATABASE hope_main TO vault_admin;
GRANT CONNECT ON DATABASE hope_main TO hope_app_template;

-- 4. Schema usage. The application reads/writes in `core` and `audit`.
--    `public` is granted to vault_admin so it can introspect on connect.
GRANT USAGE ON SCHEMA core, audit, public TO vault_admin;
GRANT USAGE ON SCHEMA core, audit TO hope_app_template;

-- 5. Table/sequence privileges for the template (and the dynamic
--    children it spawns via INHERIT IN ROLE).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, audit TO hope_app_template;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, audit TO hope_app_template;

-- 6. Default privileges so future Prisma migrations carry the same
--    grants to newly-created tables/sequences automatically. WITHOUT
--    this, a fresh `prisma migrate deploy` would create a table the
--    template (and therefore every dynamic user) cannot read.
ALTER DEFAULT PRIVILEGES IN SCHEMA core, audit
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hope_app_template;
ALTER DEFAULT PRIVILEGES IN SCHEMA core, audit
  GRANT USAGE, SELECT ON SEQUENCES TO hope_app_template;

-- 7. PG 16+ delegation requirement.
--    Vault's CREATE ROLE … INHERIT IN ROLE hope_app_template needs
--    vault_admin to be a member of hope_app_template; otherwise the
--    GRANT INHERIT fails with "must be a member of role" since PG 16.
GRANT hope_app_template TO vault_admin WITH ADMIN OPTION;

COMMIT;

-- Verification (operator runs these manually):
--   \du vault_admin       -- should show LOGIN, CREATEROLE, Member of: hope_app_template
--   \du hope_app_template -- should show Cannot login
--
-- After committing, configure Vault from the dev-init.sh script (Task
-- 5.2) or the production runbook (section 15 of the SRE blueprint).
