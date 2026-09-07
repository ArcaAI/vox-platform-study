/**
 * TASK-893 §3.1 — which handles a node draws once the canvas shows two dots instead of fourteen.
 *
 * Asserted against the REAL registry (see `registry-fixture.ts`), because the whole claim of this
 * module is "the same ports, presented differently" — a hand-written fixture could only prove it
 * agrees with itself. The README's own arithmetic is the spec: four core types keep labelled
 * branch handles (`condition`, `classify`, `humanReview`, `loop`); the other seven become
 * single-dot; and `core.action`'s 7 declared inputs leave exactly one wire on the canvas.
 */
import { describe, expect, it } from 'vitest';
import { branchHandlesFor, primaryIoFor, secondaryInputsFor } from '../canvas-handles';
import { REGISTRY } from './registry-fixture';

const ids = (handles: { id: string }[]): string[] => handles.map((handle) => handle.id);
const names = (inputs: { name: string }[]): string[] => inputs.map((input) => input.name);

describe('primaryIoFor', () => {
  it('gives the graph BOUNDARIES only the dot they can honour', () => {
    // `core.trigger` declares no inputs at all — Contract A's own example of `hasInput: false`.
    expect(primaryIoFor(REGISTRY, 'core.trigger')).toEqual({ hasInput: false, hasOutput: true });
    // `core.output` declares no outputs — the terminal.
    expect(primaryIoFor(REGISTRY, 'core.output')).toEqual({ hasInput: true, hasOutput: false });
  });

  it('gives an ordinary node both dots', () => {
    expect(primaryIoFor(REGISTRY, 'core.agent')).toEqual({ hasInput: true, hasOutput: true });
    expect(primaryIoFor(REGISTRY, 'core.action')).toEqual({ hasInput: true, hasOutput: true });
  });

  // A dot is a PRESENTATION handle: `resolvePrimarySockets` decides whether the gesture becomes
  // `out -> in` or `next -> after`. So a node whose only way out is the ordering socket still
  // gets a dot — `core.start` (deprecated, but the entry of every seeded graph today) would
  // otherwise be unwireable on the canvas.
  it('counts the ORDERING sockets too, so an ordering-only node is still wireable', () => {
    expect(primaryIoFor(REGISTRY, 'core.start')).toEqual({ hasInput: false, hasOutput: true });
    expect(primaryIoFor(REGISTRY, 'core.end')).toEqual({ hasInput: true, hasOutput: false });
  });

  it('gives a canvas comment no dots at all, and an unknown type none either', () => {
    expect(primaryIoFor(REGISTRY, 'core.note')).toEqual({ hasInput: false, hasOutput: false });
    expect(primaryIoFor(REGISTRY, 'does.not.exist')).toEqual({ hasInput: false, hasOutput: false });
  });
});

