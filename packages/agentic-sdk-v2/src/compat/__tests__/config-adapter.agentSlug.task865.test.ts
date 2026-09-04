/**
 * v1 config adapter — `sttAgentSlug` replaces `sttPipelineId` (TASK-865).
 *
 * A migrated v1 app names the tenant's ASR Agent; the deprecated pipeline id is
 * still honoured alone, and when both are set the agent wins and the pipeline id
 * is NOT emitted — the session body must never carry both selectors.
 */
import { describe, it, expect } from 'vitest';
import { mapV1ConfigToAgenticConfig } from '../config-adapter';

const BASE = { apiEndpoint: 'https://api.example.com', websocketUrl: 'wss://api.example.com', credentials: { apiKey: 'k' } } as const;

describe('mapV1ConfigToAgenticConfig — ASR Agent selection', () => {
  it('maps sttAgentSlug onto stt.agentSlug with the backend provider, and no pipelineId', () => {
    const cfg = mapV1ConfigToAgenticConfig({ ...BASE, sttAgentSlug: 'clinic-asr' });
    expect(cfg.audio?.stt).toMatchObject({ enabled: true, provider: 'backend', agentSlug: 'clinic-asr' });
    expect((cfg.audio?.stt as { pipelineId?: string }).pipelineId).toBeUndefined();
  });

  it('still maps a bare sttPipelineId (deprecated path) exactly as before', () => {
    const cfg = mapV1ConfigToAgenticConfig({ ...BASE, sttPipelineId: 'legacy-pipe' });
    expect(cfg.audio?.stt).toMatchObject({ enabled: true, provider: 'backend', pipelineId: 'legacy-pipe' });
    expect((cfg.audio?.stt as { agentSlug?: string }).agentSlug).toBeUndefined();
  });

  it('sttAgentSlug WINS when both are set — the pipeline id is not emitted', () => {
    const cfg = mapV1ConfigToAgenticConfig({ ...BASE, sttPipelineId: 'legacy-pipe', sttAgentSlug: 'clinic-asr' });
    const stt = cfg.audio?.stt as { agentSlug?: string; pipelineId?: string };
    expect(stt.agentSlug).toBe('clinic-asr');
    expect(stt.pipelineId).toBeUndefined();
  });

  it('emits no audio config when neither selector nor audioSettings is given (defaults apply: client stages OFF)', () => {
    expect(mapV1ConfigToAgenticConfig({ ...BASE }).audio).toBeUndefined();
  });
});
