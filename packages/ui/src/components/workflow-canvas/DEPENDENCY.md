# React Flow dependency record (TASK-719 Task 2)

Verified 2026-08-16 against the published npm registry — not from memory (R6).

## (a) Package name and pinned version

`grep -rn "xyflow\|reactflow\|react-flow" --include=package.json` over the repo (excluding
`node_modules`) returned nothing before this change — React Flow was not present anywhere
(TASK-719 README §2.1). The library was renamed from `reactflow` to `@xyflow/react` at v12
(confirmed via `npm view reactflow` / `npm view @xyflow/react` on 2026-08-16: `reactflow`'s
latest published version is a 11.x-era release and its own README/deprecation notice points
at `@xyflow/react`; `@xyflow/react` is the actively maintained package).

Pinned: **`@xyflow/react@^12.11.3`** (`packages/ui/package.json` `dependencies`), lockfile
resolves `@xyflow/react@12.11.3`.

## (b) Licence

**MIT.** Read directly from the published package's own `LICENSE` file:

```
$ npm pack @xyflow/react@12.11.3 && tar xzf xyflow-react-12.11.3.tgz && cat package/LICENSE
MIT License
Copyright (c) 2019-2025 webkid GmbH
```

`npm view @xyflow/react license` independently reports `MIT`. No copyleft or field-of-use
restriction. Permissive — clears the licence gate (R6).

## (c) React 19 + Next 16 compatibility

`npm view @xyflow/react peerDependencies` (2026-08-16):

```json
{ "react": ">=17", "react-dom": ">=17", "@types/react": ">=17", "@types/react-dom": ">=17" }
```

The console is React `^19.2.8`, Next `^16.3.1` (`13-nextjs-apps.md`). `>=17` is satisfied by
19.2.8. `@xyflow/react` ships `'use client'` at the top of its browser entry points (verified
in the unpacked `dist/esm` output) and is a client-only library — it is consumed exclusively
from inside the `packages/ui/src/components/workflow-canvas/` group, every file of which
carries its own `'use client'` directive (rule 07), so no server-component import boundary is
crossed.

## (d) Shipped CSS and its scoping

The package's `exports` map declares two CSS entry points, `./dist/base.css` and
`./dist/style.css` (`style.css` is a superset — "the default theming" — of `base.css`, per
its own header comment). Both are scoped under a single top-level `.react-flow` class and
read every colour through a `var(--xy-<token>, var(--xy-<token>-default))` fallback pair
(verified by reading the unpacked `dist/style.css` directly), e.g.:

```css
.react-flow {
  --xy-node-background-color-default: #fff;
  background-color: var(--xy-background-color, var(--xy-background-color-default));
}
.react-flow.dark {
  --xy-node-background-color-default: #2b2b2b;
}
```

This is exactly the theming bridge `custom/code-editor.tsx` already established for a
third-party surface: `canvas-tokens.css` (Task 5) sets the *non-`-default`* `--xy-*` variables
from HOPE's existing `--background`/`--border`/`--primary`/... tokens, which already flip
value under the ambient `.dark` class via `next-themes`. **The library's own `.react-flow.dark`
selector is therefore never used** — HOPE's tokens already carry the light/dark distinction,
so overriding the non-default `--xy-*` variables once is sufficient in both themes; no second,
`.dark`-scoped override block is needed. `style.css` (not `base.css`) is imported so the
library's own structural/layout CSS (node/edge positioning, handle geometry, controls layout)
ships too — only the *colour* tokens are overridden.

## (e) Transitive dependencies

`npm view @xyflow/react dependencies` (2026-08-16):

```json
{ "zustand": "^4.4.0", "classcat": "^5.0.3", "@xyflow/system": "0.0.80" }
```

Three transitive runtime deps. `zustand` is the one of note: `packages/ui` has **no** direct
`zustand` dependency today (confirmed: `grep -n '"zustand"' packages/ui/package.json` — no
hit), so there is no direct-dependency collision to resolve. It bundles its **own** `zustand@4`
copy, resolved independently by pnpm's strict `node_modules` linking from the app's `zustand@5`
copy used by `@arcaai/vox` (rule 08) and (per Task 11) the Studio's own graph-editing store —
each package's `import { create } from 'zustand'` resolves to its own copy; no runtime symbol
is shared between `@xyflow/react`'s internal store and the Studio's Zustand store, so there is
no version-mismatch risk despite both existing in the dependency tree. `@xyflow/system` is
React Flow's own internal geometry/algorithm package, not otherwise present in the tree.
`classcat` is a ~200-byte class-name joiner, not otherwise present in the tree, and is not used
by `packages/ui` code (`cn()` from `lib/utils.ts` remains the only class-merge utility used in
this composite).

Unpacked size of the `@xyflow/react` tarball's `dist/` (`npm pack` output): ~1.2 MB
unpacked / before this repo's own bundler tree-shakes it through `packages/ui`'s `tsup`
build — not a bundle-size claim (rule 07 forbids citing bundle-size numbers that drift), just
the raw npm-reported figure at pin time.

## (f) Rejected alternatives

| Alternative | One-line rejection reason |
|---|---|
| `reactflow` (v11, pre-rename package) | Superseded by `@xyflow/react` at v12; the v11 line is not the actively maintained package |
| Hand-rolled SVG/canvas graph editor | The Studio's canvas is one of five coordinated parts (palette, inspector, validation rail, list/tree peer) — building and maintaining pan/zoom/connect/keyboard-nav primitives from scratch is exactly the kind of undifferentiated infrastructure a maintained library exists to absorb; design.md D2 names React Flow specifically |
| `@dnd-kit/*` (already a `packages/ui` dependency, used elsewhere for sortable lists) | Built for list/grid drag-and-drop, not a node-graph pane (edges, ports, pan/zoom, minimap); repurposing it would mean re-implementing most of what React Flow already provides |

## Placement

Added as a **`dependencies` entry of `packages/ui` only** (`packages/ui/package.json`) — not
of `@arcaai/admin-console`, which consumes it exclusively through the
`./components/workflow-canvas` subpath export of the composite (Task 5), never by importing
`@xyflow/react` directly.
