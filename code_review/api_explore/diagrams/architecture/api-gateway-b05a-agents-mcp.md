# API Gateway B05a — Agents & MCP Admin

Companion explainer for `api-gateway-b05a-agents-mcp.html`.

## Scope
`B05a` (part of B05-agent-workflow, reconciled from `inventory/modules.json`): `agent` (11/1), `agent-admin` (25/2), `agent-promotion` (4/2), `agent-trajectory` (3/1), `agentic-admin` (1/1), `mcp-admin` (5/1) = 49 routes / 8 controllers. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Modules/routes | Controllers | Services | Downstream |
|---|---|---|---|---|
| Agent runtime | `/agents` (11) | `AgentController` (`agent.controller.ts:284`) | `AgentService` (`agent.service.ts:280`) | Agent config/state; runtime deps |
| Agent admin/promotion | `/admin/agents`, `/admin/agent-assignments`, `/admin/agent-promotions` incl. promote-to-system (29) | `AgentAdminController` (`agent-admin.controller.ts:67`), `AgentAssignmentAdminController` (`agent-assignment-admin.controller.ts:22`), `AgentPromotionController` (`agent-promotion.controller.ts:31`), `AgentPromoteToSystemController` (`agent-promote-to-system.controller.ts:22`) | `AgentAssignmentService` (`agent-assignment.service.ts:44`), `AgentPromotionService` (`agentPromotion.service.ts:137`) | Agent admin data store |
| Trajectory/agentic admin | `/admin/agent-trajectory` sessions/steps, `/admin/agentic` (4) | `AgentTrajectoryController` (`agent-trajectory.controller.ts:38`), `AgenticAdminController` (`agentic-admin.controller.ts:33`) | `AgentTrajectoryService` (`agent-trajectory.service.ts:113`) | Trajectory/agentic data store |
| MCP server admin | `/admin/mcp-servers` CRUD (5) | `McpAdminController` (`mcp-admin.controller.ts:54`) | `McpServerAdminService` (`mcp-server-admin.service.ts:47`) | MCP registry data store |

## Example input/output (representative)
- **Agent runtime/admin:** agent/assignment/promotion DTOs -> agent config, assignment, or promotion records. Verify exact route contracts per controller.
- **Agent trajectory:** `GET /admin/agent-trajectory/sessions` and `GET /admin/agent-trajectory/sessions/:sessionId/steps` -> grouped session stats and ordered step records (PHI-safe/admin-scoped; cross-tenant/nonexistent handling per controller behavior).
- **MCP admin:** `POST/PATCH/DELETE /admin/mcp-servers` -> MCP server registry records (optimistic concurrency/tenant/SYSTEM rules apply; verify authref/secret handling).

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 1 crossing near `svc_agent` and 1 detour (`svc_agent→ext_runtime`, 3 bends). Gates pass.
- Limitations: grouped endpoint nodes (49 routes/8 controllers); agentic-admin service naming not separately verified; agent runtime downstream dependencies are deployment-specific; reconcile exact route/DTO contracts and MCP secret/authref handling with OpenAPI/implementation.
