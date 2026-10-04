/**
 * TASK-1036 §10.2 — "Test input: only the controls the workflow can use", each saying why it is
 * there: Record when a speech-to-text step exists, Type a message when the Input shape has
 * `message`, Attach for the shape's file kinds.
 */
import { describe, expect, it } from 'vitest';
import { planTestInputs } from '../lib/test-inputs';

const ASR = { id: 'asr1', type: 'core.agent', config: { agentRef: { slug: 'asr-ml-en' }, label: 'Transcribe' } };
const WRITER = { id: 'w', type: 'core.agent', config: { agentRef: { slug: 'writer' }, label: 'Draft note' } };
const AGENTS = [
  { slug: 'asr-ml-en', name: 'ASR', task: 'SPEECH_TO_TEXT' },
  { slug: 'writer', name: 'Writer', task: 'TEXT_GENERATION' },
];
const DEFAULT_IO = {
  kinds: [
    { key: 'message', label: 'Message', primitive: 'TEXT', phiClass: 'PHI' },
    { key: 'documents', label: 'Documents', primitive: 'DOCUMENT', constraints: { mimeTypes: ['text/plain', 'application/pdf'] } },
    { key: 'images', label: 'Images', primitive: 'IMAGE', constraints: { mimeTypes: ['image/png'] } },
  ],
};

describe('planTestInputs', () => {
  it('offers Record only when a step is a speech-to-text agent, naming the step', () => {
    const plan = planTestInputs({ nodes: [ASR, WRITER], agentOptions: AGENTS, contextSchema: undefined });
    expect(plan.record).toEqual({ agentSlug: 'asr-ml-en', stepLabel: 'Transcribe', reason: 'Shown because “Transcribe” is a speech-to-text step.' });
    expect(planTestInputs({ nodes: [WRITER], agentOptions: AGENTS, contextSchema: undefined }).record).toBeNull();
  });

  it('offers Record for an Input shape that takes live audio even without an ASR step', () => {
    const plan = planTestInputs({ nodes: [WRITER], agentOptions: AGENTS, contextSchema: { kinds: [{ key: 'audio', label: 'Audio', primitive: 'STREAM_AUDIO' }] } });
    expect(plan.record).toMatchObject({ agentSlug: null, reason: 'Shown because the Input shape takes live audio (“Audio”).' });
  });

  it('offers a message box when the Input shape has `message`', () => {
    const plan = planTestInputs({ nodes: [WRITER], agentOptions: AGENTS, contextSchema: DEFAULT_IO });
    expect(plan.message).toEqual({ label: 'Message', reason: 'Shown because the Input shape accepts a message.' });
    expect(planTestInputs({ nodes: [WRITER], agentOptions: AGENTS, contextSchema: { kinds: [] } }).message).toBeNull();
  });

  it('offers Attach for the file kinds with their allowed types', () => {
    const plan = planTestInputs({ nodes: [WRITER], agentOptions: AGENTS, contextSchema: DEFAULT_IO });
    expect(plan.attach).toEqual({
      mimeTypes: ['text/plain', 'application/pdf', 'image/png'],
      reason: 'Shown because the Input shape accepts Documents and Images.',
    });
  });

  it('lists the remaining kinds for the JSON input and says whether the shape is known', () => {
    const plan = planTestInputs({
      nodes: [WRITER],
      agentOptions: AGENTS,
      contextSchema: { kinds: [...DEFAULT_IO.kinds, { key: 'vitals', label: 'Vitals', primitive: 'STRUCTURED' }] },
    });
    expect(plan.extraKinds).toEqual([{ key: 'vitals', label: 'Vitals', primitive: 'STRUCTURED' }]);
    expect(plan.schemaKnown).toBe(true);
    expect(planTestInputs({ nodes: [WRITER], agentOptions: AGENTS, contextSchema: undefined }).schemaKnown).toBe(false);
  });
});
