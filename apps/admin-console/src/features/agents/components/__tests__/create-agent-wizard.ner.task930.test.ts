/**
 * TASK-930 §2.5 — the console can author a NAMED_ENTITY_RECOGNITION agent.
 *
 * Three hand-copied unions decided whether the task existed in this app at all: the `AgentTask`
 * type, the `AGENT_TASKS` list the wizard's task picker renders, and `AGENT_TASK_MODEL_TASK_TYPE`,
 * which is what filters the model picker. Miss the third and the wizard offers the task, then
 * offers no model to bind it to — a dead end that looks like an empty catalogue.
 *
 * The fourth thing worth pinning is the instruction shape: a NER agent's instruction IS its label
 * set, and an EMPTY one must be omitted rather than sent as `labels: []`. A fixed-label
 * checkpoint (`medical-ner`) carries its own taxonomy, and an empty array is a declaration the
 * author did not make.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_TASKS, AGENT_TASK_LABEL, AGENT_TASK_MODEL_TASK_TYPE } from '../../api/types';
import { buildCreateRequest } from '../create-agent-wizard';

const BASE = {
  task: 'NAMED_ENTITY_RECOGNITION' as const,
  name: 'Medical NER',
  slug: 'medical-ner',
  slugTouched: true,
  description: '',
  modelId: 'm-ner',
  fallbackModelIds: [],
  instructionMode: 'inline' as const,
  binding: { promptTemplateId: null, promptVersionNumber: null, variables: {}, contextSchemaId: null, contextSchemaVersionNumber: null },
  systemPrompt: '',
  initialPrompt: '',
  hotwords: '',
  labels: '',
  parameters: {},
  inputSchema: null,
  outputSchema: null,
};

describe('TASK-930 §2.5 — the NER task reaches the console', () => {
  it('is offered by the wizard task picker, with a label', () => {
    expect(AGENT_TASKS).toContain('NAMED_ENTITY_RECOGNITION');
    expect(AGENT_TASK_LABEL.NAMED_ENTITY_RECOGNITION).toBe('Named entity recognition');
  });

  // The model picker filters the catalogue by this value; a missing entry offers the task and
  // then no model to bind it to.
  it('filters the model picker to the TOKEN_CLASSIFICATION catalogue', () => {
    expect(AGENT_TASK_MODEL_TASK_TYPE.NAMED_ENTITY_RECOGNITION).toBe('TOKEN_CLASSIFICATION');
  });
});

describe('TASK-930 §2.5 — the NER create request', () => {
  it('sends the label set as the whole instruction', () => {
    const request = buildCreateRequest({ ...BASE, labels: 'MEDICATION, DOSAGE ,, FREQUENCY' });

    expect(request.task).toBe('NAMED_ENTITY_RECOGNITION');
    expect(request.instruction).toEqual({ labels: ['MEDICATION', 'DOSAGE', 'FREQUENCY'] });
  });

  it('omits the instruction entirely when no labels were declared', () => {
    const request = buildCreateRequest(BASE);

    expect(request.instruction).toBeUndefined();
  });

  // The context-schema binding is a TEXT_GENERATION concern; a NER agent binds no prompt and so
  // has no `{{context.*}}` vocabulary to declare.
  it('carries no context-schema binding', () => {
    const request = buildCreateRequest({
      ...BASE,
      binding: { ...BASE.binding, contextSchemaId: 'schema-1', contextSchemaVersionNumber: 2 },
    });

    expect(request).not.toHaveProperty('contextSchemaId');
  });
});
