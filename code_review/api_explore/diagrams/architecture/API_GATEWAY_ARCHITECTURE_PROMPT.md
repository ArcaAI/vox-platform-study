# API Gateway Architecture Diagram Prompt

Use this prompt to generate API Gateway architecture diagram(s) in this folder with Archify. The work should be executed in **batches** and tracked in `API_GATEWAY_ARCHITECTURE_TRACKER.md`.

## Feasibility (grounded in `project-hope/apps/api`)

Batching is feasible and recommended:

- `review/api_explore/inventory/summary.json`: **818 routes, 148 controllers, 77 modules**, 607 OpenAPI paths.
- `project-hope/apps/api/src/modules/*`: 79 module folders (domain-oriented Nest modules).
- `review/api_explore/diagrams/catalog.md`: module-level API inventory/groupings already exist.

A single diagram for the full gateway flow (`API Endpoint -> Controller -> Service -> Other Microservices APIs`) across all endpoints would be too dense. Create a **master overview** plus **domain batch diagrams**, each with its own candidate JSON and finalized HTML.

## Tracker requirement

Before starting a batch, update `review/api_explore/diagrams/architecture/API_GATEWAY_ARCHITECTURE_TRACKER.md`:

- set batch status (`PENDING`/`IN_PROGRESS`/`BLOCKED`/`REVIEW`/`DONE`)
- confirm module/route scope and resolve overlaps
- record candidate path, HTML path, finalize receipt, and limitations after the batch

Do not mark a batch `DONE` unless Archify finalize gates passed or limitations are explicitly documented.

```text
Create/update an **API Gateway Architecture Diagram batch** in `review/api_explore/diagrams/` using the Archify workflow (load the `archify` skill and follow its architecture authoring/finalize path).

### Batch scope
- Batch ID: **[FILL IN, e.g. B03-consultation-core; see API_GATEWAY_ARCHITECTURE_TRACKER.md]**
- Modules / route groups: **[FILL IN from apps/api/src/modules and catalog/inventory]**
- Gateway/app: **[FILL IN, e.g. project-hope API gateway / apps/api]**
- Repo root for evidence: **[FILL IN, e.g. /Users/apple/repos/VOX/project-hope]**
- GitHub repo URL/revision: **[FILL IN, e.g. https://github.com/ArcaAI/project-hope.git @ <revision>]**
- Specific downstream microservices/APIs to include when discovered: **[FILL IN or “discover from code”]**

### Goal
Produce an explorable standalone Archify HTML architecture diagram for this batch showing how API traffic flows from public endpoints to downstream implementation and dependencies.

### Required layout / structure
- **Left side:** API endpoints in the batch (grouped logically by domain/resource/version). Each endpoint node should clearly show method + path (or equivalent identifier).
- **Middle/right flow:** `API Endpoint -> Controller -> Service -> Other Microservices APIs` (or downstream/internal dependencies where applicable).
- Preserve real call/dependency flow; do not invent routes, handlers, service calls, or downstream APIs.
- Use boundaries/regions to keep the diagram readable (e.g., Endpoints, Controllers, Services, Downstream Microservices/External APIs).
- For large batches, split into sub-batches/diagrams (e.g., `B03a`, `B03b`) rather than producing an unreadable graph. Update the tracker accordingly.

### Clickable dialog / semantic passport content (every box/node)
For **each box in the diagram**, make node evidence-rich so the Archify semantic passport/dialog provides:
1. **What it is?** — role/type (endpoint, controller, service, downstream microservice API, internal dependency).
2. **What it does?** — concise behavior/responsibility in this gateway flow.
3. **Links to the code** — repository-backed `sources` for code participants.
4. **Which file, function, and line numbers link to GitHub** — repository-relative `path`, `line` (and `end_line` when useful), and a descriptive `label` naming the relevant function/handler/method when known. Verify lines against the real repo.
5. **Example Input** — representative request/example input (especially endpoints/controllers/services; for downstream APIs show request/call shape if known).
6. **Example Output** — representative response/example output.

Before authoring, inspect the Archify architecture schema/common fields and represent “Example Input/Output” using supported, user-visible fields (rich description/metadata/cards/passport-compatible fields) rather than inventing unsupported schema keys. If the schema cannot carry per-node examples directly, add clearly labeled companion cards/notes anchored to the relevant nodes so the information remains accessible from the diagram. Do not fabricate examples; mark unknown examples as limitations and cite the source used (OpenAPI, DTO/test/fixture/code) when available.

### Evidence / repository requirements
- This is a **repository-backed** diagram.
- Study the real code in `project-hope/apps/api` (and related packages/services as needed) for controllers, services, modules, and downstream calls.
- Set `meta.repository` with the correct `url`, analyzed `revision`, and `link_mode: "web"`.
- Verify every referenced file/line against the real repository tree.
- Keep provenance clear (candidate JSON + finalize receipt/summary produced by the Archify flow).

### Batch output / process
- Work in: `review/api_explore/diagrams/`
- Suggested names: `.archify/api-gateway-<batch>-<timestamp>/candidate.json` and `api-gateway-<batch>.html` (or follow existing local naming if established).
- Follow local conventions in `review/api_explore/diagrams/README.md` where applicable.
- Run the complete Archify `finalize` flow for the architecture candidate with `--repo-root <repo-root> --quality showcase --json` (unless a documented reason requires otherwise). Do not claim success unless gates pass.
- Update `API_GATEWAY_ARCHITECTURE_TRACKER.md` with status, scope, artifact paths, receipt, and limitations.
- Return: absolute path to HTML, candidate/receipt paths, validation/finalize summary, browser-evidence status, and limitations (unknown examples, unverifiable lines, missing downstream contracts, split batches, etc.).

### Master overview batch (B00)
After enough domain batches exist, create/update a master overview diagram that shows gateway entry, major domain groups, and references to batch diagrams. Avoid duplicating every endpoint from batch diagrams.
```

## Customize before using

- Fill in **Batch ID**, **Modules / route groups**, **Repo root for evidence**, and **GitHub repo URL/revision**.
- For strict endpoint coverage, add: `Include every endpoint under: [path/prefix/controller list] and list any excluded endpoints with a reason.`
- For authoritative examples, add: `Source Example Input/Output from [OpenAPI spec / e2e tests / controller DTOs / fixtures] and cite where each example came from.`
- Before starting, reconcile batch scope against `apps/api/src/modules/*`, `review/api_explore/inventory/summary.json`, and `catalog.md`; update `API_GATEWAY_ARCHITECTURE_TRACKER.md` if module boundaries differ.
