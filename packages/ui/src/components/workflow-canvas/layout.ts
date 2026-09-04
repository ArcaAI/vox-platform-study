/**
 * Auto-layout for the workflow canvas (TASK-864 B1). Pure: no DOM, no React, no I/O — so it is
 * unit-tested exhaustively and runs identically in the Studio and in a test.
 *
 * Two engines behind one function:
 *
 * 1. An injectable ELK-shaped engine (`options.engine`) — anything exposing
 *    `layout(graph)` over ELK's JSON graph, i.e. `new ELK()` from `elkjs/lib/elk.bundled.js`.
 *    The dependency is declared in `package.json` but NOT imported here: this package must
 *    never fail to bundle when the optional engine is absent, and a static import of a missing
 *    module is a build error, not a runtime fallback. The consumer wires it in:
 *    `layoutWorkflowGraph(nodes, edges, { engine: await import('elkjs/lib/elk.bundled.js').then((m) => new m.default()) })`.
 * 2. A built-in layered layout (longest-path layering + one barycenter ordering pass), which is
 *    what runs when no engine is supplied or the engine throws. Deterministic, cycle-safe, and
 *    group-aware: a group's children are laid out in the group's own coordinate space (React
 *    Flow's `parentId` convention), and the group takes its measured extent in the outer scope.
 */

export interface LayoutNode {
  id: string;
  parentId?: string;
  /** `group` nodes size themselves around their children. */
  kind?: 'node' | 'group';
  /** A measured size wins over the default node box. */
  width?: number;
  height?: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  /** Horizontal distance between layers. */
  gapX: number;
  /** Vertical distance between nodes of one layer. */
  gapY: number;
  /** Inner padding of a group around its children (the header needs the top). */
  groupPaddingX: number;
  groupPaddingTop: number;
  groupPaddingBottom: number;
  engine?: LayoutEngine;
}

export interface LayoutResult {
  /** Positions in the caller's convention — children RELATIVE to their group. */
  positions: Record<string, { x: number; y: number }>;
  /** Extents of every node, groups included, after layout. */
  sizes: Record<string, { width: number; height: number }>;
  engine: 'elk' | 'layered';
}

/** The subset of ELK's JSON graph this module emits and reads back. */
export interface ElkGraphNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkGraphNode[];
  layoutOptions?: Record<string, string>;
}
export interface ElkGraph extends ElkGraphNode {
  edges?: Array<{ id: string; sources: string[]; targets: string[] }>;
}
export interface LayoutEngine {
  layout(graph: ElkGraph): Promise<ElkGraph>;
}

export const DEFAULT_LAYOUT_OPTIONS: Readonly<Omit<LayoutOptions, 'engine'>> = Object.freeze({
  nodeWidth: 220,
  nodeHeight: 96,
  gapX: 96,
  gapY: 40,
  groupPaddingX: 24,
  groupPaddingTop: 56,
  groupPaddingBottom: 24,
});

interface Scope {
  ids: string[];
  edges: LayoutEdge[];
}

function scopesOf(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Map<string | null, Scope> {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId ?? null] as const));
  const scopes = new Map<string | null, Scope>();
  for (const node of nodes) {
    const key = node.parentId ?? null;
    const scope = scopes.get(key) ?? { ids: [], edges: [] };
    scope.ids.push(node.id);
    scopes.set(key, scope);
  }
  for (const edge of edges) {
    const a = parentOf.get(edge.source);
    const b = parentOf.get(edge.target);
    // Only edges inside ONE scope order that scope; a cross-scope edge (loop body -> outside)
    // is drawn, not laid out.
    if (a === undefined || b === undefined || a !== b) continue;
    scopes.get(a)?.edges.push(edge);
  }
  return scopes;
}

/** Longest-path layering over a DAG projection (a back edge found by DFS is ignored). */
function layersOf(ids: readonly string[], edges: readonly LayoutEdge[]): string[][] {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) out.get(edge.source)?.push(edge.target);
  const state = new Map<string, 0 | 1 | 2>();
  const forward: LayoutEdge[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      const seen = state.get(next) ?? 0;
      if (seen === 1) continue; // back edge
      forward.push({ source: id, target: next });
      if (seen === 0) visit(next);
    }
    state.set(id, 2);
  };
  for (const id of ids) if ((state.get(id) ?? 0) === 0) visit(id);

  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of forward) preds.get(edge.target)?.push(edge.source);
  const layer = new Map<string, number>();
  const depth = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    const value = Math.max(-1, ...(preds.get(id) ?? []).map(depth)) + 1;
    layer.set(id, value);
    return value;
  };
  for (const id of ids) depth(id);
  const layers: string[][] = [];
  for (const id of ids) {
    const index = layer.get(id) ?? 0;
    (layers[index] ??= []).push(id);
  }
  // Barycenter pass: order each layer by the mean index of its predecessors in the previous one.
  for (let index = 1; index < layers.length; index += 1) {
    const previous = new Map(layers[index - 1].map((id, position) => [id, position]));
    const key = (id: string) => {
      const sources = (preds.get(id) ?? []).map((source) => previous.get(source)).filter((v): v is number => v !== undefined);
      return sources.length === 0 ? Number.MAX_SAFE_INTEGER : sources.reduce((sum, v) => sum + v, 0) / sources.length;
    };
    layers[index] = [...layers[index]].sort((a, b) => key(a) - key(b) || layers[index].indexOf(a) - layers[index].indexOf(b));
  }
  return layers.filter((bucket) => bucket.length > 0);
}

function layeredLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], options: Omit<LayoutOptions, 'engine'>): LayoutResult {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const scopes = scopesOf(nodes, edges);
  const positions: Record<string, { x: number; y: number }> = {};
  const sizes: Record<string, { width: number; height: number }> = {};

  const sizeOf = (id: string): { width: number; height: number } => {
    const known = sizes[id];
    if (known) return known;
    const node = byId.get(id);
    const size = { width: node?.width ?? options.nodeWidth, height: node?.height ?? options.nodeHeight };
    sizes[id] = size;
    return size;
  };

  const layoutScope = (scopeKey: string | null): { width: number; height: number } => {
    const scope = scopes.get(scopeKey);
    if (!scope) return { width: 0, height: 0 };
    // Groups first: a group's extent depends on its children.
    for (const id of scope.ids) {
      if (byId.get(id)?.kind === 'group') {
        const inner = layoutScope(id);
        const measured = byId.get(id);
        sizes[id] = {
          width: Math.max(measured?.width ?? 0, inner.width + options.groupPaddingX * 2),
          height: Math.max(measured?.height ?? 0, inner.height + options.groupPaddingTop + options.groupPaddingBottom),
        };
      }
    }
    const layers = layersOf(scope.ids, scope.edges);
    const originX = scopeKey === null ? 0 : options.groupPaddingX;
    const originY = scopeKey === null ? 0 : options.groupPaddingTop;
    let x = originX;
    let width = 0;
    let height = 0;
    for (const layer of layers) {
      const columnWidth = Math.max(...layer.map((id) => sizeOf(id).width));
      let y = originY;
      for (const id of layer) {
        positions[id] = { x, y };
        y += sizeOf(id).height + options.gapY;
      }
      height = Math.max(height, y - options.gapY - originY);
      width = x + columnWidth - originX;
      x += columnWidth + options.gapX;
    }
    return { width, height };
  };
  layoutScope(null);
  return { positions, sizes, engine: 'layered' };
}

function toElk(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], options: Omit<LayoutOptions, 'engine'>): ElkGraph {
  const children = new Map<string | null, ElkGraphNode[]>();
  const build = (node: LayoutNode): ElkGraphNode => ({
    id: node.id,
    width: node.width ?? options.nodeWidth,
    height: node.height ?? options.nodeHeight,
    ...(node.kind === 'group'
      ? {
          children: [],
          layoutOptions: {
            'elk.padding': `[top=${options.groupPaddingTop},left=${options.groupPaddingX},bottom=${options.groupPaddingBottom},right=${options.groupPaddingX}]`,
          },
        }
      : {}),
  });
  const elkNodes = new Map(nodes.map((node) => [node.id, build(node)]));
  for (const node of nodes) {
    const key = node.parentId ?? null;
    const bucket = children.get(key) ?? [];
    bucket.push(elkNodes.get(node.id)!);
    children.set(key, bucket);
  }
  for (const [key, bucket] of children) {
    if (key === null) continue;
    const parent = elkNodes.get(key);
    if (parent) parent.children = bucket;
  }
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(options.gapX),
      'elk.spacing.nodeNode': String(options.gapY),
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    },
    children: children.get(null) ?? [],
    edges: edges.map((edge, index) => ({ id: `e${index}`, sources: [edge.source], targets: [edge.target] })),
  };
}

function fromElk(graph: ElkGraph): Pick<LayoutResult, 'positions' | 'sizes'> {
  const positions: LayoutResult['positions'] = {};
  const sizes: LayoutResult['sizes'] = {};
  const walk = (node: ElkGraphNode) => {
    for (const child of node.children ?? []) {
      positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
      sizes[child.id] = { width: child.width ?? 0, height: child.height ?? 0 };
      walk(child);
    }
  };
  walk(graph);
  return { positions, sizes };
}

/**
 * Lay the graph out. Never throws for the built-in engine; an injected engine that throws
 * falls back to the built-in one, so a broken optional dependency can never leave the Studio
 * without an "Auto layout" button.
 */
export async function layoutWorkflowGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: Partial<LayoutOptions> = {},
): Promise<LayoutResult> {
  const { engine, ...rest } = options;
  const resolved: Omit<LayoutOptions, 'engine'> = { ...DEFAULT_LAYOUT_OPTIONS, ...rest };
  if (engine) {
    try {
      const laid = await engine.layout(toElk(nodes, edges, resolved));
      const { positions, sizes } = fromElk(laid);
      if (nodes.every((node) => positions[node.id] !== undefined)) return { positions, sizes, engine: 'elk' };
    } catch {
      // fall through to the built-in engine
    }
  }
  return layeredLayout(nodes, edges, resolved);
}
