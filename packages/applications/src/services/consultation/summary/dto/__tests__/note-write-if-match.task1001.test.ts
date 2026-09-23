/**
 * TASK-1001 wave 6 — the three note-write routes take their version from `If-Match`.
 *
 * `PATCH :id/summary/:summaryId`, `POST :id/summary/:contextItemId/approve` and
 * `PATCH :id/context/:contextId` all carry `@RequiresIfMatch()`: the header is mandatory (428
 * without it, 400 when it is not a strong validator) and it wins over the body. The body DTOs still
 * REQUIRED `expectedVersion` as well, so a caller that sent the header alone — `@arcaai/vox-node`'s
 * `summaries.approve`, and therefore ALaaS's Save — was refused 400 `VALIDATION.FAILED` by the
 * global pipe before the controller could fold the header in. The clinician's sign-off never
 * reached HOPE.
 *
 * Validated with the gateway's own pipe options (`whitelist + forbidNonWhitelisted +
 * forbidUnknownValues`) and the real class-validator — no mocks.
 */
import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SummaryApprovalRequest } from '../summary-approval.request';
import { UpdateSummaryRequest } from '../update-summary.request';
import { UpdateContextRequest } from '../../../context/dto/update-context.request';

type Dto = new () => object;

async function errorsOf(cls: Dto, body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  return errors.map((e) => e.property);
}

const CASES: Array<[string, Dto, Record<string, unknown>]> = [
  ['SummaryApprovalRequest', SummaryApprovalRequest, { clinicianUserId: 'doctor-1' }],
  ['UpdateSummaryRequest', UpdateSummaryRequest, { content: 'Edited note.', changeSource: 'doctor_edit', clinicianUserId: 'doctor-1' }],
  ['UpdateContextRequest', UpdateContextRequest, { content: 'Edited case note.' }],
];

describe.each(CASES)('%s — the version rides on If-Match', (_name, cls, body) => {
  it('accepts a body with no expectedVersion (the header carries it)', async () => {
    expect(await errorsOf(cls, body)).toEqual([]);
  });

  it('still accepts a body expectedVersion from a caller that sends both', async () => {
    expect(await errorsOf(cls, { ...body, expectedVersion: 7 })).toEqual([]);
  });

  it('still rejects a malformed body expectedVersion', async () => {
    expect(await errorsOf(cls, { ...body, expectedVersion: 0 })).toContain('expectedVersion');
    expect(await errorsOf(cls, { ...body, expectedVersion: '7' })).toContain('expectedVersion');
  });
});
