/**
 * TASK-330 Phase 1 — additive schema regression guard (live Postgres).
 *
 * Proves the Phase 1 ADDITIVE migration
 *   `…_task_330_phase1_clinical_harness_status_attestation_ner`
 * actually landed on the dev database:
 *
 *   1. `core.ConsultationStatus` enum exists with EXACTLY the 6 lifecycle
 *      states (OPEN, RECORDING, PENDING_REVIEW, SIGNED, CLOSED, REOPENED).
 *   2. `core.ContextItemType` gained the additive `SIGNED_NOTE` value.
 *   3. `Consultation.status` column exists (NOT NULL, ConsultationStatus,
 *      DEFAULT 'OPEN') so the backfill could populate it.
 *   4. The attestation columns landed on `ContextItemVersion`.
 *   5. The ontology-code + transcript-span columns (and the
 *      `transcriptContextItemId` FK) landed on `NamedEntity`.
 *   6. The sensor/citation columns landed on `SummaryMeta`.
 *
 * Read-only: the suite only SELECTs from the catalog + information_schema and
 * never mutates data. Excluded from `pnpm test:unit` (the `*.postgres.test.ts`
 * suffix); run explicitly with:
 *   pnpm --filter @arcaai/database exec vitest run --config vitest.worm.config.ts
 *
 * Self-skips when no live DB / migration is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/hope';

let client: pg.Client;
/** False when no live DB is reachable — the suite then self-skips. */
let available = false;

async function enumLabels(typname: string): Promise<string[]> {
  const res = await client.query(
    `SELECT e.enumlabel AS label
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = $1 AND n.nspname = 'core'
      ORDER BY e.enumsortorder`,
    [typname],
  );
  return res.rows.map((r) => r.label as string);
}

async function columns(
  table: string,
): Promise<Map<string, { dataType: string; udtName: string; isNullable: string; columnDefault: string | null }>> {
  const res = await client.query(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'core' AND table_name = $1`,
    [table],
  );
  const map = new Map<string, { dataType: string; udtName: string; isNullable: string; columnDefault: string | null }>();
  for (const r of res.rows) {
    map.set(r.column_name as string, {
      dataType: r.data_type as string,
      udtName: r.udt_name as string,
      isNullable: r.is_nullable as string,
      columnDefault: (r.column_default as string | null) ?? null,
    });
  }
  return map;
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
  } catch {
    available = false;
    return;
  }
  const exists = await client.query(`SELECT to_regclass('core."Consultation"') AS tbl`);
  available = Boolean(exists.rows[0]?.tbl);
});

afterAll(async () => {
  if (client) await client.end().catch(() => undefined);
});

describe('TASK-330 Phase 1 additive schema', () => {
  it('creates core.ConsultationStatus with the lifecycle states (incl. TASK-355 DRAFT_PENDING_SENSORS)', async () => {
    if (!available) return;
    const labels = await enumLabels('ConsultationStatus');
    // TASK-355 Phase D added DRAFT_PENDING_SENSORS (optimistic two-phase delivery).
    expect(new Set(labels)).toEqual(
      new Set(['OPEN', 'RECORDING', 'DRAFT_PENDING_SENSORS', 'PENDING_REVIEW', 'SIGNED', 'CLOSED', 'REOPENED']),
    );
  });

  it('adds SIGNED_NOTE to core.ContextItemType', async () => {
    if (!available) return;
    const labels = await enumLabels('ContextItemType');
    expect(labels).toContain('SIGNED_NOTE');
  });

  it('adds Consultation.status (NOT NULL, ConsultationStatus, DEFAULT OPEN)', async () => {
    if (!available) return;
    const cols = await columns('Consultation');
    const status = cols.get('status');
    expect(status).toBeDefined();
    expect(status?.udtName).toBe('ConsultationStatus');
    expect(status?.isNullable).toBe('NO');
    expect(status?.columnDefault ?? '').toContain('OPEN');
  });

  it('adds the attestation columns to ContextItemVersion', async () => {
    if (!available) return;
    const cols = await columns('ContextItemVersion');
    for (const name of ['attestedAt', 'attestedBy', 'attestationHash', 'modelName', 'modelVersion', 'sensorScores']) {
      expect(cols.has(name), `ContextItemVersion.${name} should exist`).toBe(true);
    }
    expect(cols.get('attestedAt')?.dataType).toContain('timestamp');
    expect(cols.get('sensorScores')?.dataType).toBe('jsonb');
    // additive ⇒ every new column must be nullable
    for (const name of ['attestedAt', 'attestedBy', 'attestationHash', 'modelName', 'modelVersion', 'sensorScores']) {
      expect(cols.get(name)?.isNullable).toBe('YES');
    }
  });

  it('adds ontology + transcript-span columns (and FK) to NamedEntity', async () => {
    if (!available) return;
    const cols = await columns('NamedEntity');
    for (const name of [
      'umlsCui',
      'snomedCode',
      'rxnormCode',
      'icdCode',
      'loincCode',
      'transcriptContextItemId',
      'transcriptStartOffset',
      'transcriptEndOffset',
    ]) {
      expect(cols.has(name), `NamedEntity.${name} should exist`).toBe(true);
      expect(cols.get(name)?.isNullable).toBe('YES');
    }
    expect(cols.get('transcriptStartOffset')?.dataType).toBe('integer');

    // FK transcriptContextItemId -> ContextItem(id)
    const fk = await client.query(
      `SELECT 1
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'core'
          AND tc.table_name = 'NamedEntity'
          AND kcu.column_name = 'transcriptContextItemId'`,
    );
    expect(fk.rowCount, 'NamedEntity.transcriptContextItemId FK should exist').toBeGreaterThan(0);
  });

  it('adds sensor/citation columns to SummaryMeta', async () => {
    if (!available) return;
    const cols = await columns('SummaryMeta');
    for (const name of [
      'entityFaithfulnessScore',
      'coverageScore',
      'ragTriadScore',
      'citationsMap',
      'guardrailDecisions',
      'attestationRef',
      'modelName',
    ]) {
      expect(cols.has(name), `SummaryMeta.${name} should exist`).toBe(true);
      expect(cols.get(name)?.isNullable).toBe('YES');
    }
    expect(cols.get('citationsMap')?.dataType).toBe('jsonb');
    expect(cols.get('guardrailDecisions')?.dataType).toBe('jsonb');
    expect(cols.get('entityFaithfulnessScore')?.dataType).toContain('double');
  });
});
