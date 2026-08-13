/** Changelog admin — release notes list, unseen popup, ack, authoring. */

import { getJson, getWithEtag, patchWithEtag, postJson, request, type Paginated, type WithEtag } from '@/shared/api';
import type { ChangelogAudience, ChangelogEntry, ChangelogSeverity, CreateChangelogEntryRequest, UpdateChangelogEntryRequest } from './types';

const BASE = 'changelog';
const ADMIN_BASE = 'admin/changelog';

export function listChangelog(params?: { severity?: ChangelogSeverity; page?: number; version?: string }): Promise<Paginated<ChangelogEntry>> {
  return getJson(BASE, params);
}

/** Drives the one-time What's New dialog. Empty (never an error) when there is nothing to show. */
export function listUnseenChangelog(): Promise<ChangelogEntry[]> {
  return getJson(`${BASE}/unseen`);
}

/** Idempotent — acknowledging an already-acknowledged entry is a no-op. */
export function acknowledgeChangelog(entryIds: string[]): Promise<void> {
  return postJson(`${BASE}/acknowledge`, { entryIds });
}

/** Global-admin authoring — created as DRAFT. */
export function createChangelogEntry(body: CreateChangelogEntryRequest): Promise<ChangelogEntry> {
  return postJson(ADMIN_BASE, body);
}

export function getChangelogEntryWithEtag(id: string): Promise<WithEtag<ChangelogEntry>> {
  return getWithEtag(`${ADMIN_BASE}/${id}`);
}

export function updateChangelogEntry(id: string, body: UpdateChangelogEntryRequest, etag: string): Promise<WithEtag<ChangelogEntry>> {
  return patchWithEtag(`${ADMIN_BASE}/${id}`, body, etag);
}

/** The only DRAFT -> PUBLISHED path; always a human action. OCC-guarded (POST + If-Match). */
export function publishChangelogEntry(id: string, etag: string): Promise<WithEtag<ChangelogEntry>> {
  return request(`${ADMIN_BASE}/${id}/publish`, { method: 'POST', etag });
}

export type { ChangelogAudience };
