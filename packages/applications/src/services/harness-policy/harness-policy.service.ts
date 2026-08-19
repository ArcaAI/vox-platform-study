import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { assertExpectedVersion } from '../../common/assertExpectedVersion';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationRepository,
  CoreDatabaseService,
  DepartmentAgentRepository,
  HARNESS_POLICY_DEFAULTS,
  HarnessPolicyChangeFactory,
  HarnessPolicyChangeRepository,
  HarnessPolicyEntity,
  HarnessPolicyFactory,
  HarnessPolicyRepository,
  JsonValue,
  McpServerRepository,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import { IActiveUserContext } from '../../interfaces';
import { TENANT_TIER_HARNESS_OVERRIDE_KEYS } from '../departmentAgent/constants';
import { IAiTaskDefaultService } from '../ai-task-default/IAiTaskDefaultService';
import { SecretsService } from '../baseServices/_meta/secrets';
import { McpServerDtoMapper } from '../mcp-server/mcp-server.dto.mapper';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { AGENTIC_CONTEXT_KEY_PREFIX } from '../settings-registry/descriptors/agentic-context.descriptors';
import type { McpServerResponse } from '../mcp-server/dto';
import { HarnessOverridesSource, HarnessPolicyResponse, HarnessPolicySource, UpdateHarnessPolicyRequest } from './dto';

/**
 * the SMR routing tasks the loop discriminates on:
 *  - `live`     → the live-documentation delta summariser (`text.live`).
 *  - `finalize` → the final/comprehensive summary generator (`text.finalize`).
 *  - `test`     → the tenant-admin prompt-template test bench (`text.test`,
 * — falls back to `finalize` at the CALLER when unresolved.
 * `resolveTextSelection` consults the matching `AiTaskDefault` key FIRST, then
 * falls back to the legacy `HarnessPolicy.textProvider/textModel` cascade.
 */
export type TextRoutingTask = 'live' | 'finalize' | 'test';

const TEXT_TASK_KEY: Record<TextRoutingTask, string> = {
  live: 'text.live',
  finalize: 'text.finalize',
  test: 'text.test',
};

/**
 * The tasks that HAVE a fallback tier. `test` deliberately does not: the
 * prompt-template test bench is authoring, not clinical documentation, so a
 * failed test surfaces rather than silently re-running on another model.
 */
type TextFallbackTask = Exclude<TextRoutingTask, 'test'>;

/**
 * The per-tenant, opt-in text fallback selection keys. Tenant-admin
 * configurable (the `text.` prefix is NOT in `SUPER_ADMIN_ONLY_TASK_PREFIXES`);
 * `resolveTextFallbackSelection` reads these fail-OPEN (no row ⇒ null ⇒ no
 * fallback runs — the same effect as the removed `TEXT_FALLBACK_*` env being
 * unset). No SYSTEM default is seeded.
 *
 * TASK-740 D-4: this map used to carry a third entry, `text.test.fallback`,
 * purely to satisfy a `Record<TextRoutingTask, string>` exhaustiveness check —
 * an unregistered, unseeded literal that was not in `AI_TASK_KEYS` and that no
 * caller could reach. Narrowing the key type to {@link TextFallbackTask} deletes
 * the literal instead of documenting it, so the map cannot name an unregistered
 * key again.
 */
const TEXT_FALLBACK_TASK_KEY: Record<TextFallbackTask, string> = {
  live: 'text.live.fallback',
  finalize: 'text.finalize.fallback',
};

/**
 * the SYSTEM-only AiTaskDefault key that selects the harness
 * LLM-as-judge. SUPER_ADMIN-managed (the `harness.` prefix is super-admin-only
 * in {@link SUPER_ADMIN_ONLY_TASK_PREFIXES}); tenants can only USE the platform
 * default, so `getEffective` resolves the SYSTEM row regardless of tenant.
 */
const JUDGE_TASK_KEY = 'harness.judge';

/**
 * map an `AiModel.provider` to a harness `JudgeProvider` value.
 * LM Studio is served over the OpenAI-compatible wire, so it maps to
 * `openai_compat` (the harness JudgeProvider enum has no `lm-studio` member).
 * Every other provider the judge supports already matches its enum value
 * (`ollama` / `vllm` / `llama-cpp` / `azure` / `bedrock`), so it passes through.
 * Mirrors the `azure → azure-openai` alias `resolveTextSelection` applies.
 */
function toJudgeProvider(provider: string): string {
  return provider === 'lm-studio' ? 'openai_compat' : provider;
}

/** Ciphertext payloads threaded into the change factory. */
interface EncryptedChangePayloads {
  encryptedBeforeJson: Buffer | null;
  encryptedAfterJson: Buffer | null;
  keyVersion: number | null;
}

