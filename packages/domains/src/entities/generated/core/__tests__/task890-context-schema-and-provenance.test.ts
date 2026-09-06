/**
 * TASK-890 L2 — the schema deltas, at the entity/factory layer.
 *
 * Four facts this pins, all of which the hand-authored trio has to carry for the
 * lanes downstream (L8's agent pin, L10's BYO models, L13's reference set):
 *
 *  1. `Agent` carries the context-schema REFERENCE pair, change-tracked like any
 *     other column (a `setProperty` that never fired would silently drop the pin
 *     on `repository.update`, which persists `entity.changes` alone);
 *  2. `AiModel` carries `sourceConnectionId`, the BYO provenance;
 *  3. `PromptTemplate` / `WorkflowDefinition` carry the reference-set provenance
 *     pair the golden-library models already had;
 *  4. the four deprecated download-bookkeeping columns are GONE from the entity —
 *     asserted at runtime as well as by the compiler, because a stale reader that
 *     reaches for `entity.localPath` now gets `undefined` rather than a mount path,
 *     and `undefined` silently means "no weights" to anything that truthy-checks it.
 */
import { describe, expect, it } from 'vitest';
import { AgentFactory } from '../../../../factories';
import { AiModelFactory } from '../../../../factories';
import { PromptTemplateFactory } from '../../../../factories';
import { WorkflowDefinitionFactory } from '../../../../factories';
import {
  AgentTask,
  AiDeploymentKind,
  AiModelFormat,
  AiModelSource,
  ModelCategory,
  ModelTaskType,
  ModelType,
  PromptTemplateCategory,
} from '../../../../enums';

const TENANT = '50000000-0000-0000-0000-000000000000';

function anAgent() {
  return AgentFactory.CreateAgent({
    tenantId: TENANT,
    slug: 'clinical-summarizer',
    name: 'Clinical Summarizer',
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 1,
    modelId: '80000000-0000-0000-0005-000000000060',
  });
}

function aModel() {
  return AiModelFactory.CreateAiModel({
    tenantId: TENANT,
    name: 'Tenant GPT',
    slug: 'tenant-gpt',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'gpt-5.4-mini',
    format: AiModelFormat.SAFETENSOR,
    libraryName: 'openai',
    servedBy: 'text',
    deploymentKind: AiDeploymentKind.CLOUD,
  });
}

describe('TASK-890 — Agent.contextSchemaId / contextSchemaVersionNumber', () => {
  it('defaults to no binding: an agent that declares no context schema', () => {
    const agent = anAgent();

    expect(agent.contextSchemaId).toBeNull();
    expect(agent.contextSchemaVersionNumber).toBeNull();
  });

  it('accepts the reference pair from the factory', () => {
    const agent = AgentFactory.CreateAgent({
      tenantId: TENANT,
      slug: 'clinical-summarizer',
      name: 'Clinical Summarizer',
      task: AgentTask.TEXT_GENERATION,
      versionNumber: 1,
      modelId: '80000000-0000-0000-0005-000000000060',
      contextSchemaId: '79000000-0000-0000-0001-000000000010',
      contextSchemaVersionNumber: 3,
    });

    expect(agent.contextSchemaId).toBe('79000000-0000-0000-0001-000000000010');
    expect(agent.contextSchemaVersionNumber).toBe(3);
  });

  it('tracks a later binding as a CHANGE, so `repository.update` persists it', () => {
    const agent = anAgent();

    agent.contextSchemaId = '79000000-0000-0000-0001-000000000010';
    agent.contextSchemaVersionNumber = 2;

    expect(agent.hasChanges).toBe(true);
    expect(agent.changes).toMatchObject({ contextSchemaId: '79000000-0000-0000-0001-000000000010', contextSchemaVersionNumber: 2 });
  });
});

describe('TASK-890 — AiModel BYO provenance and the dropped bookkeeping', () => {
  it('a platform (SYSTEM catalogue) row declares no source connection', () => {
    expect(aModel().sourceConnectionId).toBeNull();
  });

  it('carries `sourceConnectionId` and change-tracks it', () => {
    const model = aModel();

    model.sourceConnectionId = '90000000-0000-0000-0001-000000000001';

    expect(model.sourceConnectionId).toBe('90000000-0000-0000-0001-000000000001');
    expect(model.changes).toMatchObject({ sourceConnectionId: '90000000-0000-0000-0001-000000000001' });
  });

  it('no longer exposes the four deprecated download-bookkeeping columns', () => {
    const model = aModel() as unknown as Record<string, unknown>;

    for (const dropped of ['downloadStatus', 'downloadedAt', 'fileSizeMb', 'localPath']) {
      expect(dropped in model, `AiModelEntity still exposes \`${dropped}\``).toBe(false);
    }
  });

  it('no longer exposes the download lifecycle methods that wrote them', () => {
    const model = aModel() as unknown as Record<string, unknown>;

    for (const dropped of [
      'markAsDownloading',
      'markAsDownloaded',
      'markAsDownloadFailed',
      'resetDownloadStatus',
      'isDownloaded',
      'isDownloading',
      'isDownloadFailed',
      'isNotDownloaded',
    ]) {
      expect(dropped in model, `AiModelEntity still exposes \`${dropped}\``).toBe(false);
    }
  });
});

describe('TASK-890 — the reference-set provenance pair', () => {
  it('PromptTemplate carries `sourceTemplateId` + `templateLocked`', () => {
    const pristine = PromptTemplateFactory.CreatePromptTemplate({
      tenantId: TENANT,
      name: 'Consultation summary',
      content: 'Summarise {{context.clinician_notes}}.',
      category: PromptTemplateCategory.SUMMARY,
      sourceTemplateId: '71000000-0000-0000-0000-000000000040',
      templateLocked: true,
    });

    expect(pristine.sourceTemplateId).toBe('71000000-0000-0000-0000-000000000040');
    expect(pristine.templateLocked).toBe(true);

    const authored = PromptTemplateFactory.CreatePromptTemplate({
      tenantId: TENANT,
      name: 'A tenant original',
      content: 'Hello.',
      category: PromptTemplateCategory.CUSTOM,
    });

    // A row the tenant wrote itself has no provenance and is never re-synced over.
    expect(authored.sourceTemplateId).toBeNull();
    expect(authored.templateLocked).toBe(false);
  });

  it('WorkflowDefinition carries `sourceTemplateSlug` + `templateLocked`', () => {
    const clone = WorkflowDefinitionFactory.CreateDefinition({
      tenantId: TENANT,
      slug: 'platform-default-summarization',
      name: 'Platform default summarization',
      paletteKey: 'summarization',
      versionNumber: 1,
      graph: { version: 1, nodes: [], edges: [] } as never,
      graphChecksum: 'deadbeef',
      sourceTemplateSlug: 'platform-default-summarization',
      templateLocked: true,
    });

    expect(clone.sourceTemplateSlug).toBe('platform-default-summarization');
    expect(clone.templateLocked).toBe(true);

    const authored = WorkflowDefinitionFactory.CreateDefinition({
      tenantId: TENANT,
      slug: 'my-own',
      name: 'My own',
      paletteKey: 'summarization',
      versionNumber: 1,
      graph: { version: 1, nodes: [], edges: [] } as never,
      graphChecksum: 'deadbeef',
    });

    expect(authored.sourceTemplateSlug).toBeNull();
    expect(authored.templateLocked).toBe(false);
  });
});
