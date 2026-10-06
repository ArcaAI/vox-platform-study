/**
 * TASK-1048 — the session manager keeps the creation warnings; a refusal stays an error that
 * carries the server's message and machine code.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamingSessionManager } from '../StreamingSessionManager';
import { createMockLogger, mockFetch, createMockResponse } from '../../__tests__/setup';
import { AgenticClient } from '../AgenticClient';
import { AgenticError } from '../../types';

describe('StreamingSessionManager — warnings (TASK-1048)', () => {
  let manager: StreamingSessionManager;
  beforeEach(() => {
    const client = new AgenticClient({ baseUrl: 'https://api.example.com', apiKey: 'k', wsUrl: 'wss://api.example.com' }, createMockLogger());
    manager = new StreamingSessionManager(client, createMockLogger());
  });

  it('getState().warnings carries the creation warnings, [] before/after a session', async () => {
    expect(manager.getState().warnings).toEqual([]);
    const warnings = [{ code: 'DIARIZATION_MODEL_MISSING', stage: 'diarization', severity: 'WARNING', message: 'off', agentSlug: 'a' }];
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ sessionId: 's1', status: 'active', maxConcurrent: 1, currentActive: 1, wsUrl: '/ws', warnings }),
    );
    await manager.createSession({ agentSlug: 'a' });
    expect(manager.getState().warnings).toEqual(warnings);
    await manager.closeSession();
    expect(manager.getState().warnings).toEqual([]);
  });

  it('a 409 refusal is still an error and keeps the server message and code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: () => Promise.resolve({ code: 'ASR_AGENT_NO_MODEL', message: 'The agent names no speech model.' }),
      text: () => Promise.resolve('{}'),
      headers: new Headers({ 'content-type': 'application/json' }),
    } as Response);
    const err = (await manager.createSession({ agentSlug: 'a' }).catch((e) => e)) as AgenticError;
    expect(err).toBeInstanceOf(AgenticError);
    expect(err.message).toBe('The agent names no speech model.');
    expect(err.context?.code).toBe('ASR_AGENT_NO_MODEL');
  });
});