/**
 * The runtime knobs the clinical loop reads. Decoupled from the entity (whose
 * getters are non-enumerable) and from the DTO (sparse) so merge / snapshot /
 * apply operate on a single, fully-populated value shape.
 *
 * Includes the seven agentic loop knobs. They are NULLABLE
 * overrides: null ⇒ the harness env/code default applies (per-field
 * fallthrough), so the harness only overrides a runtime default when the policy
 * carries an explicit non-null value.
 */
export interface HarnessPolicyKnobs {
  entityFaithfulnessThreshold: number;
  coverageThreshold: number;
  citationPresenceThreshold: number;
  numericDoseThreshold: number;
  groundednessThreshold: number;
  safetyEnabled: boolean;
  phiEnabled: boolean;
  phiFailClosed: boolean;
  safetyProvider: string;
  safetyModel: string;
  textProvider: string | null;
  textModel: string | null;
  maxRegen: number;
  gateSlaSeconds: number;
  gateEscalationSeconds: number;
  toolAllowlist: string[] | null;
  // agentic loop knobs (null ⇒ harness env/code default).
  optimisticDeliveryEnabled: boolean | null;
  atomicFactEnabled: boolean | null;
  retrievalEnabled: boolean | null;
  warmStartEnabled: boolean | null;
  nerPriorsEnabled: boolean | null;
  maxEditReruns: number | null;
  regenFeedbackEnabled: boolean | null;
  /**
   * Master gate for the MCP external-tools path. `null ⇒ OFF`, so
   * the feature stays dormant until a super admin explicitly flips it AND the
   * referenced `McpServer.enabled` is true.
   *
   * This existed on the entity (and therefore in `KNOB_KEYS`, which derives from
   * `HARNESS_POLICY_DEFAULTS`) but was missing from this interface, from
   * `entityToKnobs`, and from the DTOs — so it could never be patched or read,
   * and the harness's `mcp_tools_enabled` was permanently None.
   */
  mcpToolsEnabled: boolean | null;
}

/**
 * Selection + agentic knobs AND the guardrail/PHI on-off switches are
 * SUPER_ADMIN / SYSTEM-only. Tenant admins may patch clinical THRESHOLDS
 * (faithfulness, coverage, numeric-dose, …) ONLY — they must not set
 * model/provider routing, agentic loop knobs, or turn the safety and PHI gates
 * off for their tenant.
 *
 * Includes `safetyEnabled`/`phiEnabled`/`phiFailClosed`:
 * guardrail and NLP are controlled by super admins only. Because this list
 * also drives the SYSTEM overlay in `getEffectivePolicy`, pre-existing tenant
 * rows carrying those three are neutralised at READ time (values are ignored,
 * not deleted — removing a key here restores the tenant row's effect).
 */
const SUPER_ADMIN_ONLY_POLICY_KEYS = [
  'safetyProvider',
  'safetyModel',
  'textProvider',
  'textModel',
  'optimisticDeliveryEnabled',
  'atomicFactEnabled',
  'retrievalEnabled',
  'warmStartEnabled',
  'nerPriorsEnabled',
  'maxEditReruns',
  'regenFeedbackEnabled',
  'safetyEnabled',
  'phiEnabled',
  'phiFailClosed',
  // MCP calls OUT of the platform boundary, so arming it is
  // super-admin governance, never a tenant-level switch.
  'mcpToolsEnabled',
] as const satisfies readonly (keyof HarnessPolicyKnobs)[];

const KNOB_KEYS = Object.keys(HARNESS_POLICY_DEFAULTS) as (keyof HarnessPolicyKnobs)[];

/**
 * Read-time allow-list for per-agent `harnessOverrides`. Reuses the
 * EXACT set validates on write (`TENANT_TIER_HARNESS_OVERRIDE_KEYS`) so
 * the read and write sides can never diverge. Any override key NOT in here is a
 * super-admin-only knob (OD-2) and is dropped defense-in-depth before it can
 * reach the harness — mirroring the SYSTEM overlay of `SUPER_ADMIN_ONLY_POLICY_KEYS`.
 */
const TENANT_TIER_OVERRIDE_KEY_SET: ReadonlySet<string> = new Set(TENANT_TIER_HARNESS_OVERRIDE_KEYS);

