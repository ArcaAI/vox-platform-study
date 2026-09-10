/**
 * TASK-947 §4.5 item 2 — the create wizard's request builder for the fragments instruction form.
 * `buildCreateRequest` delegates TEXT_GENERATION serialization to `instructionFromBinding`
 * (proven in `instruction-round-trip.task947.test.ts`); this pins the wizard's own call site,
 * mirroring `create-agent-wizard.ner.task930.test.ts`'s shape for the NER instruction.
 */
import { describe, expect, it } from 'vitest';
import { instructionToBinding } from '../instruction-binding-form';
import { buildCreateRequest } from '../create-agent-wizard';

const BASE = {
  task: 'TEXT_GENERATION' as const,
  name: 'Clinic summarizer',
  slug: 'clinic-summarizer',
  slugTouched: true,
  description: '',
  modelId: 'm-1',
  fallbackModelIds: [],
  binding: instructionToBinding(null, null, null),
  initialPrompt: '',
  hotwords: '',
  labels: '',
  parameters: {},
  inputSchema: null,
  outputSchema: null,
};

describe('TASK-947 — buildCreateRequest (fragments instruction)', () => {
  it('sends the fragment list and the agent-level variables union', () => {
    const instruction = {
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-1', promptVersionNumber: 3 },
        { key: 'revisit', promptTemplateId: 'tpl-1', when: "has(context.visit_type) && context.visit_type == 'revisit'" },
      ],
      variables: { language: { path: 'context.language' } },
    };
    const request = buildCreateRequest({ ...BASE, binding: { ...instructionToBinding(instruction, null, null) } });

    expect(request.instruction).toEqual(instruction);
  });

  it('omits the instruction entirely when the fragments list is empty', () => {
    const request = buildCreateRequest({ ...BASE, binding: { ...instructionToBinding(null, null, null), mode: 'fragments', fragments: [] } });

    expect(request.instruction).toBeUndefined();
  });

  it('still carries the contextSchemaId binding in fragments mode', () => {
    const binding = { ...instructionToBinding({ fragments: [{ key: 'base', promptTemplateId: 'tpl-1' }] }, 'schema-1', 2) };
    const request = buildCreateRequest({ ...BASE, binding });

    expect(request).toMatchObject({ contextSchemaId: 'schema-1', contextSchemaVersionNumber: 2 });
  });
});
