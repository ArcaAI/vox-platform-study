// TASK-525 §4.1 — the read side of the config plane.
//
// Resolves the per-service SERVICE-LEVEL subset that the Python pull clients
// consume. It is a thin composition over two existing resolvers — the TASK-524
// settings-registry effective facade (`global-kv` override lane) and the
// `AiRuntimeProfile` service — and deliberately owns no data access of its own.
//
// House constraint (TASK-525 §1): effective-config carries service-level knobs
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
        // per-request via the gateway's profile injection (TASK-524).
        return { ...base, runtimeProfiles: await this.listProfiles() };

      case 'nlp':
        return {
          ...base,
          runtimeProfiles: await this.listProfiles(),
          concurrency: await this.resolveConcurrency(['nlp.inference.maxConcurrent']),
        };

      case 'stt-v2':
        return {
          ...base,
          retention: await this.resolveRetention(),
          concurrency: await this.resolveConcurrency(['stt.workers.concurrency', 'stt.streaming.maxConcurrent']),
        };

      // Reserved subsets — the contract is frozen now so TASK-529 / TASK-533-B
      // can fill them without a breaking change for clients already polling.
      case 'guardrail':
      case 'harness':
      case 'tts-v2':
        return base;
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

  private async resolveRetention(): Promise<EffectiveRetention> {
    const [ttl, maxModels, maxMemoryMb] = await Promise.all([
      this.resolveKey('stt.modelCache.ttlSeconds'),
      this.resolveKey('stt.modelCache.maxModels'),
      this.resolveKey('stt.modelCache.maxMemoryMb'),
    ]);

    return {
      ttlSeconds: ttl.value,
      maxModels: maxModels.value,
      maxMemoryMb: maxMemoryMb.value,
      source: groupSource([ttl, maxModels, maxMemoryMb]),
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
   * and the service behaves exactly as it does today (§3.1 deterministic
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
