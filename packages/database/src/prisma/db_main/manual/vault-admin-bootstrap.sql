-- Vault DB-Engine bootstrap.
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
-- Invocation (pass the password + optional db name as psql variables —
-- never inline them into a committed copy of this file):
--   psql -v vault_admin_password='<runtime-secret>' \
--        -v db_name='hope_main' \        -- omit to accept the hope_main default
--        -d <db_name> -f vault-admin-bootstrap.sql
-- Local dev runs this automatically via scripts/setup-dev-vault-db.sh with
-- db_name=hope. The same password is then handed to Vault via
--   `vault write database/config/hope-main … password=<value>`.
-- Never commit a populated copy of this file.

\set ON_ERROR_STOP 1

-- The target database name is parameterized. It defaults
-- to `hope_main` (production) but callers override it with
-- `-v db_name=<db>`; the local-dev database is `hope`. Requires psql >= 11
-- for the :{?var} "is-defined" test.
\if :{?db_name}
\else
  \set db_name hope_main
\endif

BEGIN;

-- 1. vault_admin (Vault's connection role) — created idempotently.
--    NOTE: the password is interpolated here, OUTSIDE any dollar-quoted
--    block. psql deliberately does NOT substitute :'vars' inside $$...$$
--    bodies (so plpgsql `:=` etc. survive), so the earlier DO-block form
--    raised `syntax error at or near ":"`. The SELECT … \gexec pattern keeps
--    idempotency (zero rows when the role already exists → nothing executed).
SELECT format('CREATE ROLE vault_admin LOGIN PASSWORD %L', :'vault_admin_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'vault_admin')
\gexec

ALTER ROLE vault_admin WITH CREATEROLE;

-- 2. hope_app_template (privilege carrier for dynamic users; NOLOGIN)
SELECT 'CREATE ROLE hope_app_template NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hope_app_template')
\gexec

-- 3. Grants on the database. Outside the DO block because GRANT is
--    not allowed inside a function in some PG versions.
GRANT CONNECT ON DATABASE :"db_name" TO vault_admin;
GRANT CONNECT ON DATABASE :"db_name" TO hope_app_template;

-- 4. Schema usage. The application reads/writes in `core`; `public` is
--    granted to vault_admin so it can introspect on connect. The `audit`
--    schema is OPTIONAL (granted conditionally in step 6b) — local dev
--    ships only `core`, production may add a dedicated audit schema.
GRANT USAGE ON SCHEMA core, public TO vault_admin;
GRANT USAGE ON SCHEMA core TO hope_app_template;

-- 5. Table/sequence privileges for the template (and the dynamic
--    children it spawns via INHERIT IN ROLE).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO hope_app_template;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO hope_app_template;

-- 6. Default privileges so future Prisma migrations carry the same
--    grants to newly-created tables/sequences automatically. WITHOUT
--    this, a fresh `prisma migrate deploy` would create a table the
--    template (and therefore every dynamic user) cannot read.
ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hope_app_template;
ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT USAGE, SELECT ON SEQUENCES TO hope_app_template;

-- 6b. — audit schema is environment-optional. Apply the
--     same privilege set ONLY when an `audit` schema exists, so this
--     script is correct whether the target DB carves audit tables into
--     a dedicated schema (some production layouts) or keeps everything
--     in `core` (local dev). GRANT/ALTER run via EXECUTE because plain
--     GRANT is disallowed in a plpgsql block body on older servers.
DO $audit$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'audit') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA audit TO vault_admin';
    EXECUTE 'GRANT USAGE ON SCHEMA audit TO hope_app_template';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA audit TO hope_app_template';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO hope_app_template';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hope_app_template';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT USAGE, SELECT ON SEQUENCES TO hope_app_template';
    RAISE NOTICE 'audit schema found — privileges granted';
  ELSE
    RAISE NOTICE 'audit schema absent — skipping audit grants (expected in local dev)';
  END IF;
END
$audit$;

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
