import { describe, expect, it } from 'vitest';
import { nameNodesInMessage, unpublishedPinFindings } from '../pin-findings';

const pin = (versionNumber: number | null) => ({ nodeId: 'n_7', nodeLabel: 'Draft note', agentSlug: 'soap', versionNumber });
const option = (versionNumber: number) => ({ slug: 'soap', name: 'SOAP', task: 'TEXT_GENERATION', versionNumber });

describe('unpublishedPinFindings', () => {
  it('warns on a pinned version that is not in the published list, naming the step', () => {
    const [finding] = unpublishedPinFindings([pin(3)], [option(1), option(2)]);
    expect(finding.severity).toBe('WARNING');
    expect(finding.nodeId).toBe('n_7');
    expect(finding.message).toContain('Draft note');
    expect(finding.message).toContain('soap v3');
  });
  it('is silent for published pins, unpinned steps and an unloaded agent list', () => {
    expect(unpublishedPinFindings([pin(2)], [option(2)])).toEqual([]);
    expect(unpublishedPinFindings([pin(null)], [option(2)])).toEqual([]);
    expect(unpublishedPinFindings([pin(3)], [])).toEqual([]);
  });
});

describe('nameNodesInMessage', () => {
  it('replaces node ids with the step label', () => {
    expect(nameNodesInMessage('Node n_7 pins an unpublished agent', new Map([['n_7', 'Draft note']]))).toBe('Node “Draft note” pins an unpublished agent');
  });
});