/** Read the knob values off a hydrated entity (getters are not enumerable). */
function entityToKnobs(e: HarnessPolicyEntity): HarnessPolicyKnobs {
  return {
    entityFaithfulnessThreshold: e.entityFaithfulnessThreshold,
    coverageThreshold: e.coverageThreshold,
    citationPresenceThreshold: e.citationPresenceThreshold,
    numericDoseThreshold: e.numericDoseThreshold,
    groundednessThreshold: e.groundednessThreshold,
    safetyEnabled: e.safetyEnabled,
    phiEnabled: e.phiEnabled,
    phiFailClosed: e.phiFailClosed,
    safetyProvider: e.safetyProvider,
    safetyModel: e.safetyModel,
    textProvider: e.textProvider ?? null,
    textModel: e.textModel ?? null,
    maxRegen: e.maxRegen,
    gateSlaSeconds: e.gateSlaSeconds,
    gateEscalationSeconds: e.gateEscalationSeconds,
    toolAllowlist: (e.toolAllowlist as string[] | null) ?? null,
    optimisticDeliveryEnabled: e.optimisticDeliveryEnabled ?? null,
    atomicFactEnabled: e.atomicFactEnabled ?? null,
    retrievalEnabled: e.retrievalEnabled ?? null,
    warmStartEnabled: e.warmStartEnabled ?? null,
    nerPriorsEnabled: e.nerPriorsEnabled ?? null,
    maxEditReruns: e.maxEditReruns ?? null,
    regenFeedbackEnabled: e.regenFeedbackEnabled ?? null,
    // The line whose absence silently dropped the MCP gate from
    // every response built off a policy row.
    mcpToolsEnabled: e.mcpToolsEnabled ?? null,
  };
}

/** Sparse-patch merge: take the DTO value when present, else the base value. */
function mergeKnobs(base: HarnessPolicyKnobs, dto: UpdateHarnessPolicyRequest): HarnessPolicyKnobs {
  const out = { ...base };
  for (const key of KNOB_KEYS) {
    const patched = (dto as Record<string, unknown>)[key];
    if (patched !== undefined) {
      (out as Record<string, unknown>)[key] = patched;
    }
  }
  return out;
}

/** Apply only the DTO's supplied knobs onto an entity (drives change tracking). */
function applyKnobsToEntity(entity: HarnessPolicyEntity, dto: UpdateHarnessPolicyRequest): void {
  for (const key of KNOB_KEYS) {
    const patched = (dto as Record<string, unknown>)[key];
    if (patched !== undefined) {
      // Bracket assignment invokes the entity's prototype setter, so each write
      // is recorded via `setProperty` (only real value changes mark the row dirty).
      (entity as unknown as Record<string, unknown>)[key] = patched;
    }
  }
}

/**
 * HarnessPolicyService — DB-backed, editable runtime policy
 * that drives the clinical documentation loop.
 *
 *  - `getEffectivePolicy` resolves the tenant's own row, else the SYSTEM-tenant
 *    GLOBAL-DEFAULT, else the harness code defaults ("tenant OVERRIDES global").
 *  - `updatePolicy` edits the calling tenant's row (creating it on first edit
 *    from the inherited default), under optimistic-concurrency CAS, and appends
 *    a before/after `HarnessPolicyChange` WORM record in the SAME transaction.
 *  - `updateGlobalDefault` does the same against the SYSTEM-tenant row
 *    (platform-only; the controller gates it with a GLOBAL `manage` ability).
 *
 * The policy write + the WORM change-append are wrapped in a single interactive
 * transaction (mirrors `PromptManagementService`) so an edit is never recorded
 * without its audit row and vice versa.
 */
@Injectable()
export class HarnessPolicyService {
  private readonly logger = new Logger(HarnessPolicyService.name);

  constructor(
    private readonly policyRepository: HarnessPolicyRepository,
    private readonly policyChangeRepository: HarnessPolicyChangeRepository,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    private readonly clsService: ClsService<IActiveUserContext>,
    // Optional so fixtures keep their 4-arg construction and
    // non-Vault deployments degrade to plaintext WORM change rows.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // optional so existing fixtures keep their 4/5-arg
    // construction; when absent, `resolveTextSelection` uses only the legacy
    // HarnessPolicy cascade (the AiTaskDefault-first path is a no-op).
    @Optional() @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService?: IAiTaskDefaultService,
    // The SYSTEM-shared MCP registry the worker resolves tool
    // calls against. Optional + trailing so existing fixtures keep their arity;
    // absent ⇒ `mcpServers: []`, i.e. nothing callable (the safe default).
    @Optional() @Inject(McpServerRepository) private readonly mcpServerRepository?: McpServerRepository,
    // Settings-registry read facade for the per-run token budget.
    // Optional + trailing; absent ⇒ null budget ⇒ the harness stays unbounded.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // Per-department-agent harness overrides. Both optional + trailing
    // so existing fixtures keep their construction arity; absent ⇒ the overlay is
    // a no-op (the effective policy resolves exactly as before). Consultation →
    // departmentId → department default DepartmentAgent → tenant-tier overrides.
    @Optional() @Inject(ConsultationRepository) private readonly consultationRepository?: ConsultationRepository,
    @Optional() @Inject(DepartmentAgentRepository) private readonly departmentAgentRepository?: DepartmentAgentRepository,
  ) {}

