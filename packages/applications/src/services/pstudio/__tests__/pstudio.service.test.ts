/**
 * stripPrismaSchemaParam
 *
 * Prisma's connection-string-only `?schema=` query param is not understood by
 * the `postgres` (postgres.js) driver PrismaStudioService hands the raw
 * DATABASE_URL to: an unrecognized query param is forwarded to the server as
 * a startup/session GUC, and Postgres rejects it with
 * `unrecognized configuration parameter "schema"`. HOPE's `core` schema is
 * already selected client-side (see pstudio.html.ts's `defaultSchema: 'core'`
 * override), so the param carries no meaning for the raw driver connection
 * and must be stripped before `postgres(connectionString)` sees it.
 */

import { describe, it, expect } from 'vitest';
import { stripPrismaSchemaParam } from '../pstudio.service';

describe('stripPrismaSchemaParam', () => {
  it('removes the `schema` query param the postgres.js driver rejects', () => {
    expect(stripPrismaSchemaParam('postgresql://test:test@localhost:5433/hope_test?schema=public')).toBe(
      'postgresql://test:test@localhost:5433/hope_test',
    );
  });

  it('leaves a connection string with no query string untouched', () => {
    expect(stripPrismaSchemaParam('postgresql://postgres:postgres@localhost:5432/hope')).toBe(
      'postgresql://postgres:postgres@localhost:5432/hope',
    );
  });

  it('drops only `schema`, preserving other query params', () => {
    expect(
      stripPrismaSchemaParam('postgresql://test:test@localhost:5433/hope_test?schema=public&connection_limit=5'),
    ).toBe('postgresql://test:test@localhost:5433/hope_test?connection_limit=5');
  });
});
