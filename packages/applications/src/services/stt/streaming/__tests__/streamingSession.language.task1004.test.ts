/**
 * TASK-1004 — the live hop to `apps/stt` carries the resolved mode AND who declared it, and the
 * receipt STT answers with comes back to the gateway in camelCase.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingSessionService } from '../streamingSession.service';

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../../tests/contracts/language-resolution.fixture.json'), 'utf-8')) as {
  receipt: { examples: Array<{ python: Record<string, unknown>; gateway: Record<string, unknown> }> };
};
const sarvam = fixture.receipt.examples[1]!;

describe('StreamingSessionService — language on the create hop', () => {
  let httpService: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    httpService = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
  });

  const service = () => new StreamingSessionService(httpService as never, { config: { STT_URL: 'http://stt' } } as never);

  it('sends language_mode + language_mode_source, and projects language_resolution to camelCase', async () => {
    httpService.post.mockReturnValue(
      of({ data: { session_id: 's-1', status: 'active', max_concurrent: 4, current_active: 1, language_resolution: sarvam.python } }),
    );

    const result = await service().createSession({
      sessionId: 's-1',
      tenantId: 't-1',
      pipelineId: 'p-1',
      languageMode: 'ml-en',
      languageModeSource: 'consultation',
    });

    const body = httpService.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.language_mode).toBe('ml-en');
    expect(body.language_mode_source).toBe('consultation');
    expect(result?.languageResolution).toEqual(sarvam.gateway);
  });

  it('omits language_mode_source when no mode is sent (STT stamps agent/default itself)', async () => {
    httpService.post.mockReturnValue(of({ data: { session_id: 's-1', status: 'active', max_concurrent: 4, current_active: 1 } }));

    const result = await service().createSession({ sessionId: 's-1', tenantId: 't-1', pipelineId: 'p-1' });

    const body = httpService.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.language_mode).toBeNull();
    expect(body).not.toHaveProperty('language_mode_source');
    expect(result).not.toHaveProperty('languageResolution');
  });

  it('getSessionStatus projects the receipt too', async () => {
    httpService.get.mockReturnValue(
      of({ data: { session_id: 's-1', status: 'active', max_concurrent: 4, current_active: 1, language_resolution: sarvam.python } }),
    );
    const status = await service().getSessionStatus('s-1', 't-1');
    expect(status?.languageResolution).toEqual(sarvam.gateway);
  });
});
