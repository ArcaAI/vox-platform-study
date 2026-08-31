/**
 * `MlflowSearchQuery` validation, driven through the REAL global ValidationPipe
 * configuration (`main.ts`: transform + whitelist + forbidNonWhitelisted +
 * forbidUnknownValues).
 *
 * This DTO is the seam that keeps the MLflow proxy from degenerating into an
 * arbitrary pass-through to an unauthenticated tracking server, so the
 * rejection cases matter more than the happy path.
 */

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MlflowSearchQuery } from '../dto/mlflow-search.query';

const PIPE_CFG = { transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true } as const;

async function runPipe(value: unknown): Promise<unknown> {
  const pipe = new ValidationPipe(PIPE_CFG);
  return pipe.transform(value, { type: 'query', metatype: MlflowSearchQuery } as never);
}

describe('MlflowSearchQuery', () => {
  it('accepts an empty window — every field is optional', async () => {
    await expect(runPipe({})).resolves.toEqual({});
  });

  it('coerces maxResults from its query-string form', async () => {
    await expect(runPipe({ maxResults: '25' })).resolves.toMatchObject({ maxResults: 25 });
  });

  it('rejects a page size above the cap so one read cannot ask MLflow for an unbounded scan', async () => {
    await expect(runPipe({ maxResults: '5000' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-integer page size', async () => {
    await expect(runPipe({ maxResults: 'all' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an undeclared query param rather than forwarding it upstream', async () => {
    await expect(runPipe({ experimentIds: '1' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an over-long filter', async () => {
    await expect(runPipe({ filter: 'x'.repeat(1001) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forwards a well-formed MLflow filter expression verbatim', async () => {
    await expect(runPipe({ filter: "name LIKE 'whisper%'" })).resolves.toMatchObject({ filter: "name LIKE 'whisper%'" });
  });
});
