/**
 * Platform-wide feature-availability keys (TASK-932 §3.2/§4.2 — the contract
 * fixed before Lane N and Lane S spawned).
 *
 * These are `global-kv` settings-registry descriptors (rule 00 §Configuration
 * Principles: tenant -> SYSTEM cascade, `failMode: 'open-to-default'`,
 * `killSwitch: true`, `default: false`) that Lane S owns end to end — the
 * descriptors, the `/features` matrix screen, and
 * `GET admin/settings/features/effective`. This module is the console-side
 * TYPE CONTRACT the gate consumes: a nav entry or a route names one of these
 * keys, `useFeatureGates()` resolves it, and the entry/route is hidden unless
 * the resolved value is exactly `true` (undefined/loading/error all fail
 * closed — never rendered as "on").
 *
 * The gate is a console VISIBILITY + route decision only, not an
 * authorisation boundary — backend admin routes stay ability-gated (rule 13
 * §Routing).
 */
export type FeatureGateKey =
  | 'console.tools.mcp.enabled'
  | 'console.mlflow.enabled'
  | 'console.agenticPolicy.enabled'
  | 'console.workflowHarness.enabled';

export const FEATURE_GATE_KEYS: readonly FeatureGateKey[] = [
  'console.tools.mcp.enabled',
  'console.mlflow.enabled',
  'console.agenticPolicy.enabled',
  'console.workflowHarness.enabled',
];

/**
 * Resolved gate values, keyed by `FeatureGateKey`. Partial and readonly on
 * purpose: a key absent from the map (loading, errored, or simply not yet
 * returned by the backend) is indistinguishable from `false` to every
 * consumer — `gates?.[key] === true` is the ONLY "on" test, so fail-closed is
 * the map's default shape, not a check callers must remember to add.
 */
export type FeatureGateMap = Readonly<Partial<Record<FeatureGateKey, boolean>>>;
