// The pure cascade-walk primitive.
//
// Extracted from ConfigResolver so every registry-driven config surface resolves
// the same way: walk the caller-ordered tiers (deepest → shallowest), return the
// FIRST tier that supplies a set value (non-null/undefined), else the code
// default. Dependency-free on purpose (no import of config-resolver or the
// registry) so it can be reused without any intra-package import cycle.
//
// NOTE: tier ORDERING and MAX-SCOPE filtering (which tiers to include) are the
// caller's responsibility — this function only performs the first-set-wins walk.
// A `false`/`0`/`""` value counts as SET (only null/undefined mean "inherit").

export interface CascadeTier<S extends string> {
  /** The tier that could supply the value, e.g. 'doctor' | 'tenant' | 'system-default'. */
  source: S;
  /** The value at this tier; null/undefined means "not set here — inherit". */
  value: unknown;
}

export interface CascadeResult<S extends string, V> {
  value: V;
  source: S | 'code-default';
}

export function walkCascade<S extends string, V>(tiers: CascadeTier<S>[], codeDefault: V): CascadeResult<S, V> {
  for (const tier of tiers) {
    if (tier.value !== null && tier.value !== undefined) {
      return { value: tier.value as V, source: tier.source };
    }
  }
  return { value: codeDefault, source: 'code-default' };
}
