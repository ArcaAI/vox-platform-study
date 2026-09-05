// The read side of the config plane.
//
// Resolves the per-service SERVICE-LEVEL subset that the Python pull clients
// consume. It is a thin composition over the existing resolvers — the
// settings-registry effective facade (`global-kv` override lane), the
// `AiProviderConnection` ceilings (TASK-862) and the `AiRoutingPolicy` election/`AiModel` pair — and
// deliberately owns no data access of its own.
//
// TWO HOUSE CONSTRAINTS, both load-bearing:
//
//  1. SERVICE-LEVEL knobs ONLY, never per-request model choice. TEXT remains a
//     stateless gateway; the gateway injects `{provider, model}` per request.
//  2. PLATFORM SCOPE ONLY (owner decision D-1). This route is pinned to the
//     SYSTEM tenant and stays that way: one cached snapshot per service
//     process, forever. A per-tenant pull would scale cache-stampede and memory
//     with customer count. Anything that can vary by tenant travels the PUSH
//     channel — per-request gateway injection — instead. The registry enforces
//     the split by convention: a `maxScope: 'tenant'` descriptor does not
//     declare `consumedBy`.
//
// WHAT CHANGED, and why it is the whole point: the per-service payload used to
// be a hand-written `switch` over a `number | null` value type, so (a) adding
// one key meant four coordinated edits and (b) a non-number was SILENTLY
// coerced to the code default, which made strings, enums, URLs, booleans and
// label taxonomies impossible to serve at all. Both are gone: the payload is a
// registry QUERY on `SettingDescriptor.consumedBy`, and values are carried as
// `unknown`, validated against the DECLARED `dataType` and refused — never
// substituted — when they do not match.

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IProviderConnectionService } from '../ai-provider-connection/IProviderConnectionService';
import type { AiProviderConnectionResponse } from '../ai-provider-connection/dto';
import { AI_TASK_KEYS, type AiTaskKey } from '../ai-routing-policy/constants';
import { IAiRoutingPolicyService } from '../ai-routing-policy/IAiRoutingPolicyService';
import type { AiModelService } from '../ai-model/aiModel.service';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { MODEL_WEIGHT_SERVICES } from '../settings-registry/descriptors/service-runtime.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../settings-registry/registry';
import type { SettingDataType, SettingDescriptor } from '../settings-registry/registry.types';
import {
  EFFECTIVE_CONFIG_SERVICES,
  EffectiveConcurrency,
  EffectiveConfigResponse,
  EffectiveConfigServiceName,
  EffectiveConfigSource,
  EffectiveExternalGuardrail,
  EffectiveGeneration,
  EffectiveModelWeight,
  EffectiveRedaction,
  EffectiveRetention,
  EffectiveRuntimeProfile,
  EffectiveSetting,
  IEffectiveConfigService,
} from './IEffectiveConfigService';

/** These keys are platform-owned; the cascade context is always the SYSTEM tenant (D-1). */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Cascade tiers that are NOT a database answer, and therefore report as
 * `env-fallback` on the wire. Everything else means a stored row won.
 */
const NON_DB_SOURCE_SCOPES = new Set(['code-default', 'env-bootstrap']);

/**
 * The services served `runtimeProfiles`, and the `AiProviderConnection`
 * SERVICE whose SYSTEM rows supply them. TASK-862: a "runtime profile" on this
 * wire is now the platform's CONNECTION CEILINGS (`maxConcurrent` / `rpmLimit`
 * / `tpmLimit` / `timeoutS` on the SYSTEM `llm:<provider>` row), keyed
 * `modelSlug: ''` (provider-level) — the shape `apps/text`'s pool policy and
 * lane budgets already read. Hyper-parameters are ALWAYS null here: they moved
 * to the Agent (TASK-863). `nlp` is served an empty list (no connection plane).
 */
const RUNTIME_PROFILE_SERVICES: Partial<Record<EffectiveConfigServiceName, 'llm' | null>> = { text: 'llm', nlp: null };

/**
 * Task keys whose selected model a service materialises LOCALLY even though the
 * key lives under another service's prefix.
 *
 * One entry, and it is real: harness runs the MiniCheck entailer inside a
 * Temporal activity, but MiniCheck's selection lives under
 * `guardrail.groundedness` (harness has no task key of its own for it — see
 * `apps/harness/src/harness/models/source_resolver.py`). Without this the slug
 * harness looks up could never appear in its own `modelWeights` map.
 */
