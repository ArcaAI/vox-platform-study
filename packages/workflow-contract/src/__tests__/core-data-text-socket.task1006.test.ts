/**
 * TASK-1006 (A-2) — `core.data` publishes a `text` socket.
 *
 * The trigger's only data socket is `out: context<schemaRef>`, which widens to `object` and
 * never to `text`, so before this ticket no `core` node could lift a TEXT kind a caller supplied
 * (a finished transcript) onto an agent's `in: text`. `core.data` is the deterministic reshape
 * node; its `text` socket carries the reshaped output's `text` field, and nothing else.
 *
 * The lattice is untouched: `text` is a ROOT, so the socket feeds `text` (and `any`) consumers
 * only — never `transcript`, `document` or `object`.
 */
import { describe, expect, it } from 'vitest';
import { NODE_PORTS } from '../node-ports';
import { isValidConnection } from '../port-validation';

describe('core.data — the `text` socket', () => {
  it('declares an optional, multi-edge `text` output carried under the runtime key `text`', () => {
    const socket = NODE_PORTS['core.data']!.outputs.find((port) => port.name === 'text');
    expect(socket).toEqual({ name: 'text', primitive: 'text', required: false, multiple: true, outputKey: 'text' });
  });

  it('keeps `out` as the primary object socket', () => {
    expect(NODE_PORTS['core.data']!.outputs.map((port) => port.name)).toEqual(['out', 'text', 'next']);
  });

  it('feeds an agent `in` (text) — the trigger → data → agent path a text transcript takes', () => {
    expect(isValidConnection('core.trigger', 'out', 'core.data', 'in')).toBe(true);
    expect(isValidConnection('core.data', 'text', 'core.agent', 'in')).toBe(true);
    // Still refused: the trigger's object straight into a text input.
    expect(isValidConnection('core.trigger', 'out', 'core.agent', 'in')).toBe(false);
  });

  it('never narrows: `text` does not satisfy a transcript, document or object input', () => {
    expect(isValidConnection('core.data', 'text', 'core.action', 'transcript')).toBe(false);
    expect(isValidConnection('core.data', 'text', 'core.data', 'in')).toBe(false);
    expect(isValidConnection('core.data', 'text', 'core.agent', 'context')).toBe(false);
  });
});
