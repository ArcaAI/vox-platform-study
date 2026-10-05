'use client';

/**
 * Admin consultation activity plane: the oldest-first timeline feed, per-item version history,
 * line diff inputs and the AI runs that produced a version. All reads go through the BFF proxy.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { parseAsArrayOf, parseAsBoolean, parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { ACTIVITY_KINDS, type ActivityKind, type ActivityRunRecord, type ConsultationActivityPage, type ItemVersionDetail, type ItemVersionSummary } from '@arcaai/types';
import { getJson, type QueryParams } from '@/shared/api';
import { consultationKeys } from './keys';

export interface ActivityFilters {
  kinds?: ActivityKind[];
  edited?: boolean;
  aiRuns?: boolean;
  encounterSeq?: number;
  grouping?: 'runs' | 'none';
  segmentSeqFrom?: number;
  segmentSeqTo?: number;
  include?: 'versions';
  limit?: number;
}

export interface VersionDiff {
  contextItemId: string;
  from: unknown;
  to: unknown;
}

const base = (id: string) => `admin/consultations/${encodeURIComponent(id)}`;
const itemBase = (id: string, itemId: string) => `${base(id)}/items/${encodeURIComponent(itemId)}`;

export function buildActivityParams(filters: ActivityFilters = {}, cursor?: string): QueryParams {
  const { kinds, ...rest } = filters;
  return { ...rest, kinds: kinds && kinds.length > 0 ? kinds.join(',') : undefined, cursor };
}

export function getConsultationActivity(id: string, filters?: ActivityFilters, cursor?: string): Promise<ConsultationActivityPage> {
  return getJson(`${base(id)}/activity`, buildActivityParams(filters, cursor));
}

export function getItemVersions(id: string, itemId: string): Promise<ItemVersionSummary[]> {
  return getJson(`${itemBase(id, itemId)}/versions`);
}

export function getItemVersion(id: string, itemId: string, n: number): Promise<ItemVersionDetail> {
  return getJson(`${itemBase(id, itemId)}/versions/${n}`);
}

export function getItemDiff(id: string, itemId: string, n: number, against: number): Promise<VersionDiff> {
  return getJson(`${itemBase(id, itemId)}/versions/${n}/diff`, { against });
}

export function getItemRuns(id: string, itemId: string, version?: number): Promise<ActivityRunRecord[]> {
  return getJson(`${itemBase(id, itemId)}/runs`, { version });
}

/** Filters that expand one collapsed segment run into its individual segments. */
export function segmentRunFilters(run: { encounterSeq: number; firstSeq: number; lastSeq: number }): ActivityFilters {
  return { grouping: 'none', kinds: ['TRANSCRIPT_SEGMENT'], encounterSeq: run.encounterSeq, segmentSeqFrom: run.firstSeq, segmentSeqTo: run.lastSeq };
}

/** The next page cursor, or undefined once the feed is exhausted. */
export function nextActivityCursor(page: Pick<ConsultationActivityPage, 'nextCursor' | 'hasMore'>): string | undefined {
  return page.hasMore && page.nextCursor ? page.nextCursor : undefined;
}

export function useConsultationActivity(id: string, filters: ActivityFilters = {}) {
  return useInfiniteQuery({
    queryKey: consultationKeys.activity(id, filters),
    queryFn: ({ pageParam }) => getConsultationActivity(id, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextActivityCursor,
    enabled: !!id,
  });
}

export function useSegmentRun(id: string, run: { encounterSeq: number; firstSeq: number; lastSeq: number } | null) {
  const filters = run ? segmentRunFilters(run) : {};
  return useInfiniteQuery({
    queryKey: consultationKeys.activity(id, filters),
    queryFn: ({ pageParam }) => getConsultationActivity(id, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextActivityCursor,
    enabled: !!id && run !== null,
  });
}

export function useItemVersions(id: string, itemId: string | null) {
  return useQuery({ queryKey: consultationKeys.itemVersions(id, itemId ?? ''), queryFn: () => getItemVersions(id, itemId ?? ''), enabled: !!id && itemId !== null });
}

/** Decrypting a version is an audited read — fetched only for the version being viewed. */
export function useItemVersion(id: string, itemId: string | null, n: number | null) {
  return useQuery({ queryKey: consultationKeys.itemVersion(id, itemId ?? '', n ?? 0), queryFn: () => getItemVersion(id, itemId ?? '', n ?? 0), enabled: !!id && itemId !== null && n !== null });
}

export function useItemDiff(id: string, itemId: string | null, n: number | null, against: number | null) {
  return useQuery({
    queryKey: consultationKeys.itemDiff(id, itemId ?? '', n ?? 0, against ?? 0),
    queryFn: () => getItemDiff(id, itemId ?? '', n ?? 0, against ?? 0),
    enabled: !!id && itemId !== null && n !== null && against !== null,
  });
}

export function useItemRuns(id: string, itemId: string | null, version?: number) {
  return useQuery({ queryKey: consultationKeys.itemRuns(id, itemId ?? '', version), queryFn: () => getItemRuns(id, itemId ?? '', version), enabled: !!id && itemId !== null });
}

/** Shareable activity view state: filters plus the selected item/version. */
export const ACTIVITY_PARAM_PARSERS = {
  kinds: parseAsArrayOf(parseAsStringLiteral(ACTIVITY_KINDS)),
  edited: parseAsBoolean,
  aiRuns: parseAsBoolean,
  encounterSeq: parseAsInteger,
  item: parseAsString,
  v: parseAsInteger,
};

export function useActivityParams() {
  return useQueryStates(ACTIVITY_PARAM_PARSERS);
}
