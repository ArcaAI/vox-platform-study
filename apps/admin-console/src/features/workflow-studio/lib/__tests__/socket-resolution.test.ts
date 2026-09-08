/**
 * TASK-893 §3.1 — one user-drawn link, resolved to the two wire sockets it means.
 *
 * Asserted against the REAL registry (`registry-fixture.ts`). The load-bearing case is the last
 * describe block: collapsing the PRESENTATION of the sockets must not widen the compatibility
 * lattice, so `consultation.synthesize -> consultation.extractEntities` (`document -> transcript`,
 * the anti-hallucination-laundering pair) must still not become a data edge. It degrades to an
 * ORDERING edge, which carries no payload — the resolution the collapse is allowed to make.
 */
import { describe, expect, it } from 'vitest';
import { resolvePrimarySockets } from '../socket-resolution';
import { checkPortCompatibility } from '../port-compatibility';
import { REGISTRY, at } from './registry-fixture';

describe('the primary data pair', () => {
  it('resolves out -> in when the produced type satisfies the consumed one', () => {
    // `core.trigger.out` is `context<schemaRef>`, which widens to `core.action.in`'s `object`.
    expect(resolvePrimarySockets(REGISTRY, at('core.trigger'), at('core.action'))).toEqual({ sourceHandle: 'out', targetHandle: 'in' });
  });

  it('resolves into an `any` consumer', () => {
    expect(resolvePrimarySockets(REGISTRY, at('core.trigger'), at('core.output'))).toEqual({ sourceHandle: 'out', targetHandle: 'in' });
  });

  it('resolves through a core.action DELEGATE, not its generic superset', () => {
    // `core.agent.transcript` is `transcript`; delegating `core.action` to
    // `consultation.phiHop` gives it that delegate's `in: transcript`.
    expect(resolvePrimarySockets(REGISTRY, at('core.agent'), at('core.action', { actionKey: 'consultation.phiHop' }), 'transcript')).toEqual({
      sourceHandle: 'transcript',
      targetHandle: 'in',
    });
    // Without the hint the agent's PRIMARY output is `out: text`, which the delegate's
    // `in: transcript` refuses — so the pair degrades to an ordering edge rather than widening.
    expect(resolvePrimarySockets(REGISTRY, at('core.agent'), at('core.action', { actionKey: 'consultation.phiHop' }))).toEqual({
      sourceHandle: 'next',
      targetHandle: 'after',
    });
  });
});

describe('the control fallback', () => {
  it('falls back to next -> after when the TARGET has no data input', () => {
    // A gate emits a control signal, and `session.timeout` declares `after` only.
    expect(
      resolvePrimarySockets(REGISTRY, at('core.action', { actionKey: 'consultation.consentGate' }), at('core.action', { actionKey: 'session.timeout' })),
    ).toEqual({
      sourceHandle: 'next',
      targetHandle: 'after',
    });
  });

  it('falls back to next -> after when the SOURCE has no data output', () => {
    // `consultation.finalizeAssurance` produces `contextItemId` and `next` — no `out` at all.
    expect(resolvePrimarySockets(REGISTRY, at('core.action', { actionKey: 'consultation.finalizeAssurance' }), at('core.agent'))).toEqual({
      sourceHandle: 'next',
      targetHandle: 'after',
    });
  });

  it('falls back when the two primary data ports exist but are incompatible', () => {
    // `core.trigger.out` is `context<schemaRef>`; `core.agent.in` is `text`. Nothing widens
    // an object into text, so the link becomes an ordering edge and the agent's context is
    // bound in the inspector instead (README §3.1's "Context <- (1) Trigger").
    expect(resolvePrimarySockets(REGISTRY, at('core.trigger'), at('core.agent'))).toEqual({ sourceHandle: 'next', targetHandle: 'after' });
  });
});

describe('null — these two nodes cannot be linked at all', () => {
  it('a terminal has nothing to link FROM', () => {
    expect(resolvePrimarySockets(REGISTRY, at('core.output'), at('core.agent'))).toBeNull();
  });

  it('an entry has nothing to link TO', () => {
    expect(resolvePrimarySockets(REGISTRY, at('core.agent'), at('core.trigger'))).toBeNull();
  });

  it('a canvas comment links to nothing in either direction', () => {
    expect(resolvePrimarySockets(REGISTRY, at('core.note'), at('core.agent'))).toBeNull();
    expect(resolvePrimarySockets(REGISTRY, at('core.agent'), at('core.note'))).toBeNull();
  });

  it('an unknown node type resolves to nothing rather than guessing', () => {
    expect(resolvePrimarySockets(REGISTRY, at('does.not.exist'), at('core.agent'))).toBeNull();
    expect(resolvePrimarySockets(REGISTRY, at('core.agent'), at('does.not.exist'))).toBeNull();
  });
});

