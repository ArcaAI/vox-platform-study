/**
 * Re-export shim. The guard itself moved to `@/shared/navigation` when a second
 * screen — the context-schema definition editor — needed the same behaviour.
 * Features never import each other, so a hook two features share belongs in
 * `shared/`; every existing import inside this feature keeps working through
 * here.
 */
export { confirmLeave, useUnsavedChangesGuard } from '@/shared/navigation/use-unsaved-changes-guard';
