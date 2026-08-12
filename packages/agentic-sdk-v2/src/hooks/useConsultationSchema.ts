/**
 * @arcaai/vox - useConsultationSchema Hook (TASK-665)
 *
 * Read-only view over the SESSION-PINNED consultation context schema bundle
 * `AgenticProvider` fetches at mount (and re-fetches on a same-tab tenant
 * switch) from `GET /tenant/me/context-schema` (TASK-658/661). This hook does
 * NOT fetch — the discovery fetch is owned by the provider so every consumer
 * in the tree observes the SAME pinned version for the life of the session,
 * which is what makes `X-Context-Schema-Version` on `useArcaSession().addContext()`
 * meaningful: the version a client validates a payload against locally is
 * the exact version it sends on the wire.
 */

import { useMemo } from 'react';
import { useAgenticStore, selectConsultationSchema } from '../store';
import {
  findConsultationContextKind,
  isConsultationContextKindDeprecated,
  type ConsultationSchemaBundle,
  type ContextKindDeclaration,
} from '../types/consultationSchema';
import { validateConsultationContextPayload, type ContextPayloadValidationResult } from '../core/contextPayloadValidation';

export interface UseConsultationSchemaReturn {
  /** The raw discovery bundle, or `null` before the provider's first fetch resolves. */
  bundle: ConsultationSchemaBundle | null;
  /** Whether a tenant/department schema is actually configured (`bundle` resolved but not the "unconfigured" `etag: "none"` shape). */
  isConfigured: boolean;
  /**
   * The declared kind with this key, or `undefined` for a genuinely unknown
   * (or not-yet-configured) kind — never throws. See the type module's doc
   * comment for why this is forward-compatible by design.
   */
  findKind: (kindKey: string) => ContextKindDeclaration | undefined;
  /** Whether a resolved kind carries a `deprecated` block (TASK-661). */
  isDeprecated: (kind: ContextKindDeclaration | undefined) => boolean;
  /** Validate a `{ kindKey, payload }` pair against the pinned bundle — see `validateConsultationContextPayload`'s doc comment for its permissive-by-design semantics. */
  validatePayload: (kindKey: string, payload: Record<string, unknown> | undefined) => ContextPayloadValidationResult;
}

export function useConsultationSchema(): UseConsultationSchemaReturn {
  const bundle = useAgenticStore(selectConsultationSchema);

  return useMemo(
    () => ({
      bundle,
      isConfigured: bundle !== null && bundle.schemaId !== null,
      findKind: (kindKey: string) => findConsultationContextKind(bundle?.definition, kindKey),
      isDeprecated: isConsultationContextKindDeprecated,
      validatePayload: (kindKey: string, payload: Record<string, unknown> | undefined) =>
        validateConsultationContextPayload(bundle, kindKey, payload),
    }),
    [bundle],
  );
}