describe('branchHandlesFor', () => {
  it('core.condition keeps `else` plus one handle per configured branch key', () => {
    const handles = branchHandlesFor(REGISTRY, 'core.condition', {
      branches: [{ key: 'urgent', when: 'trigger.priority > 3' }, { key: 'routine', when: 'true' }],
    });
    expect(ids(handles)).toEqual(['else', 'urgent', 'routine']);
    // Labels come from the SAME `humanizeKey` the inspector and palette use.
    expect(handles.map((handle) => handle.label)).toEqual(['Else', 'Urgent', 'Routine']);
  });

  it('core.classify keeps `otherwise` plus one handle per configured class', () => {
    const handles = branchHandlesFor(REGISTRY, 'core.classify', { classes: [{ key: 'safe' }, { key: 'unsafe' }] });
    expect(ids(handles)).toEqual(['otherwise', 'safe', 'unsafe']);
  });

  it('core.humanReview keeps its three static outcomes', () => {
    expect(ids(branchHandlesFor(REGISTRY, 'core.humanReview', {}))).toEqual(['approved', 'rejected', 'timedOut']);
  });

  // The one DATA case. `core.loop` declares no `out`, so `each`/`done` are the only ways anything
  // leaves it — collapsing them into a primary dot that does not exist would make a loop body
  // unreachable.
  it('core.loop keeps `each` and `done`, because it has no primary output to collapse them into', () => {
    expect(ids(branchHandlesFor(REGISTRY, 'core.loop', {}))).toEqual(['each', 'done']);
  });

  it('a node that HAS an `out` keeps its other data outputs off the canvas', () => {
    // `core.agent` declares out/data/transcript/audio; `core.action` declares six data outputs.
    // Both collapse to the single primary dot — the consumer binds the rest as secondary inputs.
    expect(branchHandlesFor(REGISTRY, 'core.agent', {})).toEqual([]);
    expect(branchHandlesFor(REGISTRY, 'core.action', {})).toEqual([]);
    expect(branchHandlesFor(REGISTRY, 'core.trigger', {})).toEqual([]);
    expect(branchHandlesFor(REGISTRY, 'core.variable', {})).toEqual([]);
    expect(branchHandlesFor(REGISTRY, 'core.data', {})).toEqual([]);
  });

  it('never treats a primary socket as a branch, even when `out` carries control', () => {
    // `consultation.consentGate` emits a control signal on a port NAMED `out` — a gate authorizes,
    // it does not produce data. That must stay the primary dot, not become a labelled branch.
    expect(branchHandlesFor(REGISTRY, 'consultation.consentGate', {})).toEqual([]);
  });

  it('README §3.1 arithmetic: exactly four of the eleven core types keep branch handles', () => {
    const coreTypes = [...REGISTRY.keys()].filter((type) => type.startsWith('core.') && !REGISTRY.get(type)?.deprecated);
    const withBranches = coreTypes.filter((type) => branchHandlesFor(REGISTRY, type, {}).length > 0);
    expect(withBranches.sort()).toEqual(['core.classify', 'core.condition', 'core.humanReview', 'core.loop']);
  });

  it('an unknown type has no handles', () => {
    expect(branchHandlesFor(REGISTRY, 'does.not.exist', {})).toEqual([]);
  });
});

describe('secondaryInputsFor', () => {
  it('core.action: 7 declared inputs, exactly one of which stays a wire', () => {
    const declared = REGISTRY.get('core.action')?.inputs ?? [];
    expect(declared).toHaveLength(7);

    const secondary = secondaryInputsFor(REGISTRY, 'core.action', {});
    expect(names(secondary)).toEqual(['text', 'transcript', 'entities', 'document', 'context']);
    // `in` stays on the canvas; `after` is ordering, never an inspector binding.
    expect(names(secondary)).not.toContain('in');
    expect(names(secondary)).not.toContain('after');
  });

  it('carries the primitive and required flag the inspector needs to render the field', () => {
    const context = secondaryInputsFor(REGISTRY, 'core.action', {}).find((input) => input.name === 'context');
    expect(context).toEqual({ name: 'context', primitive: 'context<schemaRef>', required: false });
  });

  it('resolves through a core.action DELEGATE rather than the generic superset', () => {
    // `consultation.sensors` takes `in: document` + `entities: entities`, so only `entities` is
    // secondary — not the six the generic `core.action` table declares.
    expect(names(secondaryInputsFor(REGISTRY, 'core.action', { actionKey: 'consultation.sensors' }))).toEqual(['entities']);
  });

  it('core.agent binds its context and audio inputs, keeping `in` as the wire', () => {
    expect(names(secondaryInputsFor(REGISTRY, 'core.agent', {}))).toEqual(['context', 'audio']);
  });

  it('a node with only a primary input has nothing to bind', () => {
    expect(secondaryInputsFor(REGISTRY, 'core.output', {})).toEqual([]);
    expect(secondaryInputsFor(REGISTRY, 'does.not.exist', {})).toEqual([]);
  });
});

describe('handle labels', () => {
  it('reads a camelCase / snake_case socket name as a title, via the shared humanizer', () => {
    expect(branchHandlesFor(REGISTRY, 'core.humanReview', {}).map((handle) => handle.label)).toEqual(['Approved', 'Rejected', 'Timed Out']);
    expect(branchHandlesFor(REGISTRY, 'core.classify', { classes: [{ key: 'visit_type' }] }).map((handle) => handle.label)).toEqual([
      'Otherwise',
      'Visit Type',
    ]);
  });

  it('keeps the handle id as the REAL wire port name, never the label', () => {
    // Contract A §2.1: the React Flow handle id IS the socket an edge will name.
    expect(ids(branchHandlesFor(REGISTRY, 'core.classify', { classes: [{ key: 'visit_type' }] }))).toEqual(['otherwise', 'visit_type']);
  });
});