  /**
   * Per-run token budget from `agentic.context.tokenBudget.perRun`.
   *
   * The budget lives in the settings registry (the control plane a super admin
   * edits), not on `HarnessPolicy` — but the harness only fetches ONE document at
   * workflow start, so it is served here rather than adding a second round trip
   * from the worker. Null when unresolvable ⇒ the workflow keeps its snapshotted
   * default of 0 (unbounded), i.e. pre-B4 behaviour.
   */
  private async resolveTokenBudgetPerRun(tenantId: string): Promise<number | null> {
    if (!this.effectiveSettings) return null;
    try {
      const result = await this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}tokenBudget.perRun`, { tenantId });
      const parsed = Number(result.value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    } catch (error) {
      this.logger.warn({
        message: 'agentic.context.tokenBudget.perRun lookup failed — the harness will use its unbounded default',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Enabled SYSTEM-shared MCP servers, in the shape `McpServerConfig.from_api`
   * parses.
   *
   * `fetch_policy` on the harness side reads `mcpServers` straight off this
   * response — its `models.py` parser was written for exactly this payload and
   * had been receiving `[]` forever because nothing ever populated it.
   *
   * Best-effort by design: a registry read failure yields an empty list rather
   * than sinking the whole effective-policy read (mirrors `resolveTextSelection`
   * and `resolveJudgeSelection`). An empty list simply means nothing is callable.
   */
  private async resolveMcpServers(): Promise<McpServerResponse[]> {
    if (!this.mcpServerRepository) return [];
    try {
      const rows = await this.mcpServerRepository.findAll({ where: { tenantId: SYSTEM_TENANT_ID } } as never);
      return (rows ?? []).filter((entity) => entity.enabled).map((entity) => McpServerDtoMapper.toResponse(entity));
    } catch (error) {
      this.logger.warn({
        message: 'MCP server registry lookup failed — effective policy will carry no callable servers',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Best-effort encrypt the before/after policy snapshots so
   * the WORM `HarnessPolicyChange` row stores ciphertext (+ a redaction sentinel
   * in the plaintext JSONB). Done OUTSIDE the change transaction (the Vault
   * round-trip must not hold a DB connection open). Returns null when there is no
   * SecretsService or Vault errors — the change is then written in plaintext.
   */
  private async encryptChangePayloads(before: JsonValue | null, after: JsonValue): Promise<EncryptedChangePayloads | null> {
    if (!this.secretsService) return null;
    try {
      return await this.policyChangeRepository.encryptPayloads(this.secretsService, before, after);
    } catch (error) {
      this.logger.warn({
        message: 'HarnessPolicyChange payload encryption failed — writing plaintext change row',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private get callerTenantId(): string | null {
    return this.clsService.get('tenantId') || null;
  }

  private get callerUserId(): string | null {
    return this.clsService.get('user')?.id ?? null;
  }

  /**
   * The effective policy for a tenant (own row → system default → code default).
   * `tenantId` defaults to the CLS tenant; the worker-facing internal endpoint
   * passes it explicitly.
   *
   * When `opts.consultationId` is supplied, the consultation's
   * department default `DepartmentAgent.harnessOverrides` is layered on top of
   * the resolved policy (tenant-tier keys ONLY; global-only keys dropped +
   * warned defense-in-depth). Resolution order becomes: code default → SYSTEM →
   * tenant → department-agent overrides (most specific wins). The overlay is
   * best-effort and never sinks the policy read; with no consultationId the
   * result is byte-identical to the prior behaviour.
   *
   * When `opts.taskKey` is supplied (TASK-740 D-1) the `AiTaskDefault` row for
   * that key — resolved tenant → SYSTEM by `AiTaskDefaultService.getEffective` —
   * overlays `textProvider`/`textModel` on whichever policy row wins. Same
   * best-effort contract as the judge overlay: an unresolved key leaves the
   * policy columns in place. Without a taskKey the result is byte-identical to
   * the prior behaviour.
   */
  async getEffectivePolicy(tenantId?: string, opts?: { consultationId?: string; taskKey?: string }): Promise<HarnessPolicyResponse> {
    const tid = tenantId ?? this.callerTenantId;
    if (!tid) throw new BadRequestException('Tenant ID is required');
    const consultationId = opts?.consultationId;
    // D-1: the task key SELECTS the model. Resolved once and overlaid on every
    // return path below, exactly like `judge` — null ⇒ keep the policy columns.
    const taskSelection = opts?.taskKey ? await this.resolveTextSelectionForKey(opts.taskKey, tid) : null;
    const applyTaskSelection = (resp: HarnessPolicyResponse): HarnessPolicyResponse => {
      if (taskSelection) {
        resp.textProvider = taskSelection.provider;
        resp.textModel = taskSelection.model;
      }
      return resp;
    };

    // the judge provider/model come from the SYSTEM-only
    // `harness.judge` AiTaskDefault, independent of which policy row wins. Resolve
    // once and overlay onto whichever response we return (mirrors the SYSTEM
    // selection-knob overlay below). Null when unconfigured ⇒ the harness falls
    // back to its env/code judge default.
    const judge = await this.resolveJudgeSelection(tid);
    // The MCP registry is SYSTEM-shared and independent of which
    // policy row wins, so resolve it once and overlay onto every return path
    // below (same pattern as the judge selection above).
    const [mcpServers, tokenBudgetPerRun] = await Promise.all([this.resolveMcpServers(), this.resolveTokenBudgetPerRun(tid)]);

    const own = await this.policyRepository.findForExactTenant(tid);
    if (own) {
      const resp = toResponse(own, 'tenant');
      // Selection + agentic knobs always come from SYSTEM (tenant
      // override rows for those fields are ignored at runtime). Clinical
      // thresholds remain tenant-overridable on the own row.
      const sys = await this.policyRepository.findSystemDefault();
      if (sys) {
        const sysKnobs = entityToKnobs(sys);
        for (const key of SUPER_ADMIN_ONLY_POLICY_KEYS) {
          (resp as unknown as Record<string, unknown>)[key] = sysKnobs[key];
        }
      }
      resp.judgeProvider = judge.judgeProvider;
      resp.judgeModel = judge.judgeModel;
      resp.mcpServers = mcpServers;
      resp.tokenBudgetPerRun = tokenBudgetPerRun;
      return this.applyAgentOverrides(applyTaskSelection(resp), tid, consultationId);
    }

    const sys = await this.policyRepository.findSystemDefault();
    if (sys) {
      const resp = toResponse(sys, 'system-default');
      resp.judgeProvider = judge.judgeProvider;
      resp.judgeModel = judge.judgeModel;
      resp.mcpServers = mcpServers;
      resp.tokenBudgetPerRun = tokenBudgetPerRun;
      return this.applyAgentOverrides(applyTaskSelection(resp), tid, consultationId);
    }

    const resp = codeDefaultResponse(tid);
    resp.judgeProvider = judge.judgeProvider;
    resp.judgeModel = judge.judgeModel;
    resp.mcpServers = mcpServers;
    resp.tokenBudgetPerRun = tokenBudgetPerRun;
    return this.applyAgentOverrides(applyTaskSelection(resp), tid, consultationId);
  }

  /**
   * Layer the consultation's department default `DepartmentAgent`
   * tenant-tier overrides on top of the resolved policy. Called on EVERY
   * `getEffectivePolicy` return path (most specific wins); a no-op when there is
   * no consultationId, no wired repositories, no consultation/department/default
   * agent, or the agent carries no overrides.
   *
   * Read-time defense-in-depth (OD-2): only keys in the tenant-tier allow-list
   * flow; any super-admin-only key that somehow got stored in the JSONB is
   * DROPPED + warned, never served — matching the SYSTEM overlay that neutralises
   * `SUPER_ADMIN_ONLY_POLICY_KEYS`.
   *
   * Cross-tenant safety: the consultation read is tenant-scoped, and an explicit
   * `tenantId` guard refuses any consultation the caller does not own (no leak),
   * so a foreign consultationId yields the base policy unchanged.
   *
   * Best-effort by contract: any error degrades to the base policy (never sinks
   * the read that the worker's `fetch_policy` depends on) — mirrors
   * `resolveMcpServers`/`resolveJudgeSelection`.
   */
  private async applyAgentOverrides(resp: HarnessPolicyResponse, tenantId: string, consultationId?: string): Promise<HarnessPolicyResponse> {
    if (!consultationId || !this.consultationRepository || !this.departmentAgentRepository) return resp;
    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      // A missing or foreign consultation ⇒ no overlay (404-over-403 posture: the
      // tenant-scoped read already hides foreign rows; the explicit check is D-i-D).
      if (!consultation || consultation.tenantId !== tenantId) return resp;
      const departmentId = consultation.departmentId;
      if (!departmentId) return resp;

      const agent = await this.departmentAgentRepository.findDefaultForDepartment(tenantId, departmentId);
      const overrides = agent?.harnessOverrides as Record<string, unknown> | null | undefined;
      if (!agent || !overrides) return resp;

      const appliedKeys: string[] = [];
      const dropped: string[] = [];
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) continue;
        if (!TENANT_TIER_OVERRIDE_KEY_SET.has(key)) {
          dropped.push(key);
          continue;
        }
        (resp as unknown as Record<string, unknown>)[key] = value;
        appliedKeys.push(key);
      }

      if (dropped.length > 0) {
        this.logger.warn({
          message: `DepartmentAgent ${agent.id} harnessOverrides carried super-admin-only key(s) [${dropped.join(', ')}] — dropped at read time (OD-2)`,
          agentId: agent.id,
        });
      }
      if (appliedKeys.length > 0) {
        const provenance: HarnessOverridesSource = { agentId: agent.id, agentSlug: agent.slug, keys: appliedKeys };
        resp.overridesSource = provenance;
      }
      return resp;
    } catch (error) {
      this.logger.warn({
        message: `per-agent harnessOverrides overlay failed for consultation ${consultationId} — serving the base effective policy`,
        error: error instanceof Error ? error.message : String(error),
      });
      return resp;
    }
  }

  /**
   * resolve the SYSTEM-only `harness.judge` AiTaskDefault into a
   * harness-consumable `{ judgeProvider, judgeModel }`. `judgeModel` is the
   * model's `sourceUri` (the id the judge client sends); `judgeProvider` is the
   * model's provider normalised to a `JudgeProvider` value. Best-effort: a
   * missing/misconfigured key (or an un-wired AiTaskDefault service in fixtures)
   * yields `{ null, null }` so the harness falls back to its env/code default —
   * never sinks the effective-policy read (mirrors `resolveTextSelection`).
   */
  private async resolveJudgeSelection(tenantId?: string): Promise<{ judgeProvider: string | null; judgeModel: string | null }> {
    if (!this.aiTaskDefaultService) return { judgeProvider: null, judgeModel: null };
    try {
      const eff = await this.aiTaskDefaultService.getEffective(JUDGE_TASK_KEY, tenantId);
      const model = eff.model;
      if (model?.provider && model.sourceUri) {
        return { judgeProvider: toJudgeProvider(model.provider), judgeModel: model.sourceUri };
      }
    } catch (error) {
      this.logger.warn({
        message: `AiTaskDefault judge lookup failed for '${JUDGE_TASK_KEY}' — harness will use its env/code judge default`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { judgeProvider: null, judgeModel: null };
  }

  /**
   * Resolve ONE `AiTaskDefault` task key into a `{ provider, model }` pair,
   * tenant → SYSTEM (the cascade `AiTaskDefaultService.getEffective` owns).
   *
   * The single place the task key is turned into a model. Both the fail-closed
   * seam (`resolveTextSelection`), the fail-open fallback seam
   * (`resolveTextFallbackSelection`) and the D-1 `getEffectivePolicy` overlay
   * funnel through it, so the `azure → azure-openai` runtime alias and the
   * "an enabled model needs BOTH provider and sourceUri" rule cannot drift
   * between them.
   *
   * Best-effort by contract: returns `null` when the AiTaskDefault service is
   * un-wired, the key resolves to no enabled model, or the lookup throws. Each
   * caller decides what `null` means (throw / no fallback / keep the policy
   * columns) — this method never decides for them.
   */
  private async resolveTextSelectionForKey(taskKey: string, tenantId?: string): Promise<{ provider: string; model: string } | null> {
    if (!this.aiTaskDefaultService) return null;
    try {
      const eff = await this.aiTaskDefaultService.getEffective(taskKey, tenantId);
      const model = eff.model;
      if (model?.provider && model.sourceUri) {
        // Catalog seeds `azure`; the text service registers `azure-openai`.
        return { provider: model.provider === 'azure' ? 'azure-openai' : model.provider, model: model.sourceUri };
      }
    } catch (error) {
      this.logger.warn({
        message: `AiTaskDefault lookup failed for '${taskKey}' — the caller's own fallback applies`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  /**
   * The single fail-closed text-selection seam every TS
   * `/api/v1/generate` caller funnels through. Resolves the effective policy
   * (tenant own → SYSTEM default → code default, with the B1 field-level
   * fallthrough) and returns a GUARANTEED-non-null `{ provider, model }`.
   *
   * Throws when the cascade yields no provider/model so the admin-managed
   * default can never be silently bypassed (the text service itself also
   * fail-closes with a 422).
   *
   * Model-routing precedence: the
   * `AiTaskDefault` key for the task (`text.live` / `text.finalize`) is consulted
   * FIRST. When it resolves to an ENABLED model, its `{ provider, sourceUri }`
   * wins (sourceUri is the provider-native identifier actually sent to the text
   * service). The legacy `HarnessPolicy.textProvider/textModel` cascade is the
   * documented fallback for tenants that have not migrated to AiTaskDefault. The
   * text service stays a stateless gateway; the model resolved here is authority.
   */
  async resolveTextSelection(tenantId?: string, task: TextRoutingTask = 'finalize'): Promise<{ provider: string; model: string }> {
    // Precedence 1 — AiTaskDefault (when wired), tenant → SYSTEM.
    const selected = await this.resolveTextSelectionForKey(TEXT_TASK_KEY[task], tenantId);
    if (selected) return selected;

    // Precedence 2 — legacy HarnessPolicy.textProvider/textModel cascade.
    const effective = await this.getEffectivePolicy(tenantId);
    if (!effective.textProvider || !effective.textModel) {
      throw new BadRequestException(
        'No text-generation model is configured for this tenant. Configure the AiTaskDefault `text.finalize`/`text.live` key or set HarnessPolicy.textProvider/textModel on the tenant or the SYSTEM default.',
      );
    }
    return { provider: effective.textProvider, model: effective.textModel };
  }

  /**
   * Resolve the tenant's per-tenant text FALLBACK selection for a task
   * (`text.<task>.fallback`) via `AiTaskDefault`. Shares
   * {@link resolveTextSelectionForKey} with the primary seam, so the
   * provider/model derivation (the model's `sourceUri` is the provider-native id
   * the text service expects; `azure` normalises to `azure-openai`) cannot drift
   * between the two tiers.
   *
   * Fail-OPEN by contract: `null` — never a throw — when the AiTaskDefault
   * service is un-wired, the key resolves to no enabled model, or the lookup
   * errors. A `null` means the caller runs no fallback (the same effect as the
   * removed `TEXT_FALLBACK_*` env being unset). Fallback is per-tenant opt-in:
   * there is NO SYSTEM default, so an un-configured tenant gets `null`.
   *
   * `task` excludes `'test'` — the test bench has no fallback tier (D-4).
   */
  async resolveTextFallbackSelection(tenantId?: string, task: TextFallbackTask = 'finalize'): Promise<{ provider: string; model: string } | null> {
    return this.resolveTextSelectionForKey(TEXT_FALLBACK_TASK_KEY[task], tenantId);
  }

  /** The SYSTEM-tenant GLOBAL-DEFAULT policy (platform editor reads this). */
  async getGlobalDefault(): Promise<HarnessPolicyResponse> {
    const sys = await this.policyRepository.findSystemDefault();
    if (sys) return toResponse(sys, 'system-default');
    return codeDefaultResponse(SYSTEM_TENANT_ID);
  }

  /** Edit the calling tenant's policy row (created on first edit). */
  async updatePolicy(dto: UpdateHarnessPolicyRequest, expectedVersion?: number): Promise<HarnessPolicyResponse> {
    const tid = this.callerTenantId;
    if (!tid) throw new BadRequestException('Tenant ID is required');
    this.assertNoSuperAdminOnlyPolicyWrites(dto);
    return this.upsert(tid, 'tenant', dto, expectedVersion);
  }

  /**
   * Tenant PATCH must not touch selection / agentic knobs
   * (SUPER_ADMIN edits those via `updateGlobalDefault`).
   */
  private assertNoSuperAdminOnlyPolicyWrites(dto: UpdateHarnessPolicyRequest): void {
    const present = SUPER_ADMIN_ONLY_POLICY_KEYS.filter((key) => (dto as Record<string, unknown>)[key] !== undefined);
    if (present.length === 0) return;
    throw new ForbiddenException(`HarnessPolicy fields [${present.join(', ')}] are managed by super administrators only.`);
  }

  /** Edit the SYSTEM-tenant GLOBAL-DEFAULT policy row (platform-only). */
  async updateGlobalDefault(dto: UpdateHarnessPolicyRequest, expectedVersion?: number): Promise<HarnessPolicyResponse> {
    return this.upsert(SYSTEM_TENANT_ID, 'system-default', dto, expectedVersion);
  }

  /**
   * Shared CAS-update-or-create for one policy row + its WORM change record.
   * `expectedVersion` (the `If-Match` value) is the CAS predicate when the row
   * exists; on first edit (no row) it is the inherited default's version and a
   * row is created instead (the UNIQUE(tenantId) index is the create backstop).
   */
  private async upsert(
    tenantId: string,
    source: HarnessPolicySource,
    dto: UpdateHarnessPolicyRequest,
    expectedVersion?: number,
  ): Promise<HarnessPolicyResponse> {
    const changedBy = this.callerUserId;
    const reason = dto.reason ?? null;
    const own = await this.policyRepository.findForExactTenant(tenantId);

    if (own) {
      const before = entityToKnobs(own);
      applyKnobsToEntity(own, dto);
      // OCC precondition BEFORE the no-changes short-circuit: a stale client must
      // get 412 ("you are stale, refetch"), not 400/200, even when the payload
      // would change nothing. RFC 7232 evaluates preconditions independently of
      // the payload; the CAS below still guards concurrent writers.
      assertExpectedVersion(own, expectedVersion, 'harnessPolicy');
      if (!own.hasChanges) {
        // Idempotent no-op edit — nothing to write or audit.
        return toResponse(own, source);
      }
      own.updatedBy = changedBy;
      own.validate();

      // Knobs after the patch == the persisted row's knobs (the update only bumps
      // `version`), so snapshot + encrypt here, before opening the transaction.
      const after = entityToKnobs(own);
      const beforeJson = before as unknown as JsonValue;
      const afterJson = after as unknown as JsonValue;
      const enc = await this.encryptChangePayloads(beforeJson, afterJson);

      const casVersion = expectedVersion ?? own.version;
      const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
        const u = await this.policyRepository.updateWithVersion(own.id, own, casVersion, tx);
        const change = HarnessPolicyChangeFactory.CreateHarnessPolicyChange({
          tenantId,
          changedBy,
          policyVersion: u.version,
          beforeJson,
          afterJson,
          encryptedBeforeJson: enc?.encryptedBeforeJson ?? null,
          encryptedAfterJson: enc?.encryptedAfterJson ?? null,
          keyVersion: enc?.keyVersion ?? null,
          reason,
          createdBy: changedBy,
        });
        await this.policyChangeRepository.create(change, tx);
        return u;
      });
      return toResponse(updated, source);
    }

