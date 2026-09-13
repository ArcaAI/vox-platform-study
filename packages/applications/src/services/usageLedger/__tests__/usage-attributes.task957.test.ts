/**
 * TASK-957 F-8 — node identity on the workflow-lane ledger rows.
 *
 * The interpreter computes `workflow_version_id` / `node_id` per node and then
 * dropped both on the floor: the trajectory wire never carried them and
 * `attributesJson` had no key to put them in, so "which node of which
 * definition version spent this" was unanswerable from the ledger — `requestId
 * = runId` was the closest proxy, and it stops at the run.
 *
 * They are DIMENSIONS, not descriptions (the bar the module header sets): a
 * tenant asking why one workflow got expensive groups by node, and a platform
 * admin comparing two published versions groups by version. Both are opaque
 * ids or slugs, so the enum-ish shape check holds without a closed vocabulary —
 * a definition author names the nodes, and closing that set would reject a
 * legitimate graph rather than protect anything.
 */

import { describe, expect, it } from 'vitest';

import { USAGE_ATTRIBUTE_KEYS, validateUsageAttributes } from '../usage-attributes';

describe('usage-attributes — node identity (TASK-957 F-8)', () => {
  it('declares nodeId and workflowVersionId as string attributes', () => {
    expect(USAGE_ATTRIBUTE_KEYS.nodeId).toBe('string');
    expect(USAGE_ATTRIBUTE_KEYS.workflowVersionId).toBe('string');
  });

  it('accepts an interpreter node id and a workflow version id', () => {
    expect(
      validateUsageAttributes({
        nodeId: 'draft-note',
        workflowVersionId: '018f3c2a-1d3e-7b6a-9c4d-2f1e0a9b8c7d',
      }),
    ).toEqual([]);
  });

  it('rejects prose in either — they are ids, not a place to describe a node', () => {
    expect(validateUsageAttributes({ nodeId: 'draft the discharge note' })).toHaveLength(1);
    expect(validateUsageAttributes({ workflowVersionId: 'version 3, approved by Dr Lee' })).toHaveLength(1);
  });

  it('leaves both OPEN vocabularies — a tenant names its own nodes', () => {
    expect(validateUsageAttributes({ nodeId: 'a-node-nobody-predicted' })).toEqual([]);
  });
});
