# TASK-1065 — Disable MCP & Tools in the admin console

**Status:** Review · **Type:** feature (UI) · **Branch:** dev-2.2

## Requirement Analysis
Park the MCP & Tools feature until further development: hide the MCP & Tools screen and every agent/workflow
interface that exposes MCP or tools. Owner decision: keep the route, lock its gate off. No backend change.

## Current State Evaluation
- No LLM/agent tool calling is live. The only tool path is the harness MCP `validate_codes` call, already OFF by
  default (`HarnessPolicy.mcpToolsEnabled` null, no `McpServer` rows, empty `mcp.egress.allowedHosts`).
  `apps/text` uses provider `tool_use` only to force JSON-schema output.
- Console surfaces: `/tools-mcp` (gate `console.tools.mcp.enabled`), the "MCP external tools" knob on
  `/agentic-policy`, the "Tools" allowlist group + summary line on the harness policy screen, and the read-only
  "Tools" JSON on agent detail. Agent wizard (OD-16) and Workflow Studio expose no tools already.

## Implementation Plan / Summary
| File | Change |
|---|---|
| `apps/admin-console/src/shared/feature-gates/keys.ts` | `LOCKED_OFF_GATES = ['console.tools.mcp.enabled']` |
| `apps/admin-console/src/shared/feature-gates/use-feature-gates.ts` | Forces locked gates to `false` whatever the backend resolves (nav entry + route hide; `FeatureGateBoundary` → 404) |
| `apps/admin-console/src/features/agentic-policy/components/agentic-knobs.ts` | "MCP external tools" knob removed |
| `apps/admin-console/src/features/harness-policy/components/policy-fields.ts`, `harness-policy-screen.tsx` | "Tools" group and summary line removed |
| `apps/admin-console/src/features/agents/components/agent-overview.tsx` | "Tools" JSON block removed |
| `apps/admin-console/src/shared/feature-gates/__tests__/use-feature-gates.test.tsx` | New test: a locked gate stays closed when the backend says on |

**Re-enable:** remove the key from `LOCKED_OFF_GATES`, restore the four removed UI lines (this commit's diff).
Backend (`admin/mcp-servers`, harness MCP path) is untouched and still default-OFF.

## Verification
- `npx vitest run src/shared/feature-gates src/features/agentic-policy src/features/harness-policy src/features/agents/components`
  → 286 passed, 1 failed. The failure (`findings-list.asr-warnings.task1048.test.tsx`, "No QueryClient set")
  also fails on HEAD — pre-existing, out of scope.
- `tsc --noEmit` and eslint on the touched files: clean.

## Change History
- 2026-10-11 — created and implemented.
