/**
 * TASK-1003 F-10a — `SttStreamingUsagePushbackRequest` must accept the exact wire
 * body `apps/stt` sends, whole.
 *
 * `apps/stt/src/stt/core/api_client/gateway.py::record_streaming_usage` POSTs
 * `{**summary, interrupted}` verbatim — `summary` is
 * `SessionManager._build_teardown_summary()` — to
 * `POST /api/v1/internal/stt/streaming/usage`. The global pipe runs
 * `whitelist + forbidNonWhitelisted + forbidUnknownValues`, so a field the
 * builder returns that this DTO does not declare does not degrade: it 400s
 * EVERY push-back, on the one path that exists because the gateway already
 * crashed once and lost the usage the first time. `lexicon_correction_count`
 * (TASK-935) was exactly that field until this fixture pinned it.
 *
 * The shared fixture — read identically by the Python producer-side test,
 * `apps/stt/tests/unit/contracts/test_streaming_usage_contract.py` — is the
 * cross-language contract: change the summary's field set on either side and
 * update `tests/contracts/stt-streaming-usage.fixture.json` in the same commit,
 * or one half goes stale silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { SttStreamingUsagePushbackRequest } from '../dto/stt-streaming-usage.request';

const FIXTURE_PATH = join(__dirname, '../../../../../../tests/contracts/stt-streaming-usage.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as { pushback: Record<string, unknown> };

// The global pipe's own validator options (`main.ts`) — an unknown/undeclared
// field must reject here exactly as it would at the real route.
const VALIDATOR_OPTIONS = { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true } as const;

describe('SttStreamingUsagePushbackRequest — shared push-back contract', () => {
  it('accepts the fixture push-back body whole, with zero validation errors', async () => {
    const dto = plainToInstance(SttStreamingUsagePushbackRequest, fixture.pushback);

    const errors = await validate(dto, VALIDATOR_OPTIONS);

    expect(errors).toEqual([]);
  });

  it('round-trips lexicon_correction_count onto the instance', () => {
    const dto = plainToInstance(SttStreamingUsagePushbackRequest, fixture.pushback);

    expect(dto.lexicon_correction_count).toBe(fixture.pushback.lexicon_correction_count);
  });
});
