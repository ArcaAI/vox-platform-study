/**
 * TASK-1004 §4.5 — publishing a workflow that names a SPEECH_TO_TEXT agent returns that agent's
 * language warnings. The node names only the agent; nothing is blocked or re-routed.
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionController } from '../workflow-definition.controller';

const WARNING = {
  code: 'LANGUAGE_MODE_DEGRADED',
  agentSlug: 'platform-transcription',
  mode: 'ml-en',
  engine: 'WHISPER_CPP',
  level: 'degraded',
  message: 'm',
};

describe('WorkflowDefinitionController.publish — language warnings', () => {
  const compiledConfig = { stages: [{ nodes: [{ nodeId: 'n_asr', type: 'core.agent', config: { agentRef: { slug: 'platform-transcription' } } }] }] };
  const build = (warnings: unknown[]) => {
    const service = { publish: vi.fn(async () => ({ id: 'wf-1', tenantId: 't-1', slug: 'consult', compiledConfig, version: 4 })) };
    const capability = { warningsForWorkflow: vi.fn().mockResolvedValue(warnings) };
    return { controller: new WorkflowDefinitionController(service as never, {} as never, capability as never), capability };
  };

  it('carries the warnings of the ASR agent the published graph names', async () => {
    const { controller, capability } = build([WARNING]);
    const out = await controller.publish('wf-1', {} as never);
    expect(capability.warningsForWorkflow).toHaveBeenCalledWith('t-1', compiledConfig);
    expect(out).toMatchObject({ id: 'wf-1', warnings: [WARNING] });
  });

  it('no warnings → no key (the response is otherwise unchanged)', async () => {
    const { controller } = build([]);
    expect(await controller.publish('wf-1', {} as never)).not.toHaveProperty('warnings');
  });
});
