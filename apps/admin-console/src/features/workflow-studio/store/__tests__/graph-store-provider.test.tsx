/**
 * `GraphStoreProvider` — mirrors rule 08 §Store's "the store is not
 * reachable without a provider" contract.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GraphStoreProvider, useGraphStore, useGraphStoreApi } from '../graph-store-provider';
import { findingsByNodeId, selectNodes } from '../selectors';
import type { WorkflowFinding } from '../../api/types';

describe('GraphStoreProvider', () => {
  it('useGraphStore throws outside a provider', () => {
    expect(() => renderHook(() => useGraphStore(selectNodes))).toThrow(/GraphStoreProvider/);
  });

  it('useGraphStoreApi throws outside a provider', () => {
    expect(() => renderHook(() => useGraphStoreApi())).toThrow(/GraphStoreProvider/);
  });

  it('a mount gets an isolated store — two providers never share state', () => {
    const first = renderHook(() => useGraphStoreApi(), { wrapper: GraphStoreProvider });
    const second = renderHook(() => useGraphStoreApi(), { wrapper: GraphStoreProvider });
    first.result.current.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    expect(first.result.current.getState().nodes).toHaveLength(1);
    expect(second.result.current.getState().nodes).toHaveLength(0);
  });

  it('useGraphStore(selector) reads reactively inside a provider', () => {
    const { result } = renderHook(() => useGraphStore(selectNodes), { wrapper: GraphStoreProvider });
    expect(result.current).toEqual([]);
  });
});

describe('findingsByNodeId', () => {
  it('groups findings per node and keeps graph-level findings under the null key', () => {
    const findings: WorkflowFinding[] = [
      { ruleId: 'WF-C-001', ruleClass: 'schema', severity: 'ERROR', nodeId: 'n1', message: 'bad config' },
      { ruleId: 'WF-I-006', ruleClass: 'invariant', severity: 'WARNING', nodeId: 'n1', message: 'unreachable soon' },
      { ruleId: 'WF-S-001', ruleClass: 'structural', severity: 'ERROR', nodeId: null, message: 'cycle detected' },
    ];
    const grouped = findingsByNodeId(findings);
    expect(grouped.get('n1')).toHaveLength(2);
    expect(grouped.get(null)).toHaveLength(1);
  });
});
