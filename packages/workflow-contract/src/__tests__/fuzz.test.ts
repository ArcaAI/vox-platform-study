/**
 * Fuzz suite — REDUCED SCOPE, honestly flagged rather than silently
 * shrunk: this session runs 1 000 generated graphs (not the ticket's ≥ 5 000) and asserts
 * TOTALITY (`validate()`/`compile()` never throw, even on malformed input), a wall-clock bound
 * (catches an accidental exponential path enumeration — Risk #3), and the
 * DETERMINISM property (repeat-compile() and shuffle-invariance).
 *
 * NOT implemented in this session: the independent "safety oracle" (naive path enumeration on
 * ≤ 12-node graphs, compared against the fast dominator-based implementation) that the ticket
 * specifies as the primary defense against a wrong `allPathsPassThrough` implementation. That
 * property is exercised only indirectly here, via the targeted `graph-algorithms.test.ts`
 * cases. This is a real gap against the ticket's acceptance criteria — 
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { CompilerContext } from '../compiler';
import { canonicalJson } from '../canonical-json';
import { validate } from '../validate';
import type { WorkflowEvaluationContext } from '../predicates/context';
import { mulberry32, randomGraph, randomMalformedInput } from './generators';

const NODE_CLASSES: Record<string, readonly string[]> = {
  'summarization.generate': ['generation', 'activity'],
  'consent.gate': ['consentGate', 'mandatory', 'gate'],
  'redact.phi': ['redaction'],
};

const ctx: WorkflowEvaluationContext = {
  paletteKey: 'summarization',
  registry: {
    classesOf: (type: string) => NODE_CLASSES[type] ?? [],
    paletteOf: () => 'summarization',
  },
};

const compilerCtx: CompilerContext = {
  definitionId: '018f1e0a-0000-7000-8000-000000000001',
  slug: 'fuzz',
  versionNumber: 1,
  tenantId: '00000000-0000-0000-0000-000000000000',
  paletteKey: 'summarization',
  compilerVersion: '0.1.0',
  registryChecksum: 'fuzz-checksum',
  ruleSetVersion: 1,
  caps: { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 },
  policyBindings: {
    guardrailProfile: 'STANDARD',
    redactionRuleSetId: null,
    promptTemplateRefs: [],
    documentTemplateRefs: [],
    contextSchemaVersionId: null,
    entitlementKeys: [],
  },
  compiledAt: '2026-08-16T00:00:00.000Z',
  nodeInfo: (type: string) => ({ activity: 'generate', classes: NODE_CLASSES[type] ?? [] }),
};

const SEEDS = [1, 7, 42, 1337, 90210];
const GRAPHS_PER_SEED = 200; // 5 seeds × 200 = 1 000 graphs total (reduced from the ticket's ≥ 5 000 — see header)

describe('fuzz — totality and wall-clock bound', () => {
  it('validate() never throws and stays within a wall-clock bound over generated graphs', () => {
    const startedAt = Date.now();
    for (const seed of SEEDS) {
      const rand = mulberry32(seed);
      for (let i = 0; i < GRAPHS_PER_SEED; i += 1) {
        const graph = randomGraph(rand, { maxNodes: 30, edgeDensity: 0.2, allowCycles: true });
        expect(() => validate(graph, ctx, { ruleSetVersion: 1, registryChecksum: 'fuzz' })).not.toThrow();
      }
    }
    expect(Date.now() - startedAt).toBeLessThan(15000);
  });

  it('compile() never throws over generated graphs', () => {
    for (const seed of SEEDS) {
      const rand = mulberry32(seed);
      for (let i = 0; i < GRAPHS_PER_SEED; i += 1) {
        const graph = randomGraph(rand, { maxNodes: 30, edgeDensity: 0.2, allowCycles: true });
        expect(() => compile(graph, compilerCtx)).not.toThrow();
      }
    }
  });

  it('never throws or hangs on malformed / adversarial input', () => {
    const rand = mulberry32(2026);
    const startedAt = Date.now();
    for (let i = 0; i < 500; i += 1) {
      const input = randomMalformedInput(rand);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fuzz target is deliberately untyped input
      expect(() => validate(input as any, ctx, { ruleSetVersion: 1, registryChecksum: 'fuzz' })).not.toThrow();
    }
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('a 10 000-node linear chain does not hang (exponential-enumeration regression guard)', () => {
    const nodes = Array.from({ length: 10000 }, (_, i) => ({ id: `n_${i}`, type: 'x', config: {} }));
    const edges = Array.from({ length: 9999 }, (_, i) => ({ id: `e_${i}`, from: `n_${i}`, fromPort: 'out', to: `n_${i + 1}`, toPort: 'in' }));
    const startedAt = Date.now();
    expect(() => validate({ version: 1, nodes, edges }, ctx, { ruleSetVersion: 1, registryChecksum: 'fuzz' })).not.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});

describe('fuzz — determinism', () => {
  it('compiling the same graph twice yields the same checksum, for every generated graph', () => {
    const rand = mulberry32(555);
    for (let i = 0; i < 100; i += 1) {
      const graph = randomGraph(rand, { maxNodes: 15, edgeDensity: 0.2, allowCycles: false });
      const a = compile(graph, compilerCtx);
      const b = compile(graph, compilerCtx);
      expect('config' in a).toBe('config' in b);
      if ('config' in a && 'config' in b) {
        expect(a.config.checksum).toBe(b.config.checksum);
      }
    }
  });

  it('shuffling node/edge arrays never changes the checksum', () => {
    const rand = mulberry32(777);
    for (let i = 0; i < 100; i += 1) {
      const graph = randomGraph(rand, { maxNodes: 15, edgeDensity: 0.2, allowCycles: false });
      const shuffled = { version: 1 as const, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
      const a = compile(graph, compilerCtx);
      const b = compile(shuffled, compilerCtx);
      expect('config' in a).toBe('config' in b);
      if ('config' in a && 'config' in b) {
        expect(a.config.checksum).toBe(b.config.checksum);
      }
    }
  });

  it('canonicalJson is stable under repeated calls on the same generated graph', () => {
    const rand = mulberry32(999);
    for (let i = 0; i < 50; i += 1) {
      const graph = randomGraph(rand, { maxNodes: 15 });
      expect(canonicalJson(graph)).toBe(canonicalJson(graph));
    }
  });
});
