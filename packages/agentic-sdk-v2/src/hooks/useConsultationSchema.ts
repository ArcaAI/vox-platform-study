/**
 * @arcaai/vox - useConsultationSchema Hook
 *
 * Read-only view over the SESSION-PINNED consultation context schema bundle
 * `AgenticProvider` fetches at mount (and re-fetches on a same-tab tenant
 * switch) from `GET /tenants/me/context-schema`. This hook does
 * NOT fetch — the discovery fetch is owned by the provider so every consumer
 * in the tree observes the SAME pinned version for the life of the session,
 * which is what makes `X-Context-Schema-Version` on `useArcaSession().addContext()`
 * meaningful: the version a client validates a payload against locally is
 * the exact version it sends on the wire.
 *
 * ## `validatePayload` checks the SESSION bundle, not necessarily the governing workflow's bound
 * version
 *
 * This hook's `bundle` is the TENANT'S CURRENT PIN at session start — the same value
 * `GET /tenants/me/context-schema` answers. A consultation's GOVERNING WORKFLOW may instead be
 * PINNED to an older schema version (`useConsultationWorkflow().workflow?.governed` +
 * `WorkflowSchemaDescription.contextSchema.followsLatest === false`), in which case a payload
 * `validatePayload` calls locally-valid can still be REFUSED server-side with 400
 * `WORKFLOW_CONTEXT_INCOMPATIBLE` — the trigger validates against the version it was published
 * with, not the session's pin. `validatePayload` is a fast-fail UX aid; it is not a guarantee the
 * server will accept the payload. Read `useConsultationWorkflow().governingRun` /
 * `WorkflowSchemaDescription.contextSchema` to know which version actually governs, and catch
 * `WORKFLOW_CONTEXT_INCOMPATIBLE` regardless of what client-side validation said.
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
  /** Whether a resolved kind carries a `deprecated` block.*/
  isDeprecated: (kind: ContextKindDeclaration | undefined) => boolean;
  /**
   * Validate a `{ kindKey, payload }` pair against the pinned bundle — see
   * `validateConsultationContextPayload`'s doc comment for its permissive-by-design semantics.
   * A fast-fail UX aid ONLY: it checks the SESSION-pinned bundle, which may differ from the
   * governing workflow's bound version when that trigger is PINNED rather than follow-latest —
   * see this module's header doc comment. A locally-valid payload can still be refused
   * server-side with 400 `WORKFLOW_CONTEXT_INCOMPATIBLE`.
   */
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
