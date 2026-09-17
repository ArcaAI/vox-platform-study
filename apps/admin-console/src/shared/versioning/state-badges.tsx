'use client';

/**
 * TASK-965 §3.1 — the three badge families that are NOT lifecycle status, kept apart because
 * conflating them is what the register records as AG-3 and AG-15.
 *
 * | Family | Answers | Scope |
 * |---|---|---|
 * | `ActiveBadge` | which VERSION of this lineage serves (model A) or is pinned (model B) | a version row |
 * | `AssignmentBadges` | which SLUG serves a task or palette, and for whom | a lineage |
 * | `OriginBadge` | where this row's CONTENT came from, and whether it is locked | a row |
 *
 * AG-15: the assignment badge used to sit on a VERSION row, so a DRAFT v4 was badged "Tenant
 * default" although assignments store the slug and follow whichever version is active.
 * AG-3: with no assignment at all the drawer said "Currently the platform default", which is
 * false in both directions — resolution is department -> tenant and then FAILS CLOSED
 * (`AGENT_NOT_ASSIGNED`, 503), and TASK-890 OD-M removed the platform tier for content entirely.
 */
import { IconAlertTriangle, IconLink, IconLock, IconPinFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import { Badge, cn } from '@arcaai/ui';

/** The reserved SYSTEM tenant — provenance only; a tenant never reads its content at runtime. */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export interface ActiveBadgeProps {
  /** Model A: this version is the one the slug serves. */
  active?: boolean;
  /** Model B: the head is pinned to this version number. */
  pinnedVersionNumber?: number | null;
  /** Lineage-level warning: published versions exist but none of them serves. */
  noneActive?: boolean;
  className?: string;
}

export function ActiveBadge({ active, pinnedVersionNumber, noneActive, className }: ActiveBadgeProps) {
  if (noneActive) {
    return (
      <Badge
        variant="outline"
        className={cn('text-warning border-warning/40 gap-1', className)}
        title="No published version of this lineage is active, so nothing it is assigned to can resolve."
      >
        <IconAlertTriangle aria-hidden className="size-3" />
        None active
      </Badge>
    );
  }

  if (active) {
    return (
      <Badge className={cn('gap-1', className)} title="The version this lineage serves. Assignments follow it automatically.">
        <IconPlayerPlayFilled aria-hidden className="size-3" />
        Active
      </Badge>
    );
  }

  if (pinnedVersionNumber !== null && pinnedVersionNumber !== undefined) {
    return (
      <Badge className={cn('gap-1 font-mono', className)} title="Resolution serves this pinned snapshot, never simply the latest version.">
        <IconPinFilled aria-hidden className="size-3" />
        Pinned v{pinnedVersionNumber}
      </Badge>
    );
  }

  return null;
}

export interface AssignmentSummary {
  /** An assignment at tenant scope — the fallback for every department with no row of its own. */
  tenantDefault?: boolean;
  /** How many department-scope assignments name this slug. */
  departmentCount?: number;
  /** How many of those carry tag selectors (part of the row identity server-side). */
  selectorCount?: number;
}

export interface AssignmentBadgesProps extends AssignmentSummary {
  /** When exactly one department is assigned and the caller knows its name, say it. */
  departmentName?: string | null;
  className?: string;
}

/**
 * "What serves this task" for a lineage. With nothing assigned it says Unassigned and states the
 * consequence — the resolver does not fall through to a platform default, it refuses (AG-3).
 */
export function AssignmentBadges({ tenantDefault, departmentCount = 0, selectorCount = 0, departmentName, className }: AssignmentBadgesProps) {
  const assigned = Boolean(tenantDefault) || departmentCount > 0;

  if (!assigned) {
    return (
      <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
        <Badge
          variant="outline"
          className="text-warning border-warning/40 gap-1"
          title="Nothing resolves to this slug: assignment is department then tenant, and an unresolved chain fails closed rather than falling back."
        >
          <IconAlertTriangle aria-hidden className="size-3" />
          Unassigned
        </Badge>
      </span>
    );
  }

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {tenantDefault ? (
        <Badge variant="secondary" className="gap-1" title="Assigned at tenant scope — the fallback for every department with no row of its own.">
          <IconLink aria-hidden className="size-3" />
          Tenant default
        </Badge>
      ) : null}
      {departmentCount === 1 && departmentName ? (
        <Badge variant="secondary" title="A department-scope assignment, which outranks the tenant default.">
          Assigned to {departmentName}
        </Badge>
      ) : departmentCount > 0 ? (
        <Badge variant="secondary" title="Department-scope assignments, which outrank the tenant default.">
          {departmentCount} department{departmentCount === 1 ? '' : 's'}
        </Badge>
      ) : null}
      {selectorCount > 0 ? (
        <Badge variant="outline" title="Assignments narrowed by tag selectors — part of the row identity, so two rows can differ by selector alone.">
          {selectorCount} selector{selectorCount === 1 ? '' : 's'}
        </Badge>
      ) : null}
    </span>
  );
}

export interface OriginBadgeProps {
  /** Model A provenance: the tenant the CONTENT was cloned from (SYSTEM = the reference set). */
  sourceTenantId?: string | null;
  /** Model B provenance: the reference template this row was cloned from. */
  sourceTemplateId?: string | null;
  sourceTemplateSlug?: string | null;
  /** A locked clone refuses edits — say so, or the refusal has no visible cause (HV-8). */
  locked?: boolean;
  className?: string;
}

/**
 * Provenance, not permission. Every list route answers only rows this tenant OWNS (the SYSTEM
 * reference set is CLONED at provisioning, never read live — TASK-890 OD-M), so "Platform origin"
 * names where the content came from, never who may edit it. Renders nothing when no provenance
 * field is on the wire, rather than guessing "Tenant".
 */
export function OriginBadge({ sourceTenantId, sourceTemplateId, sourceTemplateSlug, locked, className }: OriginBadgeProps) {
  const source = sourceTemplateSlug ?? sourceTemplateId ?? null;
  const known = sourceTenantId !== undefined || sourceTemplateId !== undefined || sourceTemplateSlug !== undefined;
  if (!known) return null;

  const fromPlatform = sourceTenantId === SYSTEM_TENANT_ID || Boolean(source);
  if (!fromPlatform) {
    return (
      <Badge variant="outline" className={className} title="Authored in this tenant.">
        Tenant
      </Badge>
    );
  }

  return (
    <Badge
      variant="secondary"
      className={cn('gap-1', className)}
      title={
        source
          ? `Cloned from the platform reference item ${source}.${locked ? ' It is locked, so edits are refused.' : ''}`
          : `Cloned from the platform reference set.${locked ? ' It is locked, so edits are refused.' : ''}`
      }
    >
      {locked ? <IconLock aria-hidden className="size-3" /> : null}
      Platform origin{locked ? ' · Locked' : ''}
    </Badge>
  );
}
