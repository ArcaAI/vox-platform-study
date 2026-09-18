/**
 * TASK-986 R6 — `?ids=` validation on the users export.
 *
 * The id set is composed into an `id[in]:…` token of the CSV filter grammar
 * (separators `;` `|` `[` `]:`), so every item must be constrained at the edge
 * to keep a filter-injection token unrepresentable. It must NOT, however, be
 * constrained to a VERSIONED uuid: this platform's reserved rows carry ids
 * whose version nibble is `0` (`60000000-…` the system user, `70000000-…` the
 * seeded accounts), which `@IsUUID('all')` rejects. Proven live against the
 * dev gateway before this test existed: exporting a selection containing
 * `70000000-0000-0000-0000-000000000010` answered
 * `400 each value in ids must be a UUID`, i.e. "Export selected" was broken for
 * every seeded user while working for runtime uuidv7 rows.
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ExportUsersQuery } from '../dto/export-users.query';

async function errorsFor(ids: unknown): Promise<string[]> {
  const dto = plainToInstance(ExportUsersQuery, { format: 'csv', ids });
  const errors = await validate(dto);
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('ExportUsersQuery.ids', () => {
  it('accepts a reserved-prefix platform id (version nibble 0)', async () => {
    expect(await errorsFor('70000000-0000-0000-0000-000000000010')).toEqual([]);
  });

  it('accepts the reserved system user id', async () => {
    expect(await errorsFor('60000000-0000-0000-0000-000000000000')).toEqual([]);
  });

  it('accepts a runtime uuidv7 id', async () => {
    expect(await errorsFor('01a0b467-7766-77ba-a138-5048dd0ffffd')).toEqual([]);
  });

  it('accepts a mixed selection of reserved and uuidv7 ids', async () => {
    expect(await errorsFor('70000000-0000-0000-0000-000000000010,01a0b467-7766-77ba-a138-5048dd0ffffd')).toEqual([]);
  });

  it('still rejects a filter-injection token', async () => {
    const errors = await errorsFor('not-a-uuid;resourceStatus[equals]:DELETED');
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each([';', '|', '[', ']', ':'])('still rejects an id containing the grammar separator %s', async (separator) => {
    const errors = await errorsFor(`70000000-0000-0000-0000-00000000001${separator}`);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('still rejects a non-hex id of the right shape', async () => {
    const errors = await errorsFor('zzzzzzzz-0000-0000-0000-000000000010');
    expect(errors.length).toBeGreaterThan(0);
  });
});
