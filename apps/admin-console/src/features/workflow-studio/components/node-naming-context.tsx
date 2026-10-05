'use client';

/**
 * TASK-1036 (owner, 2026-10-05) — the naming context every Studio surface reads to call a step by
 * its friendly name (`lib/node-identity.ts`): the agents' display names from the catalogue. The
 * editor provides it once from the SAME cached `GET admin/agents` query the composer and the agent
 * picker run, so the inspector, the Problems panel, the Test tab, the pins and the binding picker
 * never fetch it again. Outside a provider (a component rendered on its own) the naming is empty
 * and an agent step reads as its slug in words — still never an id.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { NodeNaming } from '../lib/node-identity';

const NO_NAMING: NodeNaming = {};
const NodeNamingContext = createContext<NodeNaming>(NO_NAMING);

export function NodeNamingProvider({ naming, children }: { naming: NodeNaming; children: ReactNode }) {
  return <NodeNamingContext.Provider value={naming}>{children}</NodeNamingContext.Provider>;
}

export function useNodeNamingContext(): NodeNaming {
  return useContext(NodeNamingContext);
}