describe('sourceHandleHint — the branch the user actually grabbed', () => {
  it('pins a control branch handle and takes the ordering input', () => {
    const resolved = resolvePrimarySockets(
      REGISTRY,
      at('core.condition', { branches: [{ key: 'urgent', when: 'true' }] }),
      at('core.agent'),
      'urgent',
    );
    expect(resolved).toEqual({ sourceHandle: 'urgent', targetHandle: 'after' });
  });

  it('pins a DATA branch handle and takes the data input', () => {
    // The loop's `each` is `object`, and `core.action.in` is `object`.
    expect(resolvePrimarySockets(REGISTRY, at('core.loop'), at('core.action'), 'each')).toEqual({ sourceHandle: 'each', targetHandle: 'in' });
  });

  it('wins over the default pair — a hinted handle is never silently re-resolved to `out`', () => {
    const resolved = resolvePrimarySockets(REGISTRY, at('core.humanReview'), at('core.agent'), 'approved');
    expect(resolved).toEqual({ sourceHandle: 'approved', targetHandle: 'after' });
  });

  it('returns null rather than redirecting when nothing on the target fits the hinted handle', () => {
    // `core.loop.each` is `object`; `core.agent.in` is `text` and its only other input is
    // ordering. Landing this on `out` instead would be a different graph than the user drew.
    expect(resolvePrimarySockets(REGISTRY, at('core.loop'), at('core.agent'), 'each')).toBeNull();
  });

  it('ignores a hint that names no real output port', () => {
    expect(resolvePrimarySockets(REGISTRY, at('core.trigger'), at('core.action'), 'not-a-handle')).toEqual({ sourceHandle: 'out', targetHandle: 'in' });
    expect(resolvePrimarySockets(REGISTRY, at('core.trigger'), at('core.action'), null)).toEqual({ sourceHandle: 'out', targetHandle: 'in' });
  });
});

describe('ANTI-LAUNDERING — the collapse must not widen the lattice', () => {
  // `consultation.sensors` hands out a `document`; `consultation.phiHop` takes only a
  // `transcript`. Both are actions since Phase 4, so the pair is expressed through `core.action`.
  const SOURCE = at('core.action', { actionKey: 'consultation.sensors' });
  const TARGET = at('core.action', { actionKey: 'consultation.phiHop' });

  it('never proposes the document -> transcript data pair', () => {
    const resolved = resolvePrimarySockets(REGISTRY, SOURCE, TARGET);
    expect(resolved).not.toEqual({ sourceHandle: 'out', targetHandle: 'in' });
    // It degrades to an ORDERING edge, which carries no payload — so the generated document
    // still cannot reach the NER node's `transcript` input by any route.
    expect(resolved).toEqual({ sourceHandle: 'next', targetHandle: 'after' });
  });

  it('and the lattice still refuses that pair directly, unchanged', () => {
    const verdict = checkPortCompatibility(
      REGISTRY,
      { type: SOURCE.type, handle: 'out', config: SOURCE.config },
      { type: TARGET.type, handle: 'in', config: TARGET.config },
    );
    expect(verdict.ok).toBe(false);
  });

  it('every pair it DOES propose is one `checkPortCompatibility` accepts', () => {
    const types = [...REGISTRY.keys()];
    for (const sourceType of types) {
      for (const targetType of types) {
        const resolved = resolvePrimarySockets(REGISTRY, at(sourceType), at(targetType));
        if (!resolved) continue;
        const verdict = checkPortCompatibility(
          REGISTRY,
          { type: sourceType, handle: resolved.sourceHandle, config: {} },
          { type: targetType, handle: resolved.targetHandle, config: {} },
        );
        expect(verdict, `${sourceType}.${resolved.sourceHandle} -> ${targetType}.${resolved.targetHandle}`).toEqual({ ok: true });
      }
    }
  });
});

/**
 * TASK-893 integration — the canvas renders the primary output with the literal handle id `out`
 * (Contract A), so React Flow reports `sourceHandle: 'out'` for EVERY ordinary link and the
 * editor forwards it as the hint. Before this was handled, that pinned resolution to the data
 * pair and made the ordering fallback unreachable: the anti-laundering pair below was refused
 * outright instead of degrading. Lane A predicted it from the canvas side; Lane D's own sweep ran
 * hint-free and could not see it. Every case here is the hinted twin of one above, and must agree.
 */
describe('the primary handle id is not an explicit grab', () => {
  const SOURCE = at('core.action', { actionKey: 'consultation.sensors' });
  const TARGET = at('core.action', { actionKey: 'consultation.phiHop' });

  it('still degrades the anti-laundering pair to an ordering edge when hinted with `out`', () => {
    expect(resolvePrimarySockets(REGISTRY, SOURCE, TARGET, 'out')).toEqual({ sourceHandle: 'next', targetHandle: 'after' });
  });

  it('resolves the data pair identically with and without the `out` hint', () => {
    const unhinted = resolvePrimarySockets(REGISTRY, at('core.trigger'), at('core.action'));
    expect(resolvePrimarySockets(REGISTRY, at('core.trigger'), at('core.action'), 'out')).toEqual(unhinted);
  });

  it('agrees with the unhinted answer for every pair in the registry', () => {
    const types = [...REGISTRY.keys()];
    for (const sourceType of types) {
      for (const targetType of types) {
        const unhinted = resolvePrimarySockets(REGISTRY, at(sourceType), at(targetType));
        const hinted = resolvePrimarySockets(REGISTRY, at(sourceType), at(targetType), 'out');
        expect(hinted, `${sourceType} -> ${targetType}`).toEqual(unhinted);
      }
    }
  });

  it('a REAL branch grab is still fixed to the socket the user took', () => {
    // `core.condition.else` is a control branch: it may only ever land on an ordering input, and
    // must never be silently re-resolved to the node's `out`.
    expect(resolvePrimarySockets(REGISTRY, at('core.condition'), at('core.action'), 'else')).toEqual({
      sourceHandle: 'else',
      targetHandle: 'after',
    });
  });
});
