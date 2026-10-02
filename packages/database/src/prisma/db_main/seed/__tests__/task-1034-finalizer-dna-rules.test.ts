/**
 * TASK-1034 R3 — the finalizer is TOLD the clinician's redaction rules
 * (`dna_redaction_rules_text`, a bullet list the live handoff renders behind the redaction gate)
 * under "Never include / always rewrite". The deterministic post-generation pass stays the
 * guarantee; the block renders empty — and the prompt still composes — when no rules apply.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { NOTE_CONTEXT_SCHEMA_DEFINITION } from '../07e-consultation-note-context-schema';
import { CASENOTE_FINALIZATION_SYSTEM_PROMPT, CLINICAL_NOTE_FRAGMENT_KEY } from '../25-agents';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);

const BINDING = '{{context.dna_redaction_rules_text | default("")}}';
const RULES = '- Never write "Ms. Ada Byron".\n- Always write "pt" as "patient".';

const compose = (live: Record<string, unknown>) => {
  const trigger = { ...live, context: { ...live } };
  return contract.composePrompt(
    { source: 'composite', fragments: [{ key: CLINICAL_NOTE_FRAGMENT_KEY, source: 'inline', content: CASENOTE_FINALIZATION_SYSTEM_PROMPT }] },
    { trigger, context: trigger, vars: {}, nodes: {}, variables: {} },
  );
};

describe('TASK-1034 R3 — the finalization prompt carries the clinician`s redaction rules', () => {
  it('binds `dna_redaction_rules_text` with a default, under "Never include / always rewrite"', () => {
    expect(CASENOTE_FINALIZATION_SYSTEM_PROMPT).toContain(BINDING);
    expect(CASENOTE_FINALIZATION_SYSTEM_PROMPT).toContain('Never include / always rewrite');
  });

  it('renders the rules into the durable prompt when the handoff carries them', () => {
    const composed = compose({ dna_redaction_rules_text: RULES });
    expect(composed.prompt).toContain(`Never include / always rewrite:\n${RULES}\n`);
  });

  it('renders cleanly with no rules (the default applies)', () => {
    const composed = compose({});
    expect(composed.prompt).toContain('Never include / always rewrite:\n\n');
    expect(composed.prompt).not.toContain('{{');
  });

  it('is a declared field of `consultation_note_context`, next to `dna_style_text`', () => {
    const kind = (NOTE_CONTEXT_SCHEMA_DEFINITION.kinds as Array<Record<string, any>>).find((k) => k.key === 'context') as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(kind.fields.properties.dna_redaction_rules_text).toMatchObject({ type: 'string' });
  });
});