const CROSS_SERVICE_MODEL_WEIGHT_KEYS: Partial<Record<EffectiveConfigServiceName, readonly AiTaskKey[]>> = {
  harness: ['guardrail.groundedness'],
};

/**
 * One resolved registry key: its value plus which lane supplied it.
 *
 * `value: unknown` is the change that admits every data class. `null` means
 * UNRESOLVED (read failed, or the stored value did not match the declared
 * `dataType`) — the client keeps its bootstrap value. It is NEVER a stand-in
 * for the code default.
 */
interface ResolvedKey {
  value: unknown;
  source: EffectiveConfigSource;
}

function isKnownService(service: string): service is EffectiveConfigServiceName {
  return (EFFECTIVE_CONFIG_SERVICES as readonly string[]).includes(service);
}

/**
 * Does `value` match the type its descriptor DECLARES?
 *
 * The gate that replaced `typeof result.value === 'number' ? … : default`.
 * A mismatch is a control-plane defect (a hand-written row, a migration that
 * stored the wrong shape), and the safe response is to refuse the value so the
 * client keeps its own — never to quietly swap in a different one.
 */
export function matchesDataType(value: unknown, dataType: SettingDataType): boolean {
  switch (dataType satisfies SettingDataType) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      // `Number.isFinite` excludes NaN/Infinity, neither of which any consumer
      // can act on; `typeof` alone would let both through.
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'enum':
      return typeof value === 'string';
    case 'string[]':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
    case 'json':
      return typeof value === 'object' && value !== null;
    case 'secret':
      // Unreachable: secrets are filtered out before resolution. Kept so the
      // switch stays exhaustive, and answering `false` means that if the filter
      // ever regressed, the value would be refused rather than served.
      return false;
  }
}

/** A connection with no opinion on any ceiling leaves the service on its own env values. */
function hasOpinion(row: AiProviderConnectionResponse): boolean {
  return row.maxConcurrent !== null || row.tpmLimit !== null || row.rpmLimit !== null || row.timeoutS !== null;
}

@Injectable()
export class EffectiveConfigService implements IEffectiveConfigService {
  private readonly logger = new Logger(EffectiveConfigService.name);

  constructor(
    private readonly effectiveSettings: EffectiveSettingsService,
    // Optional so graphs that never serve text profiles (and unit tests) keep
    // working; an unwired service yields an empty profile list rather than a 500.
    @Optional() @Inject(IProviderConnectionService) private readonly connections?: IProviderConnectionService,
    // Optional for the same reason: an unwired pair yields NO `modelWeights`
    // block, which is exactly the state every consumer already handles (it is
    // what they saw before the block existed).
    @Optional() @Inject(IAiRoutingPolicyService) private readonly routingPolicies?: IAiRoutingPolicyService,
    @Optional() private readonly aiModels?: AiModelService,
  ) {}

  async resolveForService(service: string): Promise<EffectiveConfigResponse> {
    if (!isKnownService(service)) {
      throw new ArgumentInvalidException(`Unknown service '${service}'. Expected one of: ${EFFECTIVE_CONFIG_SERVICES.join(', ')}.`);
    }

    // ONE registry query, ONE resolution pass. Every group below is a VIEW over
    // this map — nothing resolves a key twice, and nothing is reachable that the
    // descriptors did not declare for this service.
    const resolved = await this.resolveDeclaredKeys(service);

    const profileSource = RUNTIME_PROFILE_SERVICES[service];
    const [runtimeProfiles, modelWeights] = await Promise.all([
      profileSource === undefined ? Promise.resolve(undefined) : this.listProfiles(profileSource),
      this.resolveModelWeights(service),
    ]);

    return {
      service,
      generatedAt: new Date().toISOString(),
      ...(runtimeProfiles ? { runtimeProfiles } : {}),
      ...this.retentionView(service, resolved),
      ...this.concurrencyView(resolved),
      ...this.redactionView(resolved),
      ...this.externalGuardrailView(resolved),
      ...this.generationView(resolved),
      ...(modelWeights ? { modelWeights } : {}),
      settings: toWire(resolved),
    };
  }

  /**
   * The registry query that replaced the `switch`: every non-secret descriptor
   * naming this service in `consumedBy`, resolved once.
   *
   * Secrets are filtered UNCONDITIONALLY, before resolution — a secret must not
   * traverse a config read surface even if a descriptor mistakenly declares
   * `consumedBy` (the settings facade refuses them too; this is the belt).
   */
  private async resolveDeclaredKeys(service: EffectiveConfigServiceName): Promise<Map<string, ResolvedKey>> {
    const descriptors = HOPE_SETTINGS_REGISTRY.list().filter((d) => d.sensitivity !== 'secret' && d.consumedBy?.includes(service));

    const entries = await Promise.all(descriptors.map(async (descriptor) => [descriptor.key, await this.resolveKey(descriptor)] as const));
    return new Map(entries);
  }

