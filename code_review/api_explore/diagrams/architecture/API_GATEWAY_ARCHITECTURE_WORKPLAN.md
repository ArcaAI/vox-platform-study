# API Gateway Architecture Diagram Workplan

Reference this file to check status and resume the batched API Gateway architecture diagram work.

## 1. Strategy

### Deliverables
- **B00 master overview**: gateway entry, global pipeline refs, domain map, links to batch diagrams. Avoid duplicating every endpoint or internals already covered by existing diagrams (`api-gateway-internals-deep-dive.html`, and `review/api_explore_3/api-gateway-overview.html`).
- **Domain batch diagrams (B01–B08, split as needed)**: each batch shows the real flow `API Endpoint -> Controller -> Service -> Other Microservices APIs` for its scoped modules/routes.
  - **Left side**: API endpoints (method + path), grouped logically.
  - **Middle/right**: controller, service, downstream microservice/internal/external dependency.
  - **Every box/node** must provide Archify passport/dialog evidence:
    1. What it is
    2. What it does
    3. Links to the code
    4. File, function/handler, and line numbers linked to GitHub (repo-relative `path`, `line`, optional `end_line`, descriptive label)
    5. Example Input
    6. Example Output
  - Verify file/line evidence against the real repo. Do not invent routes, calls, or examples. If Archify schema cannot carry per-node example I/O directly, use supported user-visible fields/cards/notes anchored to relevant nodes and label them clearly.

### Evidence sources
- Primary codebase: `/Users/apple/repos/VOX/project-hope/apps/api` (and related packages/services only as needed).
- Scope references: `review/api_explore/inventory/summary.json`, `review/api_explore/diagrams/catalog.md`.
- Prior reusable evidence (verify before reuse): `review/api_explore_3/inventory/endpoint-catalog.json`, `review/api_explore_3/inventory/ts-symbols.json`, `review/api_explore_3/inventory/coverage-report.json`, `review/api_explore_3/api-gateway-explorer.html`.

### Feasibility baseline
Batching is required. `review/api_explore/inventory/summary.json` reports **818 routes, 148 controllers, 77 modules** (607 OpenAPI paths). A single all-endpoint diagram would be too dense.

## 2. Progress tracking

**Tracker (source of truth):** `review/api_explore/diagrams/architecture/API_GATEWAY_ARCHITECTURE_TRACKER.md`

Track for each batch:
- status: `PENDING` / `IN_PROGRESS` / `BLOCKED` / `REVIEW` / `DONE`
- module/route scope, overlaps/splits, route/controller estimates
- candidate JSON path
- finalized HTML path
- finalize receipt path
- notes/limitations (unknown examples, unverifiable lines, missing downstream contracts, split batches)

**Update rule:**
- Before starting: set batch to `IN_PROGRESS` and confirm scope.
- After finishing: record artifact paths, finalize receipt, gate result, and limitations.
- Mark `DONE` only when `archify finalize` gates pass, or explicitly document why completion is partial.

## 3. Where diagrams are created

**Output folder:** `review/api_explore/diagrams/`

Per batch (follow Archify/local conventions):
- Provenance/working folder: `review/api_explore/diagrams/architecture/.archify/api-gateway-<batch>-<YYYYMMDD-HHMMSS>/`
  - `candidate.json`
  - finalize/browser-check receipts as produced
- Finalized HTML: `review/api_explore/diagrams/architecture/api-gateway-<batch>.html` (or a clearly named equivalent; record the exact path in the tracker)

Repository evidence settings:
- Repo root: `/Users/apple/repos/VOX/project-hope` (unless explicitly changed; record in tracker/notes)
- `meta.repository.url`: `https://github.com/ArcaAI/project-hope.git` (confirm if different)
- `meta.repository.revision`: analyzed commit SHA from `project-hope`
- `meta.repository.link_mode`: `web`

## 4. Resume prompt (use after connection/context loss)

```text
Resume the batched API Gateway Architecture diagram work in /Users/apple/repos/VOX/review/api_explore/diagrams.

Read first:
1. /Users/apple/repos/VOX/review/api_explore/diagrams/architecture/API_GATEWAY_ARCHITECTURE_WORKPLAN.md (this workplan)
2. /Users/apple/repos/VOX/review/api_explore/diagrams/architecture/API_GATEWAY_ARCHITECTURE_TRACKER.md (source of truth for progress)
3. /Users/apple/repos/VOX/review/api_explore/diagrams/architecture/API_GATEWAY_ARCHITECTURE_PROMPT.md (detailed requirements)
4. /Users/apple/repos/VOX/review/api_explore/inventory/summary.json and /Users/apple/repos/VOX/review/api_explore/diagrams/catalog.md (API/module scope)
5. Existing references if useful: /Users/apple/repos/VOX/review/api_explore_3/inventory/*.json, /Users/apple/repos/VOX/review/api_explore_3/api-gateway-explorer.html, and existing diagrams in this folder.

Then:
- Reconcile tracker status against actual files in review/api_explore/diagrams and .archify/.
- Pick the next batch that is PENDING or IN_PROGRESS (or split a batch that is too large). Update the tracker to IN_PROGRESS with confirmed scope before editing.
- Study real code in /Users/apple/repos/VOX/project-hope/apps/api (and related packages/services only as needed) for the selected batch.
- Create/update the batch Archify architecture diagram showing: Left = API endpoints (method+path), Right flow = API Endpoint -> Controller -> Service -> Other Microservices APIs.
- Every node must provide passport/dialog evidence: what it is, what it does, GitHub-linked code source (repo-relative path, line/end_line, function/handler label), Example Input, Example Output. Verify file/line evidence; do not invent routes/calls/examples. Use supported Archify fields/cards/notes for example I/O.
- Use repo root /Users/apple/repos/VOX/project-hope and set meta.repository (url/revision/link_mode:"web") from the analyzed project-hope revision.
- Save work under review/api_explore/diagrams (candidate in .archify/api-gateway-<batch>-<timestamp>/, finalized HTML as recorded in tracker).
- Run complete Archify finalize: `node <archify-bin>/archify.mjs finalize architecture <candidate.json> <output.html> --repo-root /Users/apple/repos/VOX/project-hope --quality showcase --json`. Do not claim success unless gates pass.
- Update API_GATEWAY_ARCHITECTURE_TRACKER.md with status, artifact paths, finalize receipt, and limitations.
- Return: batch worked, tracker status, absolute artifact/receipt paths, gate summary, and any blockers/next batch.
```
