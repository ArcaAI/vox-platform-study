/**
 * PaginatedQuery DTO Tests (TASK-776 F-02)
 *
 * Offset pagination echoed the RAW `limit` query value in the response
 * envelope even though the EFFECTIVE page size applied to the query was the
 * documented default of 10 (`withFormattedPaginatedProps`'s
 * `props.limit || DEFAULT_PAGE_SIZE`). A client omitting `?limit=` saw
 * `{ limit: 0 }` while 10 rows were actually returned, so paginating off the
 * echoed value looped forever on page 0.
 *
 * Root cause: `@Transform(({ value }) => parseInt(value, 10))` turns an
 * absent `limit` into `NaN`. Downstream, `NaN || 0` (FetchResponse) and
 * `NaN || 10` (withFormattedPaginatedProps) fall back to DIFFERENT falsy
 * defaults for the same NaN. Fixing it at the DTO layer — so the RAW
 * transformed value already equals the effective default — keeps a single
 * source of truth and requires no changes to every consuming service.
 */

import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PaginatedQuery, DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../paginated.query';

async function transformAndValidate(data: Record<string, unknown>): Promise<{ instance: PaginatedQuery; errors: string[] }> {
  const instance = plainToInstance(PaginatedQuery, data);
  const validationErrors = await validate(instance);
  return {
    instance,
    errors: validationErrors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
}

describe('PaginatedQuery', () => {
  it('defaults limit to DEFAULT_PAGE_SIZE (10) when the client omits it', async () => {
    const { instance, errors } = await transformAndValidate({});
    expect(errors).toEqual([]);
    expect(instance.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(instance.limit).toBe(10);
  });

  it('defaults page to DEFAULT_PAGE (0) when the client omits it', async () => {
    const { instance, errors } = await transformAndValidate({});
    expect(errors).toEqual([]);
    expect(instance.page).toBe(DEFAULT_PAGE);
    expect(instance.page).toBe(0);
  });

  it('preserves an explicit limit', async () => {
    const { instance, errors } = await transformAndValidate({ limit: '5' });
    expect(errors).toEqual([]);
    expect(instance.limit).toBe(5);
  });

  it('preserves an explicit page', async () => {
    const { instance, errors } = await transformAndValidate({ page: '2' });
    expect(errors).toEqual([]);
    expect(instance.page).toBe(2);
  });

  it('still rejects an invalid (non-numeric) limit', async () => {
    const { errors } = await transformAndValidate({ limit: 'abc' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('still rejects limit: 0 (Min(1))', async () => {
    const { errors } = await transformAndValidate({ limit: '0' });
    expect(errors.length).toBeGreaterThan(0);
  });
});