    // First edit → create the row, seeded from the inherited default (the
    // SYSTEM global default for a tenant row; the code defaults for the global
    // row itself), then apply the patch over it.
    const inherited = source === 'tenant' ? await this.policyRepository.findSystemDefault() : null;

    // The create path must honor the precondition too. The
    // caller read the effective policy and echoed its version as `If-Match`;
    // what they read is the SYSTEM default's version on BOTH lanes (tenant
    // reads inherit it; the global lane reads the SYSTEM row itself), or the
    // code default's version 0 when no row exists at all. A mismatched
    // validator means they edited against a state that has since changed —
    // RFC 7232 says 412, not a silent create. Mirrors
    // `AiProviderConnectionService.upsertRow`'s absent-row check.
    const reference = source === 'tenant' ? inherited : await this.policyRepository.findSystemDefault();
    const referenceVersion = reference?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== referenceVersion) {
      throw new OptimisticConcurrencyException('harnessPolicy', `${tenantId}:${source}`, {
        expectedVersion,
        currentVersion: referenceVersion,
      });
    }

    const base: HarnessPolicyKnobs = inherited ? entityToKnobs(inherited) : (HARNESS_POLICY_DEFAULTS as unknown as HarnessPolicyKnobs);
    const merged = mergeKnobs(base, dto);
    const entity = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId, ...merged, createdBy: changedBy });
    entity.validate();

    // First edit ⇒ before is null; the created row's knobs == the entity's knobs.
    const afterJson = entityToKnobs(entity) as unknown as JsonValue;
    const enc = await this.encryptChangePayloads(null, afterJson);

    const created = await this.databaseService.baseClient.$transaction(async (tx) => {
      const c = await this.policyRepository.create(entity, tx);
      const change = HarnessPolicyChangeFactory.CreateHarnessPolicyChange({
        tenantId,
        changedBy,
        policyVersion: c.version,
        beforeJson: null,
        afterJson,
        encryptedBeforeJson: enc?.encryptedBeforeJson ?? null,
        encryptedAfterJson: enc?.encryptedAfterJson ?? null,
        keyVersion: enc?.keyVersion ?? null,
        reason,
        createdBy: changedBy,
      });
      await this.policyChangeRepository.create(change, tx);
      return c;
    });
    return toResponse(created, source);
  }
}

