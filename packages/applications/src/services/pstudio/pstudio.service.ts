import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { IPrismaStudioService } from './IPrismaStudioService';

/* eslint-disable @typescript-eslint/no-require-imports */
const { createPostgresJSExecutor } = require('@prisma/studio-core/data/postgresjs');
const { serializeError } = require('@prisma/studio-core/data/bff');
const postgres = require('postgres');
/* eslint-enable @typescript-eslint/no-require-imports */

type StudioExecutor = {
  execute(query: unknown, options?: unknown): Promise<[Error] | [null, unknown]>;
};

/**
 * Prisma's connection-string-only `?schema=` query param is not understood by
 * the `postgres` (postgres.js) driver below: an unrecognized query param is
 * forwarded to the server as a startup/session GUC, and Postgres rejects it
 * with `unrecognized configuration parameter "schema"`. HOPE's `core` schema
 * is already selected client-side (see pstudio.html.ts's
 * `defaultSchema: 'core'` override), so the param carries no meaning for the
 * raw driver connection and must be stripped before the driver sees it.
 */
export function stripPrismaSchemaParam(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('schema');
  return url.toString();
}

@Injectable()
export class PrismaStudioService implements IPrismaStudioService, OnModuleDestroy {
  private readonly logger = new Logger(PrismaStudioService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sqlInstance: any = null;
  private executorInstance: StudioExecutor | null = null;

  private getExecutor(): StudioExecutor {
    if (!this.executorInstance) {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error('DATABASE_URL environment variable is not set');
      }

      this.sqlInstance = postgres(stripPrismaSchemaParam(connectionString));
      this.executorInstance = createPostgresJSExecutor(this.sqlInstance) as StudioExecutor;
    }
    return this.executorInstance;
  }

  async executeQuery(query: unknown) {
    const executor = this.getExecutor();
    const result = await executor.execute(query);

    if (result[0] !== null) {
      this.logger.warn(`Studio query failed: ${(result[0] as Error).message}`);
      return [serializeError(result[0])];
    }

    return [null, result[1]];
  }

  async executeSequence(sequence: readonly [unknown, unknown]) {
    const executor = this.getExecutor();

    const firstResult = await executor.execute(sequence[0]);
    if (firstResult[0] !== null) {
      return [[serializeError(firstResult[0])]];
    }

    const secondResult = await executor.execute(sequence[1]);
    if (secondResult[0] !== null) {
      return [[null, firstResult[1]], [serializeError(secondResult[0])]];
    }

    return [
      [null, firstResult[1]],
      [null, secondResult[1]],
    ];
  }

  async onModuleDestroy() {
    if (this.sqlInstance) {
      await this.sqlInstance.end();
      this.sqlInstance = null;
      this.executorInstance = null;
    }
  }
}
