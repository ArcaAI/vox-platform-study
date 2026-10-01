import type { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import { to as copyTo } from 'pg-copy-streams';

import type { SqlQuery } from '../contracts';
import { createCheckpointPool, sqlQueryOver } from '../db/checkpoint-pg';

/** One dedicated connection: the snapshot transaction and every COPY of an export run on it. */
export interface CheckpointDbSession {
  query: SqlQuery;
  /** `COPY … TO STDOUT` as a stream. COPY takes no bind parameters. */
  copyOut(sql: string): Readable;
  release(error?: Error): void;
}

export interface CheckpointDbConnector {
  connect(): Promise<CheckpointDbSession>;
}
export const CHECKPOINT_DB_CONNECTOR = Symbol('CHECKPOINT_DB_CONNECTOR');

/** `pg` over `DIRECT_URL` (Prisma cannot COPY). The pool is created on first use. */
export class PgCheckpointDbConnector implements CheckpointDbConnector {
  private pool?: Pool;

  async connect(): Promise<CheckpointDbSession> {
    this.pool ??= createCheckpointPool();
    const client: PoolClient = await this.pool.connect();
    return {
      query: sqlQueryOver(client as never),
      copyOut: (sql) => client.query(copyTo(sql)),
      // A client released with an error is destroyed, never returned to the pool mid-transaction.
      release: (error) => client.release(error),
    };
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }
}
