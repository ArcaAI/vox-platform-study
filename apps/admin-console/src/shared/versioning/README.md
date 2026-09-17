# `shared/versioning` — the console's versioned-item kit (TASK-965 WS-3)

Seven admin-console screens manage something that has versions. Before this kit each of them
answered *"which one is live?"* in its own words, its own colours and its own list markup — the
same `DEPRECATED` enum was `destructive` on one screen and `outline` on another (INV-1), `APPROVED`
was indistinguishable from `DRAFT` on two more (HV-5), and a lineage with no assignment was told it
was "currently the platform default" when resolution actually fails closed (AG-3).

This folder is the single answer. It is **feature-agnostic**: nothing here imports from
`@/features/**`, and no feature type appears in any prop. A feature maps its own rows onto the
kit's `VersionRow` and supplies its own verbs.

## The two versioning models it serves

| Model | Entities | Shape |
|---|---|---|
| **A — row-per-version lineage** | `Agent`, `WorkflowDefinition` | every version is a row keyed `(tenantId, slug, versionNumber)`; `status` runs DRAFT → VALIDATED → PUBLISHED → DEPRECATED, and `isActive` is a movable pointer to the one published version the slug serves |
| **B — head + version rows** | prompt templates, context schemas, document templates, DNA writing styles | one head row carries `status` (DRAFT / PUBLISHED / APPROVED) and a movable **pin** to an immutable version row |

One kit covers both because the questions are the same; only the words for "the one that serves"
differ (**Active** in model A, **Pinned vN** in model B), and `ActiveBadge` renders both.

## Vocabulary (TASK-965 §3.1 — the table every screen follows)

| Concept | Label | Variant | Icon | Verbs |
|---|---|---|---|---|
| Draft | Draft | `outline` | pencil | New draft · Edit · Discard draft |
| Validated | Validated | `secondary` | circle-check | Validate |
| Published (immutable) | Published | `default` | cloud-upload | Publish |
| Approved (model B governance) | Approved | `default` | rosette-check | Approve |
| Deprecated | Deprecated | `outline` + muted | archive | Deprecate |
| The served version (model A) | Active | `default` | play | **Activate** (rollback) |
| The served version (model B) | Pinned vN | `default` | pin | Pin |
| No published version serves | None active | `outline` + warning | alert | Activate one |
| Which slug serves a task | Tenant default · Assigned to «Dept» · N selectors · **Unassigned** | `secondary`; unassigned `outline` + warning | link | Assign · Reassign · Remove |
| Provenance | Platform origin (· Locked) · Tenant | `secondary` / `outline` | lock when locked | — |

Three rules the table encodes, and the reasons they are not negotiable:

1. **Status, liveness and assignment are three orthogonal axes**, so they are three components.
   The assignment points at a **slug**, not a version — badging it on a version row is how a DRAFT
   v4 came to be labelled "Tenant default" (AG-15).
2. **`DEPRECATED` is muted, never `destructive`.** It is an end state an admin chose, not a
   failure; spending `destructive` on it leaves nothing to signal a real one.
3. **Nothing is carried by colour alone** (WCAG 1.4.1): every badge renders its label as text, and
   every changed diff line carries a `+` / `−` prefix as well as a tint.

## Components

| Export | Intent |
|---|---|
| `LIFECYCLE_STATUS` / `LIFECYCLE_STATUS_ORDER` / `lifecycleStatusLabel` | the vocabulary table as data — label, variant, icon and a one-sentence meaning per status; an unknown status from a newer gateway degrades to Title Case instead of throwing |
| `LifecycleStatusBadge` | that map as a non-interactive badge (it renders inside grid cells and inside rows that are themselves buttons, where a focusable tooltip would be invalid HTML) |
| `ActiveBadge` | liveness: `Active` (model A), `Pinned vN` (model B), or the lineage-level `None active` warning |
| `AssignmentBadges` | which slug serves a task: tenant default, department count (or one named department), selector count — and `Unassigned`, which states the fail-closed consequence and never claims a platform fallback (TASK-890 OD-M) |
| `OriginBadge` | provenance, not permission: `Platform origin` for a row cloned from the SYSTEM reference set, `· Locked` when the clone refuses edits, `Tenant` for tenant-authored rows, nothing when no provenance field is on the wire |
| `VersionHistoryPanel` | the one version list for both models: newest first, status + active/pinned marker + the date its status put there + author + checksum + drift, a caller-supplied row action menu, an `aria-expanded` disclosure for feature-specific detail, and rule-10 skeletons / empty / error states |
| `ActivateVersionDialog` | rollback: names what becomes active, what stops serving, and which assignments **follow** |
| `DeprecateVersionDialog` | retirement: when the version is the active one, names that the lineage stops resolving and the assignments **break**, and gates on typing the slug |
| `DiscardDraftDialog` | the draft body is unrecoverable; published versions are untouched. Type-to-confirm |
| `VersionCompareDialog` | client-side split/unified diff of two version payloads (OD-965-7 — no backend diff route) |
| `diffLines` / `toComparableJson` | the pure comparison behind it |
| `IntegrationPanel` | how a developer reaches a published lineage — endpoint, modes, SDK snippets, Postman, socket lane, developer-portal links (pulled forward into WS-1, §4.2) |

## Notes for callers

- **`VersionRow` is the kit's type, not a feature's.** Everything but `id`, `versionNumber` and
  `status` is optional, because a model-B version has no `validatedAt`, a draft has no
  `publishedAt`, and a workflow definition has no author at all until OD-965-5 lands
  `createdBy`/`updatedBy` on its response.
- **Actions are supplied per row** (`actions={(row) => […]}`), so permission and state gating stay
  with the feature that knows them. A disabled action must carry `disabledReason` — a disabled
  control owes a visible reason (rule 11 §5).
- **`VersionCompareDialog` does not use `CodeEditor`.** `@arcaai/ui`'s editor tokenises ONE
  document into a single highlighted `<pre>` and has no per-line tint, so a diff rendered in it
  would be two blobs and an admin comparing by eye. The dialog renders its own read-only panes
  over `diffLines`, keeping the editor's mono type and gutter so the two surfaces still read as
  one family. It is sized with the `lg` dialog bucket (`shared/dialog/dialog-size.ts`).
- **The three dialogs compose `shared/confirm/confirm-dialog`**, so type-to-confirm arming,
  destructive styling and Radix focus management stay defined once.