/** Map a hydrated policy entity to the flat effective-policy response. */
function toResponse(e: HarnessPolicyEntity, source: HarnessPolicySource): HarnessPolicyResponse {
  return {
    id: e.id,
    tenantId: e.tenantId,
    source,
    ...entityToKnobs(e),
    // judge selection is overlaid by `getEffectivePolicy` from the
    // SYSTEM `harness.judge` AiTaskDefault; null here (not a policy-row field).
    judgeProvider: null,
    judgeModel: null,
    // overlaid by `getEffectivePolicy` from the SYSTEM-shared registry.
    mcpServers: [],
    tokenBudgetPerRun: null,
    updatedAt: e.updatedAt ? e.updatedAt.toISOString() : null,
    version: e.version,
  };
}

/**
 * Fallback response when neither a tenant row nor the SYSTEM default exists —
 * the harness code defaults, with `version: 0` so the ETag interceptor emits no
 * ETag (there is no row to compare-and-set against yet).
 */
function codeDefaultResponse(tenantId: string): HarnessPolicyResponse {
  return {
    id: null,
    tenantId,
    source: 'code-default',
    ...(HARNESS_POLICY_DEFAULTS as unknown as HarnessPolicyKnobs),
    // see `toResponse`: judge selection + MCP registry are overlaid by the caller.
    judgeProvider: null,
    judgeModel: null,
    mcpServers: [],
    tokenBudgetPerRun: null,
    updatedAt: null,
    version: 0,
  };
}
