# @arcaai/config-tailwind — empty shell, kept for historical reasons

Placeholder package for a shared Tailwind CSS JS configuration. Since the monorepo moved to
Tailwind v4's CSS-first configuration, the design system is defined in CSS — the canonical token
source is `packages/ui/src/styles/globals.css` (`:root` / `.dark` variables plus `@theme inline`) —
and this package's JS config is an empty shell that nothing imports. **Never add theme config
here** — edit `packages/ui/src/styles/globals.css` instead.

## Layout

| Path | What it holds |
|---|---|
| `tailwind.config.ts` | The package's `main` entry — an empty `Omit<Config, 'content'>` shell (`theme: { extend: {} }`, `plugins: []`) |

## How it works

```typescript
import type { Config } from 'tailwindcss';

const sharedConfig: Omit<Config, 'content'> = {
  theme: {
    extend: {},
  },
  plugins: [],
};

export default sharedConfig;
```

### Current usage

- `@arcaai/ui` declares `@arcaai/config-tailwind` as a devDependency, but no file imports the
  shared config.
- No app or package references it in a `tailwind.config.*` — Tailwind v4 consumers configure via
  CSS instead: `packages/ui` builds its stylesheet with the Tailwind CLI from
  `src/styles/globals.css`; `apps/compat-playground` uses `@tailwindcss/vite` with
  `@import 'tailwindcss'` and `@source "../../../packages/ui/src"` in `src/index.css`.

### When to use

Only if a shared JS-level Tailwind preset becomes necessary again (e.g. a plugin that cannot be
expressed in CSS). Extend it the standard way:

```typescript
import sharedConfig from '@arcaai/config-tailwind';

export default {
  ...sharedConfig,
  content: ['./src/**/*.{ts,tsx}'],
};
```

## Related

- [`@arcaai/ui` token architecture](../ui/README.md)
- [`07-react-ui.md`](../../.claude/rules/07-react-ui.md) — Tailwind v4 CSS-first conventions
