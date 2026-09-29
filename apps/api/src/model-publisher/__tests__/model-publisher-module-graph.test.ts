/**
 * TASK-1019 P11 — the model publisher's consumer runs in ONE process.
 *
 * `hope-api` (AppModule) must carry the producer only: were the processor in
 * its graph, every gateway pod would consume `DownloadAiModel` jobs again — in
 * a process with neither the `hope-models` write/delete credential nor
 * staging space. The worker root module must carry the processor and the
 * publisher's own store, and none of the gateway's controllers.
 *
 * Walks the `@Module` metadata (static + dynamic modules, forwardRefs)
 * without instantiating anything.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AiModelDownloadProcessor, AiModelDownloadService, AiModelUnregisterService, BlobStorageProviderFactory, ModelStoreFactory, ModelUsageReader } from '@arcaai/applications';

type AnyModule = unknown;

async function collectGraph(root: AnyModule): Promise<{ providers: Set<unknown>; controllers: Set<unknown> }> {
  const providers = new Set<unknown>();
  const controllers = new Set<unknown>();
  const seen = new Set<unknown>();

  const visit = async (entry: AnyModule): Promise<void> => {
    let mod = await entry;
    if (!mod) return;
    if (typeof mod === 'object' && 'forwardRef' in (mod as object)) mod = (mod as { forwardRef: () => unknown }).forwardRef();
    if (seen.has(mod)) return;
    seen.add(mod);

    const isDynamic = typeof mod === 'object' && mod !== null && 'module' in (mod as object);
    const cls = isDynamic ? (mod as { module: unknown }).module : mod;
    const meta = (key: string) => (Reflect.getMetadata(key, cls as object) as unknown[] | undefined) ?? [];
    const dyn = (key: string) => (isDynamic ? (((mod as Record<string, unknown>)[key] as unknown[] | undefined) ?? []) : []);

    for (const p of [...meta('providers'), ...dyn('providers')]) {
      providers.add(typeof p === 'function' ? p : ((p as { useClass?: unknown; provide?: unknown })?.useClass ?? (p as { provide?: unknown })?.provide));
    }
    for (const c of [...meta('controllers'), ...dyn('controllers')]) controllers.add(c);
    if (isDynamic && !seen.has(cls)) await visit(cls);
    for (const imported of [...meta('imports'), ...dyn('imports')]) await visit(imported);
  };

  await visit(root);
  return { providers, controllers };
}

describe('model publisher module graph (P11)', () => {
  it('hope-api (AppModule) carries the producer but NO AiModelDownloadProcessor', async () => {
    const { AppModule } = await import('../../app.module');
    const { providers } = await collectGraph(AppModule);

    expect(providers.has(AiModelDownloadService)).toBe(true);
    expect(providers.has(AiModelDownloadProcessor)).toBe(false);
    expect(providers.has(ModelStoreFactory)).toBe(false);
    expect(providers.has(AiModelUnregisterService)).toBe(false);
  }, 120_000);

  it('the worker root module carries the processor, the publisher store and the unregister service — and no gateway controllers', async () => {
    const { ModelPublisherWorkerModule } = await import('../model-publisher-worker.module');
    const { providers, controllers } = await collectGraph(ModelPublisherWorkerModule);

    expect(providers.has(AiModelDownloadProcessor)).toBe(true);
    expect(providers.has(ModelStoreFactory)).toBe(true);
    expect(providers.has(AiModelUnregisterService)).toBe(true);
    // I9 — the unregister job re-checks referrers itself before deleting anything.
    expect(providers.has(ModelUsageReader)).toBe(true);
    // Globals the gateway registers once at its root (`AppModule`) must be registered
    // at the worker's root too, or a transitively imported service (TenantBucketService
    // via the usage reader) fails dependency resolution at boot.
    expect(providers.has(BlobStorageProviderFactory)).toBe(true);
    // `PrometheusController` rides in with `ObservabilityModule` (via
    // `CommonServiceModule`); an application context mounts no HTTP server, so
    // it is inert. Nothing from the gateway's own surface may be here.
    expect([...controllers].map((c) => (c as { name?: string }).name)).toEqual(['PrometheusController']);
  }, 120_000);
});
