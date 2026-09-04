import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CORE_NODE_RENDERERS } from '../core-node-renderers';

const base = { id: 'n', label: 'x', position: { x: 0, y: 0 } };

describe('CORE_NODE_RENDERERS', () => {
  it.each([
    ['core.trigger', { kinds: ['api', 'webhook'] }, /api, webhook/],
    ['core.agent', { agentRef: { slug: 'platform-summarization' }, execution: { lane: 'realtime' } }, /platform-summarization/],
    ['core.classify', { classes: [{ key: 'safe' }, { key: 'unsafe' }] }, /safe · unsafe/],
    ['core.condition', { branches: [{ key: 'urgent' }] }, /urgent · else/],
    ['core.loop', { mode: 'foreach', bounds: { maxIterations: 5 } }, /foreach · max 5/],
    ['core.humanReview', { timeoutSeconds: 3600 }, /3600s/],
    ['core.variable', { variables: [{ key: 'count' }] }, /vars\.count/],
    ['core.output', { protocols: ['http', 'socket'] }, /http, socket/],
    ['core.note', { text: 'hello' }, /hello/],
    ['core.action', { actionKey: 'consultation.phiHop' }, /consultation\.phiHop/],
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
});
