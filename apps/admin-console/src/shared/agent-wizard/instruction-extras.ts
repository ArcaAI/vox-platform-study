/**
 * TASK-1036 OD-7 / OD-22 — the document template lives on the AGENT's instruction, by slug only.
 *
 * It sits beside whichever of `promptTemplateId` / `systemPrompt` / `fragments` the author chose,
 * so it is merged in AFTER `instructionFromBinding` rather than being part of that binding. A
 * `versionNumber` is deliberately not representable here: the contract refuses one, because a
 * document template floats to the latest approved version (W3).
 */
export function documentTemplateSlugOf(instruction: Record<string, unknown> | null | undefined): string | null {
  const block = instruction?.documentTemplate;
  if (block && typeof block === 'object' && typeof (block as { slug?: unknown }).slug === 'string') {
    return (block as { slug: string }).slug;
  }
  return null;
}

/** `instruction` with `documentTemplate` set to `slug`, or removed when `slug` is null; `undefined` if nothing remains. */
export function withDocumentTemplate(instruction: Record<string, unknown> | undefined, slug: string | null): Record<string, unknown> | undefined {
  const { documentTemplate: _previous, ...rest } = instruction ?? {};
  const next = slug ? { ...rest, documentTemplate: { slug } } : rest;
  return Object.keys(next).length > 0 ? next : undefined;
}
