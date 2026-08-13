// The read side of the config plane.
//
// Resolves the per-service SERVICE-LEVEL subset that the Python pull clients
// consume. It is a thin composition over two existing resolvers — the
// settings-registry effective facade (`global-kv` override lane) and the
// `AiRuntimeProfile` service — and deliberately owns no data access of its own.
//
// House constraint: effective-config carries service-level knobs
// ONLY, never per-request model choice. SMR remains a stateless gateway; the
// gateway injects `{provider, model}` per request, exactly as before.

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IAiRuntimeProfileService } from '../ai-runtime-profile/IAiRuntimeProfileService';
import type { AiRuntimeProfileResponse } from '../ai-runtime-profile/dto';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { SERVICE_RUNTIME_DEFAULTS, ServiceRuntimeKey } from '../settings-registry/descriptors/service-runtime.descriptors';
import {
  EFFECTIVE_CONFIG_SERVICES,
  EffectiveConcurrency,
  EffectiveConfigResponse,
  EffectiveConfigServiceName,
  EffectiveConfigSource,
  EffectiveRetention,
  EffectiveRuntimeProfile,
  IEffectiveConfigService,
} from './IEffectiveConfigService';

/** These keys are platform-owned; the cascade context is always the SYSTEM tenant. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * One resolved registry key: its value plus whether a DB override supplied it.
 * `value: null` means the read failed — the client keeps its bootstrap value.
 */
interface ResolvedKey {
  value: number | null;
  source: EffectiveConfigSource;
}

function isKnownService(service: string): service is EffectiveConfigServiceName {
  return (EFFECTIVE_CONFIG_SERVICES as readonly string[]).includes(service);
}

/** A row with no opinion on any tunable leaves the service on its own env values. */
function hasOpinion(row: AiRuntimeProfileResponse): boolean {
  return (
    row.temperature !== null ||
    row.topP !== null ||
    row.maxTokens !== null ||
    row.contextLength !== null ||
    row.maxConcurrent !== null ||
    row.tpmLimit !== null ||
    row.rpmLimit !== null ||
    row.timeoutS !== null ||
    row.keepAliveSeconds !== null
  );
}

@Injectable()
export class EffectiveConfigService implements IEffectiveConfigService {
  private readonly logger = new Logger(EffectiveConfigService.name);

  constructor(
    private readonly effectiveSettings: EffectiveSettingsService,
    // Optional so graphs that never serve smr/nlp profiles (and unit tests) keep
    // working; an unwired service yields an empty profile list rather than a 500.
    @Optional() @Inject(IAiRuntimeProfileService) private readonly runtimeProfiles?: IAiRuntimeProfileService,
  ) {}

  async resolveForService(service: string): Promise<EffectiveConfigResponse> {
    if (!isKnownService(service)) {
      throw new ArgumentInvalidException(`Unknown service '${service}'. Expected one of: ${EFFECTIVE_CONFIG_SERVICES.join(', ')}.`);
    }

    const base: EffectiveConfigResponse = { service, generatedAt: new Date().toISOString() };

    switch (service) {
      case 'smr':
        // Service-level knobs only. temperature/topP/maxTokens still travel
        // per-request via the gateway's profile injection.
        // `retention.ttlSeconds` is the ONLY retention field
        // meaningful here — SMR holds no weights, so it forwards this to the
        // engine (Ollama `keep_alive` / LM Studio `ttl`) instead of caching.
        return {
          ...base,
          runtimeProfiles: await this.listProfiles(),
          retention: await this.resolveRetention('smr'),
        };

      case 'nlp':
        return {
          ...base,
          runtimeProfiles: await this.listProfiles(),
          retention: await this.resolveRetention('nlp'),
          concurrency: await this.resolveConcurrency(['nlp.inference.maxConcurrent']),
        };

      case 'stt':
        return {
          ...base,
          retention: await this.resolveRetention('stt'),
          concurrency: await this.resolveConcurrency(['stt.workers.concurrency', 'stt.streaming.maxConcurrent']),
        };

      // These subsets were reserved and are now filled, in the same
      // shape, so clients already polling them see fields appear rather than
      // change meaning.
      case 'guardrail':
        return { ...base, retention: await this.resolveRetention('guardrail') };

      case 'harness':
        return { ...base, retention: await this.resolveRetention('harness') };

      case 'tts':
        return { ...base, retention: await this.resolveRetention('tts') };
    }
  }

