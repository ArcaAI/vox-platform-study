'use client';

/**
 * @arcaai/vox/compat - useSMR (DEPRECATED — renamed to `useText`)
 *
 * Naming-alignment: `smr` → `text` (the underlying service is a
 * "control-plane proxy for text-generation + text-embedding", not
 * summarization-specific — see `docs/architecture/agentic-workflow-platform/design.md`
 * D8). This module is a one-release compat re-export, mirroring the
 * repo's "retired routes keep a `redirect()` page for one release"
 * precedent (`.claude/rules/13-nextjs-apps.md`).
 *
 * Import `useText` from `@arcaai/vox/compat` instead. This file (and the
 * `useSMR`/`UseSMROptions`/`UseSMRReturn` names) will be REMOVED in the
 * next release after this one lands.
 */

export { useText as useSMR } from './useText';
export type { UseTextOptions as UseSMROptions, UseTextReturn as UseSMRReturn } from './useText';
