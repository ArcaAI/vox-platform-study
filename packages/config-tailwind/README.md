# @arcaai/config-tailwind

Placeholder package for a shared Tailwind CSS JS configuration. Since the monorepo moved to Tailwind v4's CSS-first configuration, the design system is defined in CSS — the canonical token source is `packages/ui/src/styles/globals.css` (`:root` / `.dark` variables plus `@theme inline`) — and this package's JS config is an empty shell that nothing imports.

Last updated: 2026-07-04

## What It Exports

`main` points to [tailwind.config.ts](./tailwind.config.ts):

```typescript
import type { Config } from "tailwindcss";

const sharedConfig: Omit<Config, "content"> = {
    theme: {
        extend: {},
    },
    plugins: [],
};

export default sharedConfig;
```

## Current Usage (verified 2026-07-04)

- `@arcaai/ui` declares `@arcaai/config-tailwind` as a devDependency, but no file imports the shared config.
- No app or package references it in a `tailwind.config.*` — Tailwind v4 consumers configure via CSS instead:
  - `packages/ui` builds its stylesheet with the Tailwind CLI from `src/styles/globals.css`.
  - `apps/ui-playground` (deprecated) uses `@tailwindcss/vite` with `@import 'tailwindcss'` and `@source "../../../packages/ui/src"` in `src/index.css`.

## When to Use

Only if a shared JS-level Tailwind preset becomes necessary again (e.g. a plugin that cannot be expressed in CSS). Extend it the standard way:

```typescript
import sharedConfig from '@arcaai/config-tailwind';

export default {
  ...sharedConfig,
  content: ['./src/**/*.{ts,tsx}'],
};
```

For theming work, edit `packages/ui/src/styles/globals.css` instead — see [../ui/README.md](../ui/README.md) for the token architecture.