  /**
   * The platform's ENABLED `AiProviderConnection` rows for one service,
   * projected onto the runtime-profile wire shape (TASK-862). SYSTEM rows only:
   * this is a platform-level pull with no tenant in CLS (the controller pins
   * SYSTEM), and the ceilings on the platform account are what the shared
   * provider pool must respect. A tenant's own BYO ceilings ride the request
   * fold instead.
   */
  private async listProfiles(service: 'llm' | null): Promise<EffectiveRuntimeProfile[]> {
    if (service === null || !this.connections) {
      return [];
    }

    const rows = await this.connections.list(service, SYSTEM_TENANT_ID);
    return rows
      .filter((row) => row.enabled)
      .map((row) => ({
        provider: row.provider,
        modelSlug: '',
        temperature: null,
        topP: null,
        maxTokens: null,
        contextLength: null,
        maxConcurrent: row.maxConcurrent,
        tpmLimit: row.tpmLimit,
        rpmLimit: row.rpmLimit,
        timeoutS: row.timeoutS,
        keepAliveSeconds: null,
        extraJson: null,
        source: hasOpinion(row) ? 'db' : 'env-fallback',
      }));
  }

  /**
   * The frozen `retention` view over the already-resolved map.
   *
   * `text` gets ttlSeconds ONLY: it owns no cache, so `maxModels`/`maxMemoryMb`
   * are meaningless there and stay null rather than being invented.
   * `maxMemoryMb` remains stt-only (its historical MB budget).
   *
   * A service with no `modelCache.ttlSeconds` descriptor gets NO `retention`
   * group at all, which every client reads as "leave your own values alone".
   * Since TASK-872 that is guardrail's case: its three cache keys were removed
   * for having no reader, so the group is simply absent for it.
   */
  private retentionView(service: EffectiveConfigServiceName, resolved: Map<string, ResolvedKey>): { retention?: EffectiveRetention } {
    const ttl = resolved.get(`${service}.modelCache.ttlSeconds`);
    if (!ttl) return {};

    if (service === 'text') {
      return { retention: { ttlSeconds: numberOrNull(ttl), maxModels: null, maxMemoryMb: null, source: ttl.source } };
    }

    const maxModels = resolved.get(`${service}.modelCache.maxModels`);
    const maxMemoryMb = resolved.get(`${service}.modelCache.maxMemoryMb`);

    return {
      retention: {
        ttlSeconds: numberOrNull(ttl),
        maxModels: numberOrNull(maxModels),
        maxMemoryMb: numberOrNull(maxMemoryMb),
        source: groupSource([ttl, maxModels, maxMemoryMb]),
      },
    };
  }

  /**
   * The frozen `concurrency` view. Each field names the ONE key that feeds it;
   * a service whose descriptors declare none of them gets no group at all,
   * which is what a client reads as "leave my own values alone".
   */
  private concurrencyView(resolved: Map<string, ResolvedKey>): { concurrency?: EffectiveConcurrency } {
    const maxConcurrent = resolved.get('nlp.inference.maxConcurrent');
    const workerConcurrency = resolved.get('stt.workers.concurrency');
    const streamingMaxConcurrent = resolved.get('stt.streaming.maxConcurrent');
    const peerCallMaxConcurrent = resolved.get('nlp.peerCall.maxConcurrent');

    const present = [maxConcurrent, workerConcurrency, streamingMaxConcurrent, peerCallMaxConcurrent].filter(isPresent);
    if (present.length === 0) return {};

    return {
      concurrency: {
        maxConcurrent: numberOrNull(maxConcurrent),
        workerConcurrency: numberOrNull(workerConcurrency),
        streamingMaxConcurrent: numberOrNull(streamingMaxConcurrent),
        peerCallMaxConcurrent: numberOrNull(peerCallMaxConcurrent),
        source: groupSource(present),
      },
    };
  }

  /**
   * guardrail's PHI-redaction view. Same degradation contract as retention: an
   * unresolved value yields null and guardrail keeps its own built-in chunk
   * bound, which is a real bound — never "unbounded".
   */
  private redactionView(resolved: Map<string, ResolvedKey>): { redaction?: EffectiveRedaction } {
    const chunkChars = resolved.get('guardrail.redact.chunkChars');
    if (!chunkChars) return {};
    return { redaction: { chunkChars: numberOrNull(chunkChars), source: chunkChars.source } };
  }