  private async listProfiles(): Promise<EffectiveRuntimeProfile[]> {
    if (!this.runtimeProfiles) {
      return [];
    }

    const rows = await this.runtimeProfiles.list();
    return rows.map((row) => ({
      provider: row.provider,
      modelSlug: row.modelSlug,
      temperature: row.temperature,
      topP: row.topP,
      maxTokens: row.maxTokens,
      contextLength: row.contextLength,
      maxConcurrent: row.maxConcurrent,
      tpmLimit: row.tpmLimit,
      rpmLimit: row.rpmLimit,
      timeoutS: row.timeoutS,
      keepAliveSeconds: row.keepAliveSeconds,
      extraJson: row.extraJson,
      source: hasOpinion(row) ? 'db' : 'env-fallback',
    }));
  }

  /**
   * Resolve one service's retention subset.
   *
   * `smr` gets ttlSeconds ONLY: it owns no cache, so `maxModels`/`maxMemoryMb`/
   * `vramBudgetMb` are meaningless there and stay null rather than being
   * invented. `maxMemoryMb` remains stt-only (its historical MB budget);
   * every other service uses the generalized `vramBudgetMb`.
   */
  private async resolveRetention(service: 'stt' | 'nlp' | 'guardrail' | 'harness' | 'tts' | 'smr'): Promise<EffectiveRetention> {
    const ttl = await this.resolveKey(`${service}.modelCache.ttlSeconds` as ServiceRuntimeKey);

    if (service === 'smr') {
      return { ttlSeconds: ttl.value, maxModels: null, maxMemoryMb: null, vramBudgetMb: null, source: ttl.source };
    }

    const [maxModels, vramBudgetMb, maxMemoryMb] = await Promise.all([
      this.resolveKey(`${service}.modelCache.maxModels` as ServiceRuntimeKey),
      this.resolveKey(`${service}.modelCache.vramBudgetMb` as ServiceRuntimeKey),
      service === 'stt' ? this.resolveKey('stt.modelCache.maxMemoryMb') : Promise.resolve<ResolvedKey>({ value: null, source: 'env-fallback' }),
    ]);

    return {
      ttlSeconds: ttl.value,
      maxModels: maxModels.value,
      maxMemoryMb: maxMemoryMb.value,
      vramBudgetMb: vramBudgetMb.value,
      source: groupSource([ttl, maxModels, vramBudgetMb, maxMemoryMb]),
    };
  }

  /**
   * `keys` names only the ceilings this service actually consumes; every other
   * field stays null so the client leaves its own value alone.
   */
  private async resolveConcurrency(keys: ServiceRuntimeKey[]): Promise<EffectiveConcurrency> {
    const resolved = new Map<ServiceRuntimeKey, ResolvedKey>(await Promise.all(keys.map(async (key) => [key, await this.resolveKey(key)] as const)));
    const pick = (key: ServiceRuntimeKey): number | null => resolved.get(key)?.value ?? null;

    return {
      maxConcurrent: pick('nlp.inference.maxConcurrent'),
      workerConcurrency: pick('stt.workers.concurrency'),
      streamingMaxConcurrent: pick('stt.streaming.maxConcurrent'),
      source: groupSource([...resolved.values()]),
    };
  }

  /**
   * A control-plane read failure is NOT an endpoint failure: it degrades to
   * `env-fallback` with a null value, so the client keeps its bootstrap value
   * and the service behaves exactly as it does today (deterministic
   * degradation). Logged once per read so the condition stays visible.
   */
  private async resolveKey(key: ServiceRuntimeKey): Promise<ResolvedKey> {
    try {
      const result = await this.effectiveSettings.resolveEffective(key, {
        tenantId: SYSTEM_TENANT_ID,
        departmentId: null,
        doctorId: null,
      });

      const value = typeof result.value === 'number' ? result.value : SERVICE_RUNTIME_DEFAULTS[key];
      // The facade reports the winning cascade tier; only `code-default` means
      // "no DB override exists", which is what the wire calls `env-fallback`.
      return { value, source: result.sourceScope === 'code-default' ? 'env-fallback' : 'db' };
    } catch (error) {
      this.logger.warn({
        message: 'Effective-config key read failed — degrading to env-fallback',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return { value: null, source: 'env-fallback' };
    }
  }
}

/** A group reads as `db` only if at least one of its keys was overridden. */
function groupSource(keys: ResolvedKey[]): EffectiveConfigSource {
  return keys.some((k) => k.source === 'db') ? 'db' : 'env-fallback';
}
