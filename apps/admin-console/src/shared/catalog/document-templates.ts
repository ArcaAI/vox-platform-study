'use client';

/**
 * The tenant's `DocumentTemplate` catalog, as a cross-feature read.
 *
 * `features/document-templates` owns the AUTHORING surface for these rows and keeps its own,
 * much fuller `api/types.ts` (shapes, versions, publish/pin requests). This module is a
 * deliberate, minimal COPY of the read half — not an import — because rule 13 §Structure says
 * features never import each other, and the Workflow Studio needs the same list to offer a
 * document-shape picker on its generation nodes.
 *
 * That is the same posture `hooks.ts` already takes for `TextProvider`, whose own comment
 * records the reasoning: the owning feature keeps its copy for its surface, and `shared/catalog`
 * carries the lookup so a second feature can read it without depending on the first. Kept
 * minimal on purpose — every field here is one the picker actually renders or decides on, so
 * the copy has little surface to drift on. The authoritative editor stays `/document-templates`;
 * this module never writes.
 */

import { useQuery } from '@tanstack/react-query';
import { getJson } from '@/shared/api';

const CATALOG_STALE_MS = 60 * 1000;

export type CatalogDocumentTemplateStatus = 'DRAFT' | 'PUBLISHED' | 'APPROVED';

/** The subset of `DocumentTemplateResponse` a picker needs. */
export interface CatalogDocumentTemplate {
  id: string;
  name: string;
  slug: string;
  status: CatalogDocumentTemplateStatus;
  /** The version generation serves. Null until the first publish. */
  pinnedVersionNumber: number | null;
  isDefault: boolean;
}

/** One immutable published version — enough to offer it as a pin target. */
export interface CatalogDocumentTemplateVersion {
  versionNumber: number;
  createdAt: string;
  changeReason: string | null;
}

/**
 * The server's own servability rule (`document-template.service.ts#isServable`), copied so the
 * console offers exactly what generation can resolve: a pin AND a status that serves. A template
 * failing either test is skipped by `resolveForGeneration`, which then FAILS OPEN to the platform
 * shape — so offering one here would let an admin bind a node to something that silently produces
 * SOAP notes instead.
 */
export function isServableDocumentTemplate(template: CatalogDocumentTemplate): boolean {
  return template.pinnedVersionNumber != null && (template.status === 'PUBLISHED' || template.status === 'APPROVED');
}

/**
 * The section list the platform fallback produces. Copied from `platform-document-shapes.ts`'s
 * `SOAP_NOTE_SHAPE` (via the owning feature's `api/types.ts`) so an empty catalog can say what is
 * actually being generated today rather than just "nothing configured".
 */
export const PLATFORM_FALLBACK_SECTION_TITLES = ['Subjective', 'Objective', 'Assessment', 'Plan'] as const;

/** Every document template for the caller's tenant. The controller reads tenancy off CLS. */
export function useDocumentTemplateCatalog() {
  return useQuery({
    queryKey: ['catalog', 'document-templates'],
    queryFn: () => getJson<CatalogDocumentTemplate[]>('admin/document-templates'),
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
}

/** The immutable versions of ONE template — fetched only once a node actually binds one. */
export function useDocumentTemplateVersionCatalog(templateId: string | null) {
  return useQuery({
    queryKey: ['catalog', 'document-template-versions', templateId ?? ''],
    queryFn: () => getJson<CatalogDocumentTemplateVersion[]>(`admin/document-templates/${encodeURIComponent(templateId as string)}/versions`),
    enabled: !!templateId,
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
}
