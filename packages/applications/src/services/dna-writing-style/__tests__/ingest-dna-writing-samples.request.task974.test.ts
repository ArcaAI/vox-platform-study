/**
 * L5/F3 — `IngestDnaWritingSamplesRequest.items[].writtenAt`.
 *
 * `writtenAt` is the time-series KEY: the corpus is ordered by it, the oldest items are dropped
 * by it, and the 202 body reports a window computed from it. A value the validator accepts but
 * `Date.parse` cannot read therefore produced an accepted request with an un-runnable job behind
 * it, so the contract is pinned from BOTH ends — the decorator here for the shapes it can judge,
 * and `DnaWritingStyleService.assertParsableWrittenAt` for the ones it cannot.
 */
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DnaWritingSampleDto } from '../dto/ingest-dna-writing-samples.request';

async function writtenAtErrors(writtenAt: unknown): Promise<string[]> {
  const dto = plainToInstance(DnaWritingSampleDto, { text: 'A note.', writtenAt });
  const errors = await validate(dto);
  return errors.filter((error) => error.property === 'writtenAt').map((error) => Object.keys(error.constraints ?? {}).join(','));
}

describe('writtenAt', () => {
  it.each(['2026-09-01T09:30:00.000Z', '2026-09-01T09:30:00+05:30', '2026-09-01'])('accepts %s', async (value) => {
    expect(await writtenAtErrors(value)).toHaveLength(0);
  });

  it('rejects a space separator — `strictSeparator` is what makes the T mandatory', async () => {
    expect(await writtenAtErrors('2026-09-01 09:30:00')).toHaveLength(1);
  });

  it('rejects a date that does not exist — `strict` is what checks the calendar', async () => {
    // Without `strict` this passes the regex and `Date.parse` silently rolls it into March.
    expect(await writtenAtErrors('2026-02-30T00:00:00Z')).toHaveLength(1);
  });

  it('rejects a non-string outright', async () => {
    expect(await writtenAtErrors(42)).toHaveLength(1);
  });

  /**
   * Week and basic-format dates ARE valid ISO-8601, so the decorator admits them and no stricter
   * option exists that would not also reject the date-only form the contract accepts. They are
   * refused by the service instead — this test records WHY the second check exists, so nobody
   * deletes it as redundant.
   */
  it.each(['2026-W01', '20260901'])('admits %s, which `Date.parse` cannot read — the service refuses it', async (value) => {
    expect(await writtenAtErrors(value)).toHaveLength(0);
    expect(Number.isNaN(Date.parse(value))).toBe(true);
  });
});
