/**
 * Test-only checkpoint exporter for the restore integration suite: the registry's scope
 * predicates + a direct `COPY … TO STDOUT` per table inside one REPEATABLE READ snapshot, written
 * through the real archive writer with the fake sealing. It mirrors the production exporter's
 * naming (`db/<Model>.csv.gz`, `media/<bucketId | bucket name>/<Media.uri>`) and its redaction (redacted
 * columns exported as NULL) without depending on it. `snapshot` imports an exported snapshot.
 *
 * `edit` may rewrite one table's CSV before it is sealed — that is how the suite builds
 * checkpoints with schema drift or a foreign tenant id inside a validly signed archive.
 */
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { PoolClient } from 'pg';
import { to as copyTo } from 'pg-copy-streams';

import { createArchiveWriter, openArchive, tableEntryName } from '../../../archive';
import { collect, fakeSealing } from '../../../archive/__tests__/helpers';
import type { CheckpointArchiveReader, CheckpointManifest, ManifestTable } from '../../../contracts';
import { sqlQueryOver } from '../../../db/checkpoint-pg';
import { CHECKPOINT_REGISTRY, tableName } from '../../../registry/registry';
import { currentColumns, schemaFingerprint } from '../../../registry/schema';
import { scopePredicate } from '../../../registry/scope';

export interface TestCheckpoint {
  file: Buffer;
  dataKey: Buffer;
  open(): Promise<CheckpointArchiveReader>;
}

const UUID = /^[0-9a-f-]{36}$/;

async function copyOut(client: PoolClient, sql: string): Promise<Buffer> {
  const stream = client.query(copyTo(sql));
  return collect(stream as unknown as Readable);
}

export async function checkpointOf(
  client: PoolClient,
  tenantId: string,
  opts: { edit?: Record<string, (csv: string) => string>; media?: { entry: string; bytes: Buffer }[]; snapshot?: string } = {},
): Promise<TestCheckpoint> {
  if (!UUID.test(tenantId)) throw new Error('tenant id must be a UUID');
  const sealing = fakeSealing();
  const { plaintext: dataKey, platformWrapped } = await sealing.generateDataKey();
  const query = sqlQueryOver(client);
  const sink = new PassThrough();
  const fileP = collect(sink);

  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    if (opts.snapshot) await client.query(`SET TRANSACTION SNAPSHOT '${opts.snapshot}'`);
    const fingerprint = await schemaFingerprint(query);
    const writer = createArchiveWriter({
      header: {
        checkpointId: '01900000-0000-7000-8000-00000000c0de',
        tenantId,
        tenantKey: 'l6b-test',
        sourceDeploymentId: await sealing.deploymentId(),
        createdAt: new Date().toISOString(),
        schemaFingerprint: fingerprint,
        includesMedia: !!opts.media?.length,
        keys: { platform: platformWrapped },
      },
      dataKey,
      sink,
      sealing,
    });
    const captured = CHECKPOINT_REGISTRY.filter((d) => d.policy !== 'EXCLUDED');
    const cols = await currentColumns(
      query,
      captured.map((d) => d.model),
    );
    const tables: ManifestTable[] = [];
    const literal = `'${tenantId}'`;
    for (const d of captured) {
      const columns = cols[d.model];
      if (!columns.length) continue;
      const where = scopePredicate(d, 's').replace(/\$1/g, literal);
      let csv = (
        await copyOut(client, `COPY (SELECT ${columns.map((c) => ((d.redactColumns ?? []).includes(c) ? `NULL AS "${c}"` : `s."${c}"`)).join(', ')} FROM ${tableName(d)} s WHERE ${where} ORDER BY s."id") TO STDOUT (FORMAT csv, HEADER)`)
      ).toString('utf8');
      const edit = opts.edit?.[d.model];
      if (edit) csv = edit(csv);
      const [{ n }] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tableName(d)} s WHERE ${scopePredicate(d, 's')}`, [tenantId]);
      const extraRows = edit ? csv.split('\n').filter(Boolean).length - 1 - n : 0;
      const gz = gzipSync(Buffer.from(csv, 'utf8'));
      const { sha256 } = await writer.writeEntry(tableEntryName(d.model), gz);
      tables.push({ model: d.model, columns: csv.split('\n')[0].split(','), rowCount: n + extraRows, sha256 });
    }
    const media: CheckpointManifest['media'] = [];
    for (const m of opts.media ?? []) {
      const { sha256, bytes } = await writer.writeEntry(m.entry, m.bytes);
      const [, bucketId, ...key] = m.entry.split('/');
      media.push({ entry: m.entry, size: bytes, sha256, bucketId, key: key.join('/') });
    }
    await client.query('COMMIT');
    await writer.finish({
      formatVersion: 1,
      schemaFingerprint: fingerprint,
      tables,
      media,
      claimChecks: [],
      transitKeyVersions: {},
      notCaptured: [],
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  const file = await fileP;
  return {
    file,
    dataKey,
    open: () => openArchive(Readable.from([file]), Buffer.from(dataKey)),
  };
}

/** md5 over every in-scope row of a model, ordered by id — "byte-identical" in one value. */
export async function fingerprintRows(client: PoolClient, tenantId: string, models: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const model of models) {
    const d = CHECKPOINT_REGISTRY.find((x) => x.model === model)!;
    const { rows } = await client.query<{ h: string }>(
      `SELECT md5(coalesce(string_agg(s::text, '|' ORDER BY s."id"), '')) AS h FROM ${tableName(d)} s WHERE ${scopePredicate(d, 's')}`,
      [tenantId],
    );
    out[model] = rows[0].h;
  }
  return out;
}

export function sha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}
