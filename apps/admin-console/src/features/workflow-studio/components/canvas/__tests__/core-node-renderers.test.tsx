import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CORE_NODE_RENDERERS, NodeCaptionProvider } from '../core-node-renderers';

const base = { id: 'n', label: 'x', position: { x: 0, y: 0 } };

describe('CORE_NODE_RENDERERS', () => {
  it.each([
    ['core.trigger', { kinds: ['api', 'webhook'] }, /api, webhook/],
    ['core.agent', { agentRef: { slug: 'platform-summarization' }, execution: { lane: 'realtime' } }, /^Agent · live$/],
    ['core.classify', { classes: [{ key: 'safe' }, { key: 'unsafe' }] }, /safe · unsafe/],
    ['core.condition', { branches: [{ key: 'urgent' }] }, /urgent · else/],
    ['core.loop', { mode: 'foreach', bounds: { maxIterations: 5 } }, /foreach · max 5/],
    ['core.humanReview', { timeoutSeconds: 3600 }, /3600s/],
    ['core.variable', { variables: [{ key: 'count' }] }, /vars\.count/],
    ['core.output', { protocols: ['http', 'socket'] }, /http, socket/],
    ['core.note', { text: 'hello' }, /hello/],
    ['core.action', { actionKey: 'consultation.consentGate' }, /consent before any clinical processing/],
    ['core.data', { mappings: [{ from: 'a', to: 'b' }] }, /1 mapping/],
  ])('%s summarises its config', (type, config, expected) => {
    const Renderer = CORE_NODE_RENDERERS[type];
    const { container } = render(<Renderer node={{ ...base, type, config }} selected={false} />);
    expect(container.textContent).toMatch(expected);
  });

  it('covers every core type with a renderer', () => {
    expect(Object.keys(CORE_NODE_RENDERERS).sort()).toEqual(
      ['core.action', 'core.agent', 'core.classify', 'core.condition', 'core.data', 'core.humanReview', 'core.loop', 'core.note', 'core.output', 'core.trigger', 'core.variable'],
    );
  });

  // TASK-1036 (owner, 2026-10-05) — the card's subtitle says what the step DOES, in words: never
  // the agent's slug, the "realtime lane" key or an action key.
  it('an agent step says its task in words, and "live" on the realtime lane', () => {
    const Renderer = CORE_NODE_RENDERERS['core.agent'];
    const { container } = render(
      <NodeCaptionProvider agents={{ 'case-notes-pre-summary': { task: 'SPEECH_TO_TEXT' } }}>
        <Renderer node={{ ...base, type: 'core.agent', config: { agentRef: { slug: 'case-notes-pre-summary' }, execution: { lane: 'realtime' } } }} selected={false} />
      </NodeCaptionProvider>,
    );
    expect(container.textContent).toBe('Speech to text · live');
    expect(container.textContent).not.toMatch(/case-notes|lane/);
  });

  it('a background agent step says only its task', () => {
    const Renderer = CORE_NODE_RENDERERS['core.agent'];
    const { container } = render(
      <NodeCaptionProvider agents={{ writer: { task: 'TEXT_GENERATION' } }}>
        <Renderer node={{ ...base, type: 'core.agent', config: { agentRef: { slug: 'writer' } } }} selected={false} />
      </NodeCaptionProvider>,
    );
    expect(container.textContent).toBe('Text generation');
  });

  it('an action step shows the action’s purpose, not its key', () => {
    const Renderer = CORE_NODE_RENDERERS['core.action'];
    const { container } = render(<Renderer node={{ ...base, type: 'core.action', config: { actionKey: 'consultation.consentGate' } }} selected={false} />);
    expect(container.textContent).not.toContain('consultation.consentGate');
  });
});
