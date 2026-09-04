/** TASK-864 A7 — generated OpenAPI/AsyncAPI documentation from a workflow's Trigger and Output. */
import { describe, expect, it } from 'vitest';
import { componentName, describeWorkflow, modesFor } from '../workflow-schema-description';

const graph = {
  nodes: [
    { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api', 'webhook'], contextSchema: { inline: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } } },
    { id: 'n_agent', type: 'core.agent', config: { agentRef: { slug: 'platform-summarization' } } },
    { id: 'n_output', type: 'core.output', config: { protocols: ['http-sse', 'socket'], outputSchema: { type: 'object', properties: { summary: { type: 'string' } } } } },
  ],
};

describe('describeWorkflow', () => {
  it('names the component pair after the slug, safely', () => {
    expect(componentName('discharge-summary', 'Input')).toBe('Workflow_discharge_summary_Input');
  });

  it('projects the Trigger and Output schemas into components and the protocols into modes', () => {
    const description = describeWorkflow('triage', 3, graph);
    expect(Object.keys(description.components)).toEqual(['Workflow_triage_Input', 'Workflow_triage_Output']);
    expect(description.components.Workflow_triage_Input).toMatchObject({ type: 'object', required: ['text'] });
    expect(description.components.Workflow_triage_Output).toMatchObject({ properties: { summary: { type: 'string' } } });
    expect(description.triggerKinds).toEqual(['api', 'webhook']);
    expect(description.protocols).toEqual(['http-sse', 'socket']);
    expect(description.modes).toEqual(['async', 'stream']);
  });

  it('emits an AsyncAPI channel per stream protocol, sharing one envelope schema', () => {
    const { asyncapi } = describeWorkflow('triage', 3, graph) as { asyncapi: { channels: Record<string, unknown>; components: { schemas: Record<string, unknown> } } };
    expect(Object.keys(asyncapi.channels)).toEqual(['workflows/triage/runs/{runId}/stream', 'ws/workflows']);
    expect(asyncapi.components.schemas.RunEventEnvelope).toBeDefined();
  });

  it('a legacy graph documents open objects and every mode', () => {
    const description = describeWorkflow('legacy', 1, { nodes: [{ id: 'a', type: 'core.start', config: {} }] });
    expect(description.components.Workflow_legacy_Input).toMatchObject({ type: 'object', additionalProperties: true });
    expect(description.modes).toEqual(['async', 'blocking', 'stream']);
    expect(modesFor([])).toEqual(['async', 'blocking', 'stream']);
    expect(modesFor(['http'])).toEqual(['async', 'blocking']);
  });
});
