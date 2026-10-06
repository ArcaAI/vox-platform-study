/**
 * TASK-1047 — what the harness note plan needs from the prompt assembly to stay governed.
 *
 * - The composer's `system` callback must hand back the assembly's `governance` (FC-2) so each planned
 *   call can carry FC-4 `systemGovernance`; without it apps/text screens the system prompt as untrusted.
 * - The doctor's style reference is DATA (FC-1): it travels as a plan background block, which the
 *   static `dna-style` contract part points at.
 */
import type { SystemGovernance } from '@arcaai/workflow-contract';
import type { NoteComposedSystem } from '../note-composition/note-input-composer.service';

export function noteComposedSystem(assembled: {
  systemPrompt: string;
  governance?: SystemGovernance | null;
  platformPieces?: NoteComposedSystem['platformPieces'];
}): NoteComposedSystem {
  return {
    system: assembled.systemPrompt,
    governance: assembled.governance ?? null,
    ...(assembled.platformPieces ? { platformPieces: assembled.platformPieces } : {}),
  };
}

export function styleReferenceBackground(styleReference: string | null | undefined): Array<{ key: string; label: string; text: string }> {
  const text = styleReference?.trim();
  return text ? [{ key: 'style_reference', label: 'Style reference', text: styleReference as string }] : [];
}
