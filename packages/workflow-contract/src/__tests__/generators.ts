/**
 * A small deterministic PRNG (mulberry32) and a random-graph generator for the fuzz suite.
 * No new dependency — this package is permanently zero-runtime-dependency, and this file is
 * test-only code, never bundled into `dist/`.
 */
import type { WorkflowGraph } from '../graph-model';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ['core.start', 'core.end', 'x', 'consent.gate', 'summarization.generate', 'redact.phi'];

export interface RandomGraphOptions {
  maxNodes?: number;
  /** Probability [0,1] an edge is added between any ordered pair (i < j) of nodes. */
  edgeDensity?: number;
  /** When true, occasionally adds a back-edge (j -> i) to exercise cycle detection. */
  allowCycles?: boolean;
}

/** A random graph, always shape-valid (ids follow the grammar, no dangling edges). */
export function randomGraph(rand: () => number, options: RandomGraphOptions = {}): WorkflowGraph {
  const maxNodes = options.maxNodes ?? 20;
  const edgeDensity = options.edgeDensity ?? 0.15;
  const nodeCount = 1 + Math.floor(rand() * maxNodes);

  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n_${i}`,
    type: TYPES[Math.floor(rand() * TYPES.length)] as string,
    config: {},
  }));

  const edges: WorkflowGraph['edges'] = [];
  let edgeIndex = 0;
  for (let i = 0; i < nodeCount; i += 1) {
    for (let j = i + 1; j < nodeCount; j += 1) {
      if (rand() < edgeDensity) {
        edges.push({ id: `e_${edgeIndex++}`, from: `n_${i}`, fromPort: 'out', to: `n_${j}`, toPort: 'in' });
      }
      if (options.allowCycles && rand() < edgeDensity / 4) {
        edges.push({ id: `e_${edgeIndex++}`, from: `n_${j}`, fromPort: 'out', to: `n_${i}`, toPort: 'in' });
      }
    }
  }

  return { version: 1, nodes, edges };
}

/** Malformed-input generator — the totality fuzz target ( non-object nodes, self-edges, …). */
export function randomMalformedInput(rand: () => number): unknown {
  const choice = Math.floor(rand() * 7);
  switch (choice) {
    case 0:
      return undefined;
    case 1:
      return 42;
    case 2:
      return [];
    case 3:
      return { version: 1, nodes: 'nope', edges: [] };
    case 4:
      return { version: 1, nodes: [1, 2, 3], edges: null };
    case 5:
      return { version: 1, nodes: [{ id: 'a', type: 'x' }], edges: [{ id: 'e', from: 'a', fromPort: 'out', to: 'a', toPort: 'in' }] }; // self-edge
    default:
      return {
        version: 1,
        nodes: [
          { id: 'dup', type: 'x' },
          { id: 'dup', type: 'x' },
        ],
        edges: [],
      };
  }
}
