/**
 * TASK-402 — one-shot, UPDATE-only backfill for the TEST DB (hope_test@5433).
 *
 * Bcrypt-hashes every non-empty, non-bcrypt `core."User".password` value in
 * place (each row's own plaintext, 10 rounds — matching CryptoService's
 * default). Idempotent: re-running finds 0 candidate rows. Performs ONLY
 * SELECT + UPDATE; never DELETE/TRUNCATE/DDL. Dev DB (hope@5432) had 0
 * candidate rows — not touched.
 *
 * Run from the repo root:
 *   node docs/implementation/TASK-402-Password-Hash-And-Settings-Fixes/backfill-test-db.mjs
 */
import bcrypt from 'bcryptjs';
import { createRequire } from 'node:module';

// `pg` lives in packages/database's dependency tree, not the repo root.
const require = createRequire(new URL('../../../packages/database/package.json', import.meta.url));
const pg = require('pg');

const client = new pg.Client({ connectionString: 'postgresql://test:test@localhost:5433/hope_test' });
await client.connect();

const candidates = await client.query(
  `SELECT id, username, password FROM core."User"
   WHERE password IS NOT NULL AND password <> ''
     AND password NOT LIKE '$2a$%' AND password NOT LIKE '$2b$%' AND password NOT LIKE '$2y$%'
   ORDER BY username`,
);
console.log(`candidates: ${candidates.rowCount}`);

let updated = 0;
for (const row of candidates.rows) {
  const hash = await bcrypt.hash(row.password, 10);
  const res = await client.query(`UPDATE core."User" SET password = $1 WHERE id = $2`, [hash, row.id]);
  updated += res.rowCount;
  console.log(`updated ${row.username}`);
}

const remaining = await client.query(
  `SELECT count(*)::int AS n FROM core."User"
   WHERE password IS NOT NULL AND password <> ''
     AND password NOT LIKE '$2a$%' AND password NOT LIKE '$2b$%' AND password NOT LIKE '$2y$%'`,
);
console.log(`updated=${updated} remaining_non_bcrypt=${remaining.rows[0].n}`);
await client.end();
