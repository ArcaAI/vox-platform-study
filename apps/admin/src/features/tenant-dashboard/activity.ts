/**
 * TASK-380 — Tenant Dashboard recent-activity mapping.
 *
 * Pure helpers that turn `useAuditLog().list()` entries into the recent-activity
 * view model (title / actor / machine code / semantic dot role) and scope the
 * feed to the viewed tenant. Type-only SDK import keeps this testable under the
 * app's `@arcaai/vox` vitest stub.
 */

import { format } from 'date-fns';
import type { AuditLogEntry } from '@arcaai/vox';

/** Compact relative time for the activity feed ("just now" / "5m ago" / "3h ago" / "2d ago"). */
export function formatRelativeTime(value: string | null | undefined, now: Date = new Date()): string {
    if (!value) return '—';
    const then = new Date(value);
    if (Number.isNaN(then.getTime())) return '—';
    const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d ago`;
    return format(then, 'MMM d, yyyy');
}

/** Semantic role for the status dot — mapped to a token class in the page. */
export type ActivityDotRole = 'success' | 'destructive' | 'warning' | 'neutral';

/** Actions whose intent is destructive/irreversible (warn even when they succeed). */
const DESTRUCTIVE_INTENT = /(delete|deleted|archiv|disable|disabled|revoke|revoked|remove|removed|purge|destroy)/i;

/** `AUDIT_ACTION` / `eventType` → sentence case ("TENANT_UPDATED" → "Tenant updated"). */
export function humanizeAction(entry: AuditLogEntry): string {
    const raw = entry.action || entry.eventType || 'Activity';
    const words = String(raw).toLowerCase().replace(/[._-]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Best available actor label: display name → email → user id → "System". */
export function actorOf(entry: AuditLogEntry): string {
    return entry.responsibleUser?.displayName || entry.responsibleUser?.email || entry.responsibleUserId || 'System';
}

/** Raw machine token (uppercased) for the `font-mono` code chip; empty when absent. */
export function actionCode(entry: AuditLogEntry): string {
    return String(entry.action || entry.eventType || '').toUpperCase();
}

/** Semantic dot role from outcome + intent. */
export function activityDotRole(entry: AuditLogEntry): ActivityDotRole {
    if (entry.success === false) return 'destructive';
    const token = entry.action || entry.eventType || '';
    if (DESTRUCTIVE_INTENT.test(String(token))) return 'warning';
    if (entry.success === true) return 'success';
    return 'neutral';
}

/** Keep rows for the given tenant; rows with no `tenantId` are kept (defensive). */
export function scopeToTenant(entries: AuditLogEntry[], tenantId: string): AuditLogEntry[] {
    return entries.filter((e) => !e.tenantId || e.tenantId === tenantId);
}

export interface ActivityItem {
    id: string;
    title: string;
    actor: string;
    code: string;
    dotRole: ActivityDotRole;
    timestamp?: string;
}

/** Map audit entries into the recent-activity view model. */
export function toActivityItems(entries: AuditLogEntry[]): ActivityItem[] {
    return entries.map((e) => ({
        id: e.id,
        title: humanizeAction(e),
        actor: actorOf(e),
        code: actionCode(e),
        dotRole: activityDotRole(e),
        timestamp: e.createdAt,
    }));
}
