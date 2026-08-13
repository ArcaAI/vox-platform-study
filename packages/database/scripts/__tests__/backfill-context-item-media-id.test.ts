// Unit tests for the backfill script (scripts/backfill-context-item-media-id.ts).
// The live Postgres round-trip is exercised manually/in the ticket README; here
// we lock down the pure helpers (isValidMediaId, deriveMediaFields, parseArgs)
// and the plan/apply logic against an in-memory fake client — NO live DB.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isValidMediaId,
  deriveMediaFields,
  parseArgs,
  planBackfill,
  applyBackfill,
  type BackfillClient,
  type TargetContextItem,
} from '../backfill-context-item-media-id';

describe('isValidMediaId', () => {
  it('accepts a well-formed UUID (any case)', () => {
    expect(isValidMediaId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidMediaId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('rejects a raw storage key (the pre- bug value)', () => {
    expect(isValidMediaId('attachments/lab-scan.pdf')).toBe(false);
    expect(isValidMediaId('raw-capture.webm')).toBe(false);
  });

  it('rejects a malformed near-UUID', () => {
    expect(isValidMediaId('550e8400-e29b-41d4-a716-44665544000')).toBe(false); // one char short
    expect(isValidMediaId('not-a-uuid-at-all')).toBe(false);
  });
});

describe('deriveMediaFields', () => {
  it('derives name/extension/mimeType from a simple key', () => {
    expect(deriveMediaFields('lab-scan.pdf')).toEqual({ name: 'lab-scan.pdf', extension: 'pdf', mimeType: 'application/pdf' });
  });

  it('derives from a nested key, using only the final path segment for name', () => {
    expect(deriveMediaFields('tenant-1/consult-1/raw-capture.webm')).toEqual({
      name: 'raw-capture.webm',
      extension: 'webm',
      mimeType: 'audio/webm',
    });
  });

  it('falls back to application/octet-stream for an unknown/missing extension', () => {
    expect(deriveMediaFields('no-extension-file')).toEqual({ name: 'no-extension-file', extension: '', mimeType: 'application/octet-stream' });
    expect(deriveMediaFields('file.xyz')).toEqual({ name: 'file.xyz', extension: 'xyz', mimeType: 'application/octet-stream' });
  });
});

describe('parseArgs', () => {
  it('defaults to dry-run, all tenants, attachments bucket', () => {
    expect(parseArgs([])).toEqual({ apply: false, tenantId: null, bucket: 'attachments' });
  });

  it('honors --apply, --tenant, --bucket', () => {
    expect(parseArgs(['--tenant', 'tenant-1', '--bucket', 'uploads', '--apply'])).toEqual({
      apply: true,
      tenantId: 'tenant-1',
      bucket: 'uploads',
    });
  });
});

/** In-memory fake satisfying the BackfillClient contract, for plan/apply tests. */
function createFakeClient(seedContextItems: TargetContextItem[]) {
  const contextItems = new Map(seedContextItems.map((row) => [row.id, { ...row }]));
  const mediaRows: Array<{ id: string; tenantId: string; uri: string }> = [];
  let nextMediaSeq = 1;

  const client: BackfillClient = {
    contextItem: {
      // Honors `where.tenantId` the way the real Prisma client would, so tenant
      // scoping is actually exercised by the tests (type/mediaId-not-null are
      // already guaranteed by the fixture, so only tenantId needs faking here).
      findMany: async (args: unknown) => {
        const where = (args as { where?: { tenantId?: string } }).where ?? {};
        const rows = Array.from(contextItems.values());
        return where.tenantId ? rows.filter((row) => row.tenantId === where.tenantId) : rows;
      },
      update: async (args: unknown) => {
        const { where, data } = args as { where: { id: string }; data: { mediaId: string } };
        const row = contextItems.get(where.id);
        if (row) row.mediaId = data.mediaId;
        return row;
      },
    },
    media: {
      findFirst: async (args: unknown) => {
        const where = (args as { where: { tenantId: string; uri: string } }).where;
        const found = mediaRows.find((m) => m.tenantId === where.tenantId && m.uri === where.uri);
        return found ? { id: found.id } : null;
      },
      create: async (args: unknown) => {
        const data = (args as { data: { tenantId: string; uri: string } }).data;
        // UUID-SHAPED, matching what Prisma's real `@default(uuid(7))` produces —
        // required so a second planBackfill() pass correctly treats the rewritten
        // mediaId as already-valid (isValidMediaId) and stops re-targeting the row.
        const id = `00000000-0000-4000-8000-${String(nextMediaSeq++).padStart(12, '0')}`;
        mediaRows.push({ id, tenantId: data.tenantId, uri: data.uri });
        return { id };
      },
    },
    $transaction: async (fn) => fn(client),
  };

  return { client, contextItems, mediaRows };
}

describe('planBackfill + applyBackfill', () => {
  let fixture: ReturnType<typeof createFakeClient>;

  beforeEach(() => {
    fixture = createFakeClient([
      { id: 'ctx-1', tenantId: 'tenant-1', mediaId: 'lab-scan.pdf' }, // raw key — TARGET
      { id: 'ctx-2', tenantId: 'tenant-1', mediaId: '550e8400-e29b-41d4-a716-446655440000' }, // already valid — NOT a target
      { id: 'ctx-3', tenantId: 'tenant-1', mediaId: 'lab-scan.pdf' }, // same raw key as ctx-1 — dedupes to the SAME Media row
    ]);
  });

  it('leaves a ContextItem whose mediaId is already a valid UUID untouched (not in the plan)', async () => {
    const plan = await planBackfill(fixture.client, { apply: false, tenantId: null, bucket: 'attachments' });
    expect(plan.map((r) => r.contextItemId)).not.toContain('ctx-2');
    expect(plan).toHaveLength(2); // ctx-1 and ctx-3 only
  });

  it('resolves the SAME Media row for two ContextItems sharing the same raw key (dedupe, not two creates)', async () => {
    const plan = await planBackfill(fixture.client, { apply: false, tenantId: null, bucket: 'attachments' });
    const ctx1 = plan.find((r) => r.contextItemId === 'ctx-1')!;
    const ctx3 = plan.find((r) => r.contextItemId === 'ctx-3')!;
    expect(ctx1.resolvedMediaId).toBe(ctx3.resolvedMediaId);
    expect(ctx1.mediaAction).toBe('created');
    expect(ctx3.mediaAction).toBe('reused'); // second reference reuses the row the first one just created
    expect(fixture.mediaRows).toHaveLength(1); // exactly one Media row created for the shared key
  });

  it('builds the canonical s3://<bucket>/<key> uri on the created Media row', async () => {
    const plan = await planBackfill(fixture.client, { apply: false, tenantId: null, bucket: 'attachments' });
    expect(plan[0].uri).toBe('s3://attachments/lab-scan.pdf');
  });

  it('DRY RUN (plan only) never rewrites ContextItem.mediaId', async () => {
    await planBackfill(fixture.client, { apply: false, tenantId: null, bucket: 'attachments' });
    expect(fixture.contextItems.get('ctx-1')!.mediaId).toBe('lab-scan.pdf'); // unchanged
  });

  it('APPLY rewrites ContextItem.mediaId to the resolved Media UUID', async () => {
    const plan = await planBackfill(fixture.client, { apply: true, tenantId: null, bucket: 'attachments' });
    const applied = await applyBackfill(fixture.client, plan);

    expect(applied).toBe(2);
    expect(isValidMediaId(fixture.contextItems.get('ctx-1')!.mediaId)).toBe(true);
    expect(fixture.contextItems.get('ctx-3')!.mediaId).toBe(fixture.contextItems.get('ctx-1')!.mediaId);
    expect(fixture.contextItems.get('ctx-2')!.mediaId).toBe('550e8400-e29b-41d4-a716-446655440000'); // untouched
  });

  it('IDEMPOTENT: re-running plan+apply after a first apply finds nothing left to do', async () => {
    const firstPlan = await planBackfill(fixture.client, { apply: true, tenantId: null, bucket: 'attachments' });
    await applyBackfill(fixture.client, firstPlan);

    // Second run — every mediaId is now a valid UUID, so nothing matches the target filter.
    const secondPlan = await planBackfill(fixture.client, { apply: true, tenantId: null, bucket: 'attachments' });
    expect(secondPlan).toHaveLength(0);

    const secondApplied = await applyBackfill(fixture.client, secondPlan);
    expect(secondApplied).toBe(0);
    // No new Media rows were created on the second pass.
    expect(fixture.mediaRows).toHaveLength(1);
  });

  it('scopes to a single tenant when --tenant is given', async () => {
    const multi = createFakeClient([
      { id: 'ctx-a', tenantId: 'tenant-A', mediaId: 'a.pdf' },
      { id: 'ctx-b', tenantId: 'tenant-B', mediaId: 'b.pdf' },
    ]);
    const plan = await planBackfill(multi.client, { apply: false, tenantId: 'tenant-A', bucket: 'attachments' });
    expect(plan.map((r) => r.contextItemId)).toEqual(['ctx-a']);
  });
});
