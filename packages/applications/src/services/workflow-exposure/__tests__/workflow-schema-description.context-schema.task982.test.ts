/**
 * `GET /workflows/{slug}/schema` names WHICH context-schema version types its Input, and WHERE a
 * run will stop for a human.
 *
 * Both were previously undiscoverable from the description, and each had a concrete consequence:
 *
 *  - the Input component was typed from the frozen payload schema with no hint of where that
 *    schema came from, so a client generating types off the catalogue could not tell a pinned
 *    workflow from one that follows the tenant's pin — which is exactly the difference between
 *    "a schema publish will reach me" and "it will not";
 *  - `workflows.reviews.get/decide` need a `nodeId`, and nothing in the published contract said
 *    what the review nodes were called. An integrator had to be told out of band.
 */
import { describe, expect, it } from 'vitest';
import { describeWorkflow, reviewNodesOf } from '../workflow-schema-description';

const REVIEW_GRAPH = {
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] } },
    { id: 'gate_clinician', type: 'core.humanReview', config: { reviewType: 'approval', label: 'Clinician sign-off' } },
    { id: 'a1', type: 'core.agent', config: {} },
    { id: 'gate_2', type: 'core.humanReview', config: { reviewType: 'approval' } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] } },
  ],
};

describe('reviewNodesOf', () => {
  it('lists every core.humanReview node in graph order, labelled', () => {
    expect(reviewNodesOf(REVIEW_GRAPH)).toEqual([
      { nodeId: 'gate_clinician', label: 'Clinician sign-off' },
      { nodeId: 'gate_2', label: 'gate_2' },
    ]);
  });

  it('falls back to `name` before the node id', () => {
    const graph = { nodes: [{ id: 'gate', type: 'core.humanReview', config: { name: 'Pharmacy check' } }] };
    expect(reviewNodesOf(graph)).toEqual([{ nodeId: 'gate', label: 'Pharmacy check' }]);
  });

  it('is empty for a graph with no review node', () => {
    expect(reviewNodesOf({ nodes: [{ id: 't1', type: 'core.trigger', config: {} }] })).toEqual([]);
  });
});

describe('describeWorkflow — contextSchema and reviewNodes', () => {
  it('reports the binding it was handed, followsLatest included', () => {
    const described = describeWorkflow('triage', 3, REVIEW_GRAPH, undefined, {
      schemaId: 'schema-1',
      slug: 'general_medicine_context',
      versionNumber: 2,
      followsLatest: true,
    });

    expect(described.contextSchema).toEqual({
      schemaId: 'schema-1',
      slug: 'general_medicine_context',
      versionNumber: 2,
      followsLatest: true,
    });
    expect(described.reviewNodes).toEqual([
      { nodeId: 'gate_clinician', label: 'Clinician sign-off' },
      { nodeId: 'gate_2', label: 'gate_2' },
    ]);
  });

  it('reports a null binding for a definition that references no schema', () => {
    const described = describeWorkflow('triage', 3, REVIEW_GRAPH);
    expect(described.contextSchema).toBeNull();
    expect(described.reviewNodes).toHaveLength(2);
  });
});
