/**
 * DD-2's document binding, read and written as a pair of OPTIONAL config keys.
 *
 * `documentTemplateId` says WHICH `DocumentTemplate` a generation node decodes its output into;
 * `documentVersionNumber` is that node's own movable PIN onto one immutable version of it. The
 * pin is what stops a republished template silently RESTRUCTURING the clinical document a
 * published workflow already produces (`node-config-schemas.ts`
 *
 * Two invariants live here rather than in the component, so they are testable without a DOM and
 * cannot drift between the control's several call sites:
 *
 *  1. **Read it the way the compiler reads it.** `buildCompilerContext`
 *     (`workflow-definition.service.ts`) drops any pin that is not an integer >= 1, so a UI
 *     that rendered `0` or `2.5` as a pin would be describing a binding the compiled artifact
 *     does not contain.
 *  2. **Never write a key the admin did not choose.** Both keys are optional on all five
 *     generation schemas — that is what keeps every already-published graph valid — and `0` is
 *     illegal at every layer (`minimum: 1` here, `versionNumber >= 1` on the compiled shape,
 *     `ge=1` on both pydantic models). "No pin" is encoded by ABSENCE. The compiler drops
 *     unpinned entries rather than defaulting them, and so does this module.
 */

export const DOCUMENT_TEMPLATE_ID_KEY = 'documentTemplateId';
export const DOCUMENT_VERSION_NUMBER_KEY = 'documentVersionNumber';

export interface DocumentBinding {
  templateId: string | null;
  /** `null` means "follows the template" — a deliberate configuration, not a missing value. */
  pinnedVersionNumber: number | null;
}

/**
 * How a node's pin relates to the version its template currently serves.
 *
 * `'ahead'` is not a hypothetical: `POST /admin/document-templates/:id/pin` is explicitly the
 * ROLLBACK path, so a template can move backwards past a node's pin. Folding that into
 * `'behind'` would render "New v2 available" on a node already at v3 — a false statement, and
 * exactly the kind of badge-noise that teaches admins to ignore the badge that matters.
 */
export type DocumentPinState = 'unpinned' | 'current' | 'behind' | 'ahead' | 'unresolved';

function isPin(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Reads the binding off one node's config, applying the compiler's own acceptance rule. */
export function readDocumentBinding(config: Record<string, unknown>): DocumentBinding {
  const templateId = config[DOCUMENT_TEMPLATE_ID_KEY];
  const pinned = config[DOCUMENT_VERSION_NUMBER_KEY];
  return {
    templateId: typeof templateId === 'string' && templateId.length > 0 ? templateId : null,
    pinnedVersionNumber: isPin(pinned) ? pinned : null,
  };
}

export function documentPinState(pinnedVersionNumber: number | null, templateVersionNumber: number | null): DocumentPinState {
  if (pinnedVersionNumber == null) return 'unpinned';
  if (templateVersionNumber == null) return 'unresolved';
  if (pinnedVersionNumber === templateVersionNumber) return 'current';
  return pinnedVersionNumber < templateVersionNumber ? 'behind' : 'ahead';
}

/**
 * Binds a template, or clears the binding entirely when `templateId` is null.
 *
 * Switching to a DIFFERENT template drops any existing pin: version numbers are scoped to one
 * template's lineage, so carrying v4 across would silently pin an unrelated version of an
 * unrelated shape. Re-selecting the same template leaves the pin alone.
 */
export function withDocumentTemplate(config: Record<string, unknown>, templateId: string | null): Record<string, unknown> {
  const { [DOCUMENT_TEMPLATE_ID_KEY]: previous, [DOCUMENT_VERSION_NUMBER_KEY]: pin, ...rest } = config;
  if (templateId === null) return rest;
  const keepPin = previous === templateId && isPin(pin);
  return keepPin ? { ...rest, [DOCUMENT_TEMPLATE_ID_KEY]: templateId, [DOCUMENT_VERSION_NUMBER_KEY]: pin } : { ...rest, [DOCUMENT_TEMPLATE_ID_KEY]: templateId };
}

/** Pins a version, or removes the key when `versionNumber` is null (or below the shared floor of 1). */
export function withDocumentVersion(config: Record<string, unknown>, versionNumber: number | null): Record<string, unknown> {
  const { [DOCUMENT_VERSION_NUMBER_KEY]: _dropped, ...rest } = config;
  return isPin(versionNumber) ? { ...rest, [DOCUMENT_VERSION_NUMBER_KEY]: versionNumber } : rest;
}
