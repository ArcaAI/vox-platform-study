/**
 * TASK-1019 — the lifecycle status and the registry operations must actually be
 * WIRED. Both residency and settings are injected `@Optional()`, so a missing
 * import would not fail the boot: every row would silently lose its per-service
 * evidence and the unregister would refuse with "residency not available".
 */
import { describe, expect, it } from 'vitest';
import { AiModelServiceModule } from '../aiModel.service.module';

describe('AiModelServiceModule — TASK-1019 wiring', () => {
  it('imports the residency plane and the settings source, and provides + exports the new services', () => {
    const imports = (
      (Reflect.getMetadata('imports', AiModelServiceModule) as Array<{ name?: string; module?: { name?: string } } | undefined>) ?? []
    ).map((m) => m?.name ?? m?.module?.name);
    expect(imports).toEqual(expect.arrayContaining(['ModelResidencyServiceModule', 'CommonServiceModule', 'AiModelDownloadProducerModule']));

    const providers = ((Reflect.getMetadata('providers', AiModelServiceModule) as Array<{ name?: string }>) ?? []).map((p) => p.name);
    expect(providers).toEqual(
      expect.arrayContaining(['AiModelService', 'ModelLifecycleService', 'ModelUsageReader', 'ModelRegistryOperationsService']),
    );
    const exported = ((Reflect.getMetadata('exports', AiModelServiceModule) as Array<{ name?: string }>) ?? []).map((p) => p.name);
    expect(exported).toEqual(expect.arrayContaining(['ModelRegistryOperationsService', 'ModelLifecycleService']));
  });
});
