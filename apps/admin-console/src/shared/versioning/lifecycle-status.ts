/**
 * TASK-965 §3.1 — the ONE lifecycle vocabulary for every versioned item in the console.
 *
 * Before this map the same `WorkflowDefinitionStatus` enum was coloured `destructive` on the
 * Agents grid and `outline` in the studio switcher (INV-1), and the head+version screens rendered
 * every status as a bare `outline` badge, so APPROVED and DRAFT looked identical (HV-5). A status
 * is a fact about a row; it cannot mean two things on two screens.
 *
 * Two deliberate choices worth stating, because both look like mistakes:
 *
 * - **DEPRECATED is `outline` + muted, never `destructive`.** It is an END state an admin chose,
 *   not a failure — `destructive` is reserved for actions and errors, and spending it here leaves
 *   nothing to say "this is broken" with.
 * - **PUBLISHED and APPROVED share the `default` variant.** Both are "this is the governed
 *   state" in their own model (model A publishes an immutable version; model B approves the
 *   version clinical resolution serves), and §3.1 pins Published to `default`. They are told
 *   apart by LABEL and ICON, never by colour, which is also what WCAG 1.4.1 requires of the
 *   badge anyway — so a colour distinction would have been decoration, not information.
 *
 * `VALIDATED` and `DEPRECATED` exist only in model A (`Agent`, `WorkflowDefinition`); `APPROVED`
 * only in model B (prompt templates, context schemas, document templates). One union covers both
 * so a shared list, badge or dialog never has to know which model it is rendering.
 */
import type { ComponentType } from 'react';
import { IconArchive, IconCircleCheck, IconCloudUpload, IconPencil, IconRosetteDiscountCheck } from '@tabler/icons-react';

/** Every lifecycle status any versioned entity in this console can hold. */
export type LifecycleStatus = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'APPROVED' | 'DEPRECATED';

export type LifecycleBadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

export interface LifecycleStatusMeta {
  label: string;
  variant: LifecycleBadgeVariant;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  /** Extra classes when the variant alone cannot express the state (DEPRECATED's muted text). */
  className?: string;
  /** One sentence an admin can hover — what the state MEANS, not what it is called. */
  description: string;
}

/** Lifecycle order, earliest to terminal. Also the order the badge legend renders in. */
export const LIFECYCLE_STATUS_ORDER = ['DRAFT', 'VALIDATED', 'PUBLISHED', 'APPROVED', 'DEPRECATED'] as const satisfies readonly LifecycleStatus[];

export const LIFECYCLE_STATUS: Record<LifecycleStatus, LifecycleStatusMeta> = {
  DRAFT: {
    label: 'Draft',
    variant: 'outline',
    icon: IconPencil,
    description: 'Editable. Nothing outside this screen can reach it yet.',
  },
  VALIDATED: {
    label: 'Validated',
    variant: 'secondary',
    icon: IconCircleCheck,
    description: 'Passed validation and still editable — any edit returns it to Draft.',
  },
  PUBLISHED: {
    label: 'Published',
    variant: 'default',
    icon: IconCloudUpload,
    description: 'Frozen. Edit it as a new draft; it can serve traffic once it is the active version.',
  },
  APPROVED: {
    label: 'Approved',
    variant: 'default',
    icon: IconRosetteDiscountCheck,
    description: 'Approved for clinical resolution — this is the version that is served.',
  },
  DEPRECATED: {
    label: 'Deprecated',
    variant: 'outline',
    className: 'text-muted-foreground',
    icon: IconArchive,
    description: 'Retired. It keeps its history but will never serve traffic again.',
  },
};

/** True for a status this kit knows — a narrowing guard for values arriving off the wire. */
export function isLifecycleStatus(status: string): status is LifecycleStatus {
  return status in LIFECYCLE_STATUS;
}

/**
 * The human label for a status. A status this build does not know (a newer gateway adding one)
 * degrades to Title Case rather than rendering a screaming enum or, worse, nothing at all.
 */
export function lifecycleStatusLabel(status: string): string {
  if (isLifecycleStatus(status)) return LIFECYCLE_STATUS[status].label;
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}
