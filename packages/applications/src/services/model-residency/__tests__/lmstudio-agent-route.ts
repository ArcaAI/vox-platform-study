import { vi } from 'vitest';

/**
 * TASK-1055 — test helper for the pre-1055 suites. The controller now commands LM Studio through
 * its residency AGENT (`ResidencyAgentClient` service `lm-studio`), not the REST engine adapter.
 * Those suites keep their engine-shaped `lmStudio` mock (report / load / unload); this routes the
 * agent client's `lm-studio` calls onto it, so their LM Studio fixtures stay as they were written.
 *
 *  - `report('lm-studio')`              → `lmStudio.report()`
 *  - `load('lm-studio', {modelRef, …})` → `lmStudio.load(modelRef, loadSpec)`
 *  - `unload('lm-studio', {modelRef})`  → `lmStudio.unload(modelRef)` → `{outcome, modelRef}`
 *  - `setPolicy('lm-studio', ref, …)`   → the reported instance with the new pin; like the real agent, the pin
 *    (and TTL) then shows on every report of that instance until it is unpinned or unloaded
 */
type Fn = (...args: never[]) => unknown;
type Agents = Record<string, Fn | undefined>;
type Engine = { report?: Fn; load?: Fn; unload?: Fn };

export function routeLmStudioThroughAgent(agents: Agents, lmStudio: Engine): void {
  const pins = new Map<string, number | null>();
  const route = (name: string, lms: (...args: never[]) => unknown) => {
    const original = agents[name];
    agents[name] = vi.fn(async (service: string, ...rest: never[]) =>
      service === 'lm-studio' ? lms(...rest) : (original as ((...a: unknown[]) => unknown) | undefined)?.(service, ...rest),
    ) as unknown as Fn;
  };
  route('report', async () => {
    if (!lmStudio.report) throw new Error('lm-studio agent not mocked');
    const report = (await lmStudio.report()) as { models: Array<Record<string, unknown>> };
    return {
      ...report,
      models: report.models.map((m) =>
        pins.has(String(m.modelRef)) ? { ...m, pinned: true, adminPinned: true, ttlSeconds: pins.get(String(m.modelRef)) ?? null } : m,
      ),
    };
  });
  route('load', async (request: { modelRef: string; loadSpec: unknown; pin?: boolean; ttlSeconds?: number | null }) => {
    if (request.pin) pins.set(request.modelRef, request.ttlSeconds ?? null);
    const result = (await (lmStudio.load as (...a: unknown[]) => Promise<{ outcome: string; model: Record<string, unknown> }>)(
      request.modelRef,
      request.loadSpec,
    )) ?? { outcome: 'loaded', model: {} };
    return { outcome: result.outcome, model: { bytes: null, bytesSource: 'unknown', ...result.model } };
  });
  route('unload', async (request: { modelRef: string }) => {
    const result = (await (lmStudio.unload as (...a: unknown[]) => Promise<{ outcome: string }>)(request.modelRef)) ?? { outcome: 'unloaded' };
    pins.delete(request.modelRef);
    return { outcome: result.outcome, modelRef: request.modelRef };
  });
  route('setPolicy', async (modelRef: string, request: { adminPinned?: boolean; ttlSeconds?: number | null }) => {
    if (request.adminPinned === true) pins.set(modelRef, request.ttlSeconds !== undefined ? request.ttlSeconds : (pins.get(modelRef) ?? null));
    else if (request.adminPinned === false) pins.delete(modelRef);
    return {
      modelRef,
      aiModelId: null,
      cache: 'llm',
      state: 'loaded',
      device: 'multi',
      bytes: null,
      bytesSource: 'unknown',
      inFlight: null,
      pinned: request.adminPinned === true,
      adminPinned: request.adminPinned === true,
      ttlSeconds: request.ttlSeconds ?? null,
      loadedAt: null,
      lastUsedAt: null,
      loadSeconds: null,
    };
  });
}
