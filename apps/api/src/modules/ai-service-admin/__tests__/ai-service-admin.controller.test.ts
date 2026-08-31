/**
 * AiServiceAdminController unit tests.
 *
 * Read-only status/config plane over the Guardrail + NLP Python services via
 * the gateway proxy. Platform-infra tier: class-level `manage:all` (matches
 * the queue/platform-metrics posture — these documents expose engine/model
 * internals, not tenant data). No mutation routes exist by design: neither
 * Python service exposes config writes internally.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { AiServiceAdminController } from '../ai-service-admin.controller';

function makeController() {
  const client = {
    guardrailStatus: vi.fn().mockResolvedValue({ status: 'healthy', service: 'guardrail' }),
    guardrailConfig: vi.fn().mockResolvedValue({ medicalValidation: {}, analysisTypes: {} }),
    nlpStatus: vi.fn().mockResolvedValue({ status: 'healthy', service: 'nlp' }),
  };
  const mlflow = {
    status: vi.fn().mockResolvedValue({ baseUrl: 'http://localhost:5000', reachable: false, probeStatus: 'error', embeddable: false }),
    searchExperiments: vi.fn().mockResolvedValue({ experiments: [] }),
    searchRegisteredModels: vi.fn().mockResolvedValue({ registered_models: [] }),
    searchModelVersions: vi.fn().mockResolvedValue({ model_versions: [] }),
  };
  const controller = new AiServiceAdminController(client as never, mlflow as never);
  return { controller, client, mlflow };
}

describe('AiServiceAdminController — authorization metadata', () => {
  it('mounts at admin/ai-services behind class-level manage:all (platform tier)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiServiceAdminController)).toBe('admin/ai-services');
    expect(Reflect.getMetadata('required_permissions', AiServiceAdminController)).toEqual([{ action: 'manage', subject: 'all' }]);
  });

  it('exposes read routes only — no config mutation exists upstream that we should proxy', () => {
    const proto = AiServiceAdminController.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.guardrailStatus).toBe('function');
    expect(typeof proto.guardrailConfig).toBe('function');
    expect(typeof proto.nlpStatus).toBe('function');
    expect(typeof proto.mlflowStatus).toBe('function');
    expect(typeof proto.mlflowExperiments).toBe('function');
    expect(typeof proto.mlflowRegisteredModels).toBe('function');
    expect(typeof proto.mlflowModelVersions).toBe('function');
    expect(proto.updateGuardrailConfig).toBeUndefined();
    expect(proto.updateNlpConfig).toBeUndefined();
  });

  it('proxies NO MLflow write or delete verb — erasure stays with `mlflow gc`, not a console button', () => {
    const proto = AiServiceAdminController.prototype as unknown as Record<string, unknown>;
    for (const forbidden of ['mlflowDeleteExperiment', 'mlflowDeleteModelVersion', 'mlflowTransitionStage', 'mlflowSetAlias', 'mlflowGc']) {
      expect(proto[forbidden], `${forbidden} must not exist on the read plane`).toBeUndefined();
    }
  });
});

describe('AiServiceAdminController — delegation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('guardrailStatus proxies the guardrail health document', async () => {
    const { controller, client } = makeController();
    await expect(controller.guardrailStatus()).resolves.toEqual({ status: 'healthy', service: 'guardrail' });
    expect(client.guardrailStatus).toHaveBeenCalledTimes(1);
  });

  it('guardrailConfig proxies the merged config read', async () => {
    const { controller, client } = makeController();
    await expect(controller.guardrailConfig()).resolves.toEqual({ medicalValidation: {}, analysisTypes: {} });
    expect(client.guardrailConfig).toHaveBeenCalledTimes(1);
  });

  it('nlpStatus proxies the NLP health document', async () => {
    const { controller, client } = makeController();
    await expect(controller.nlpStatus()).resolves.toEqual({ status: 'healthy', service: 'nlp' });
    expect(client.nlpStatus).toHaveBeenCalledTimes(1);
  });

  it('mlflowStatus returns the reachability document rather than throwing when MLflow is down', async () => {
    const { controller, mlflow } = makeController();
    await expect(controller.mlflowStatus()).resolves.toMatchObject({ reachable: false, embeddable: false });
    expect(mlflow.status).toHaveBeenCalledTimes(1);
  });

  it('forwards the validated search window to each MLflow read verb', async () => {
    const { controller, mlflow } = makeController();
    const window = { maxResults: 25, filter: "name LIKE 'whisper%'" };

    await controller.mlflowExperiments(window);
    await controller.mlflowRegisteredModels(window);
    await controller.mlflowModelVersions(window);

    expect(mlflow.searchExperiments).toHaveBeenCalledWith(window);
    expect(mlflow.searchRegisteredModels).toHaveBeenCalledWith(window);
    expect(mlflow.searchModelVersions).toHaveBeenCalledWith(window);
  });
});