  /**
   * TEXT's `externalGuardrail` view — the PLATFORM half of the input-moderation
   * posture.
   *
   * Hand-shaped, like every group above it, and for the same reason: the field
   * names on the wire are `enabled` / `timeoutS` / … while the registry keys are
   * `text.externalGuardrail.enabled` / `.timeoutS` / …, and `apps/text` reads
   * the FORMER (`core/effective_config.py::external_guardrail`). A generic
   * dotted-key fold would serve `{"text.externalGuardrail.enabled": …}`, which
   * that consumer does not read — the generic `settings` map already carries
   * exactly that, and carrying it is what proved insufficient.
   *
   * Presence is keyed on the switch: a service whose descriptors declare none
   * of these keys gets NO group, which every client reads as "leave my own
   * values alone".
   */
  private externalGuardrailView(resolved: Map<string, ResolvedKey>): { externalGuardrail?: EffectiveExternalGuardrail } {
    const enabled = resolved.get('text.externalGuardrail.enabled');
    if (!enabled) return {};

    const timeoutS = resolved.get('text.externalGuardrail.timeoutS');
    const maxRetries = resolved.get('text.externalGuardrail.maxRetries');
    const retryBackoffMs = resolved.get('text.externalGuardrail.retryBackoffMs');
    const requireMedical = resolved.get('text.externalGuardrail.requireMedical');
    const includeReasoning = resolved.get('text.externalGuardrail.includeReasoning');

    return {
      externalGuardrail: {
        enabled: booleanOrNull(enabled),
        timeoutS: numberOrNull(timeoutS),
        maxRetries: numberOrNull(maxRetries),
        retryBackoffMs: numberOrNull(retryBackoffMs),
        requireMedical: booleanOrNull(requireMedical),
        includeReasoning: booleanOrNull(includeReasoning),
        source: groupSource([enabled, timeoutS, maxRetries, retryBackoffMs, requireMedical, includeReasoning]),
      },
    };
  }

  /**
   * TEXT's `generation` view — the platform hyperparameter profile.
   *
   * Same shape contract as above: `apps/text` reads `temperature` / `topP` /
   * `maxTokens` off `raw["generation"]`, and treats an omitted key as "keep the
   * in-code floor" rather than as a zero.
   */
  private generationView(resolved: Map<string, ResolvedKey>): { generation?: EffectiveGeneration } {
    const temperature = resolved.get('text.generation.temperature');
    const topP = resolved.get('text.generation.topP');
    const maxTokens = resolved.get('text.generation.maxTokens');

    const present = [temperature, topP, maxTokens].filter(isPresent);
    if (present.length === 0) return {};

    return {
      generation: {
        temperature: numberOrNull(temperature),
        topP: numberOrNull(topP),
        maxTokens: numberOrNull(maxTokens),
        source: groupSource(present),
      },
    };
  }

