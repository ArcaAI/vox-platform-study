/**
 * TASK-893 Contract C — the public seam for testing/inspecting a workflow definition's sandbox
 * runs. Extracted from the retired `features/workbench/**` (that route now just redirects to
 * `/workflow-studio`) so `features/workflow-studio` can mount it without a cross-feature import
 * (rule 13: "features never import each other" — `shared/` is exactly the escape hatch the rule
 * names).
 *
 * This barrel is deliberately narrow: it re-exports ONLY the four symbols INTERFACES.md §5
 * declares. Everything else in `./api/**` and `./components/**` (the query keys, the client
 * functions, `FixturePicker`, `SandboxBadge`, …) is this module's own internal implementation,
 * not part of the contract — import it directly from its own file if a future contract widens,
 * rather than reaching past this barrel.
 */
export { SandboxRunPanel } from './components/sandbox-run-panel';
export { SandboxNodeTrace } from './components/sandbox-node-trace';
export { useSandboxNodeStates } from './api/hooks';
export type { SandboxNodeRunState } from './api/types';