  /**
   * `modelWeights`: slug → where the weights come from, for the models this
   * service's SYSTEM routing elections select.
   *
   * Served only to services that hold weights in their OWN process
   * (`MODEL_WEIGHT_SERVICES`) — `text` is excluded because it holds none, its
   * models being served by remote engines. Resolution is SYSTEM-tenant, like
   * everything else on this route (D-1): these are the platform's selections.
   *
   * That list is deliberately NOT `MODEL_CACHE_SERVICES` (TASK-872): guardrail
   * declares no cache-retention knobs any more and still needs to be told where
   * its weights live.
   *
   * Fail-SAFE throughout. A task with no selection, a slug with no registry row,
   * or a resolver that throws each contributes nothing rather than failing the
   * pull — every consumer already treats an absent entry as "use my bootstrap
   * path", so a degraded control plane leaves them exactly where they are.
   */
  private async resolveModelWeights(service: EffectiveConfigServiceName): Promise<Record<string, EffectiveModelWeight> | undefined> {
    if (!this.routingPolicies || !this.aiModels) return undefined;
    if (!(MODEL_WEIGHT_SERVICES as readonly string[]).includes(service)) return undefined;

    const taskKeys = [...AI_TASK_KEYS.filter((key) => key.startsWith(`${service}.`)), ...(CROSS_SERVICE_MODEL_WEIGHT_KEYS[service] ?? [])];
    if (taskKeys.length === 0) return undefined;

    const weights: Record<string, EffectiveModelWeight> = {};

    await Promise.all(
      taskKeys.map(async (taskKey) => {
        try {
          const resolved = await this.routingPolicies!.resolveDefault(SYSTEM_TENANT_ID, taskKey, { systemOnly: true });
          const slug = resolved.model?.slug ?? null;
          if (!slug || weights[slug]) return;

          const model = await this.aiModels!.getBySlug(slug);
          if (!model) return;

          weights[slug] = {
            sourceUri: model.sourceUri,
            localPath: model.localPath ?? null,
            checksum: model.checksum ?? null,
          };
        } catch (error) {
          this.logger.warn({
            message: 'Model-weight resolution failed — the key is omitted and the client keeps its bootstrap path',
            service,
            taskKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    return Object.keys(weights).length > 0 ? weights : undefined;
  }

  /**
   * Resolve ONE descriptor, typed.
   *
   * A control-plane read failure is NOT an endpoint failure: it degrades to
   * `env-fallback` with a null value, so the client keeps its bootstrap value
   * and the service behaves exactly as it does today (deterministic
   * degradation). Logged once per read so the condition stays visible.
   *
   * A TYPE mismatch degrades the same way, and for the same reason — but note
   * what it explicitly does NOT do: substitute `descriptor.default`. That
   * substitution is what made this path numeric-only, and it hid the defect
   * from operators by serving a plausible value.
   */
  private async resolveKey(descriptor: SettingDescriptor): Promise<ResolvedKey> {
    const { key, dataType } = descriptor;
    try {
      const result = await this.effectiveSettings.resolveEffective(key, {
        tenantId: SYSTEM_TENANT_ID,
        departmentId: null,
        doctorId: null,
      });

      if (!matchesDataType(result.value, dataType)) {
        this.logger.warn({
          message: 'Effective-config value does not match its declared dataType — refusing it (no default is substituted)',
          key,
          dataType,
          received: typeof result.value,
        });
        return { value: null, source: 'env-fallback' };
      }

      // The facade reports the winning cascade tier. Two of them mean "nothing
      // in the DATABASE answered": `code-default` (the descriptor default) and
      // `env-bootstrap` (the pre-SYSTEM-row `MINIO_*` fallback the storage
      // cascade ends in). Both are `env-fallback` on the wire — labelling a
      // bootstrap value `db` would tell an operator the platform row is
      // configured when it is not.
      return { value: result.value, source: NON_DB_SOURCE_SCOPES.has(result.sourceScope) ? 'env-fallback' : 'db' };
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

/** The resolved map as it goes on the wire, carrying each key's declared type. */
function toWire(resolved: Map<string, ResolvedKey>): Record<string, EffectiveSetting> {
  const out: Record<string, EffectiveSetting> = {};
  for (const [key, entry] of resolved) {
    out[key] = {
      value: entry.value,
      dataType: HOPE_SETTINGS_REGISTRY.getOrThrow(key).dataType,
      source: entry.source,
    };
  }
  return out;
}

function isPresent(entry: ResolvedKey | undefined): entry is ResolvedKey {
  return entry !== undefined;
}

/**
 * Narrow a resolved value for one of the FROZEN numeric group fields.
 *
 * Every key feeding those fields declares `dataType: 'number'`, so this only
 * ever fires on an unresolved (null) value. It is not the old blanket
 * coercion — that applied to EVERY key regardless of declared type, which is
 * precisely what kept non-numeric values off this route.
 */
function numberOrNull(entry: ResolvedKey | undefined): number | null {
  return typeof entry?.value === 'number' ? entry.value : null;
}

/**
 * The boolean counterpart of `numberOrNull`, for the frozen boolean group
 * fields. Same contract: only ever fires on an unresolved (null) value, because
 * every key feeding those fields declares `dataType: 'boolean'` — and a
 * type-mismatched value was already refused upstream in `resolveKey`.
 *
 * `null`, not `false`. A control plane with no answer must never be read as an
 * answer of "off": `apps/text` keeps its own floor on null, and `false` would
 * override a floor of `true` (`requireMedical`) with an opinion nobody stated.
 */
function booleanOrNull(entry: ResolvedKey | undefined): boolean | null {
  return typeof entry?.value === 'boolean' ? entry.value : null;
}

/** A group reads as `db` only if at least one of its keys was overridden. */
function groupSource(keys: (ResolvedKey | undefined)[]): EffectiveConfigSource {
  return keys.some((k) => k?.source === 'db') ? 'db' : 'env-fallback';
}
