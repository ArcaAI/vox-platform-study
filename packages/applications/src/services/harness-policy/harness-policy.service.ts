import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { assertExpectedVersion } from '../../common/assertExpectedVersion';
import { ClsService } from 'nestjs-cls';
import {
  CoreDatabaseService,
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
import { NotFoundException } from '@nestjs/common';
import { IAiTaskDefaultService } from '../ai-task-default/IAiTaskDefaultService';
import { TaskSelectionVetoedError } from '../ai-routing-policy/task-selection-veto';
import { TextAgentResolverService } from '../agent/text-agent-resolver.service';
import type { ResolvedTextFallback } from '../agent/text-generation-spec';
import { SecretsService } from '../baseServices/_meta/secrets';
import { McpServerDtoMapper } from '../mcp-server/mcp-server.dto.mapper';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { AGENTIC_CONTEXT_KEY_PREFIX } from '../settings-registry/descriptors/agentic-context.descriptors';
import type { McpServerResponse } from '../mcp-server/dto';
import { HarnessPolicyResponse, HarnessPolicySource, UpdateHarnessPolicyRequest } from './dto';

/**
 * The TEXT routing tasks callers name — INFORMATIONAL since TASK-876:
 *  - `live` → the live-documentation delta summariser.
 *  - `finalize` → the final/comprehensive summary generator.
 *  - `test` → the tenant-admin prompt-template test bench.
 *
 * The task no longer SELECTS a model. Selection is the tenant's assigned TEXT_GENERATION
 * agent (`department → tenant → SYSTEM`, one `AgentAssignment` per scope — the assignment has
 * no role dimension), resolved through `TextAgentResolverService`. A workflow that wants a
 * different model per node binds a `core.agent` with an explicit `agentRef`. The parameter is
 * kept because every caller stamps it as telemetry (`task_key` on the generation stats).
 */
export type TextRoutingTask = 'live' | 'finalize' | 'test';

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
   * Master gate for the MCP external-tools path. `null ⇒ no opinion`, which
   * widens to the SYSTEM default and, absent that too, means OFF — so the
   * feature stays dormant until it is explicitly flipped AND the referenced
   * `McpServer.enabled` is true.
   *
   * PER-TENANT since OD-11 (2026-09-01): a tenant admin sets it on its own
   * policy row and that value wins; SYSTEM supplies the platform default for
   * tenants with no opinion.
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
  // NOTE: `mcpToolsEnabled` used to live here. OWNER DECISION **OD-11**
  // (2026-09-01) makes MCP tools PER-TENANT, so it resolves on the standard
  // tenant → SYSTEM cascade instead (see TENANT_INHERITS_ON_NULL_KEYS below).
  // A platform-wide emergency kill-switch may sit ABOVE it, but this list is
  // not that switch — membership here means "SYSTEM always wins", which is
  // exactly the semantics OD-11 removed.
] as const satisfies readonly (keyof HarnessPolicyKnobs)[];

/**
 * Nullable knobs a tenant may own, where `null` means **"no opinion"** rather
 * than "off" — so the tenant row widens to the SYSTEM default on ABSENCE, which
 * is the two-tier cascade every other config surface uses
 * (`09-infrastructure-devops.md` §Tenant-first resolution).
 *
 * Why this is not merely tidy: a tenant policy row is created on the first edit
 * of ANY knob (a clinical threshold, say). Without null-widening, that unrelated
 * edit would freeze `mcpToolsEnabled` at `null` ⇒ OFF for the tenant, silently
 * revoking a platform default it had been inheriting. The tenant would have
 * disabled MCP by editing a faithfulness threshold.
 */
const TENANT_INHERITS_ON_NULL_KEYS = ['mcpToolsEnabled'] as const satisfies readonly (keyof HarnessPolicyKnobs)[];

const KNOB_KEYS = Object.keys(HARNESS_POLICY_DEFAULTS) as (keyof HarnessPolicyKnobs)[];

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
    // optional so existing fixtures keep their 4/5-arg construction. Since TASK-876 it
    // serves ONLY the SYSTEM-only `harness.judge` selection — text selection is the assigned
    // TEXT_GENERATION agent (`textAgents`, below).
    @Optional() @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService?: IAiTaskDefaultService,
    // The SYSTEM-shared MCP registry the worker resolves tool
    // calls against. Optional + trailing so existing fixtures keep their arity;
    // absent ⇒ `mcpServers: []`, i.e. nothing callable (the safe default).
    @Optional() @Inject(McpServerRepository) private readonly mcpServerRepository?: McpServerRepository,
    // Settings-registry read facade for the per-run token budget.
    // Optional + trailing; absent ⇒ null budget ⇒ the harness stays unbounded.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // TASK-876 — the ONE text selection seam: the tenant's assigned TEXT_GENERATION agent.
    // Optional + trailing so existing fixtures keep their arity; absent ⇒ `resolveTextSelection`
    // FAILS CLOSED (selection is `failMode: closed`), never a substituted model.
    @Optional() @Inject(TextAgentResolverService) private readonly textAgents?: TextAgentResolverService,
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
  private async resolveMcpServers(tenantId: string): Promise<McpServerResponse[]> {
    if (!this.mcpServerRepository) return [];
    try {
      // OD-7: tenant admins register their OWN connectors, so the worker must
      // receive the tenant's rows ALONGSIDE the SYSTEM-shared registry. This is
      // a UNION (a registry), not the override cascade the knobs use — the
      // shared platform servers stay available to every tenant. Scoping to
      // [tenant, SYSTEM] keeps the two-tier boundary: no other customer's rows.
      const scope = tenantId === SYSTEM_TENANT_ID ? [SYSTEM_TENANT_ID] : [tenantId, SYSTEM_TENANT_ID];
      const rows = await this.mcpServerRepository.findAll({ where: { tenantId: { in: scope } } } as never);
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
   * `opts.consultationId` NO LONGER SELECTS ANYTHING ( / OD-12). It used
   * to layer the consultation's department default `DepartmentAgent.harnessOverrides`
   * on top of the resolved policy — an overlay that ran on EVERY return path.
   * The owner decision was to RETIRE that tier outright rather than repoint it:
   * a per-agent override tier has no successor in the workflow substrate, where
   * a node's safety envelope is the node's own config and the tenant's harness
   * policy is the tenant's. Resolution is therefore back to
   * `code default → SYSTEM → tenant`, and `overridesSource` is gone with it.
   *
   * The PARAMETER is retained because `harness-internal.controller.ts` threads it
   * from a wire route the Temporal worker calls, and that controller is not this
   * ticket's to edit. Removing the query param is a follow-on for whoever owns
   * that module; nothing reads it here.
   *
   * TASK-876: the tenant's ASSIGNED TEXT_GENERATION agent (`resolveTextSelection`) overlays
   * `textProvider`/`textModel` on whichever policy row wins — the Python interpreter nodes
   * (`generate.text`, `consultation.realtimeSummary`, the Lane N judgements) read their selection
   * off exactly these two fields.
   *
   * The overlay is UNCONDITIONAL. It used to be gated on `opts.taskKey`, and that gate was a
   * live selection hole: `AgentAssignment`'s key is `(scope, scopeId, task)` — it carries NO role
   * dimension — so a task key never chose WHICH agent serves, while the DURABLE lane
   * (`activities.fetch_policy` → `workflows.py`, which sends no task key) kept reading the
   * RETIRED `HarnessPolicy.textProvider/textModel` columns straight into `GenerateInput`.
   *
   * FAIL-CLOSED: when no agent is assigned at any tier both fields are NULLED and the miss is
   * logged as a configuration error, so the node degrades `no_text_selection` — the legacy
   * columns are never served as a selection again. `opts.modelSlug` (the retired `llmBinding`)
   * is accepted for the wire and consulted by nothing.
   */
  async getEffectivePolicy(
    tenantId?: string,
    opts?: { consultationId?: string; taskKey?: string; /** @deprecated TASK-876 — inert; the node's `llmBinding` is retired. */ modelSlug?: string },
  ): Promise<HarnessPolicyResponse> {
    const tid = tenantId ?? this.callerTenantId;
    if (!tid) throw new BadRequestException('Tenant ID is required');
    const taskSelection = await this.resolveTextSelectionOrNull(tid);
    const applyTaskSelection = (resp: HarnessPolicyResponse): HarnessPolicyResponse => {
      resp.textProvider = taskSelection?.provider ?? null;
      resp.textModel = taskSelection?.model ?? null;
      return resp;
    };

    // the judge provider/model come from the SYSTEM-only
    // `harness.judge` AiTaskDefault, independent of which policy row wins. Resolve
    // once and overlay onto whichever response we return (mirrors the SYSTEM
    // selection-knob overlay below). Null when unconfigured ⇒ the harness falls
    // back to its env/code judge default.
    const judge = await this.resolveJudgeSelection(tid);
    // The MCP registry is independent of which policy row wins, so resolve it
    // once and overlay onto every return path below (same pattern as the judge
    // selection above). Scoped to [tenant, SYSTEM] since OD-7 (tenant-owned
    // connectors), not SYSTEM alone.
    const [mcpServers, tokenBudgetPerRun] = await Promise.all([this.resolveMcpServers(tid), this.resolveTokenBudgetPerRun(tid)]);

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
        // OD-11 cascade: the tenant's own value wins, and SYSTEM fills in only
        // where the tenant expressed NO opinion (null). Widening on absence —
        // never overriding a value the tenant actually set.
        for (const key of TENANT_INHERITS_ON_NULL_KEYS) {
          if ((resp as unknown as Record<string, unknown>)[key] == null) {
            (resp as unknown as Record<string, unknown>)[key] = sysKnobs[key];
          }
        }
      }
      resp.judgeProvider = judge.judgeProvider;
      resp.judgeModel = judge.judgeModel;
      resp.mcpServers = mcpServers;
      resp.tokenBudgetPerRun = tokenBudgetPerRun;
      return applyTaskSelection(resp);
    }

    const sys = await this.policyRepository.findSystemDefault();
    if (sys) {
      const resp = toResponse(sys, 'system-default');
      resp.judgeProvider = judge.judgeProvider;
      resp.judgeModel = judge.judgeModel;
      resp.mcpServers = mcpServers;
      resp.tokenBudgetPerRun = tokenBudgetPerRun;
      return applyTaskSelection(resp);
    }

    const resp = codeDefaultResponse(tid);
    resp.judgeProvider = judge.judgeProvider;
    resp.judgeModel = judge.judgeModel;
    resp.mcpServers = mcpServers;
    resp.tokenBudgetPerRun = tokenBudgetPerRun;
    return applyTaskSelection(resp);
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
      // A VETO is not a lookup failure. The tenant switched its own selection
      // off, and degrading to the env/code judge default would answer that by
      // running the model it declined (TASK-872).
      if (error instanceof TaskSelectionVetoedError) throw error;
      this.logger.warn({
        message: `AiTaskDefault judge lookup failed for '${JUDGE_TASK_KEY}' — harness will use its env/code judge default`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { judgeProvider: null, judgeModel: null };
  }

  /**
   * TASK-876 — the single fail-closed text-selection seam every TS `/api/v1/generate` caller
   * funnels through (the live loop, the finalize/pre-summary processors, the DNA processor,
   * the text proxy and the v1 compat controller).
   *
   * ONE tier: the tenant's assigned TEXT_GENERATION agent, `department → tenant → SYSTEM`,
   * through `TextAgentResolverService` (which also owns the fallback chain and per-row derived
   * funding). Returns the resolved primary's `{ provider, model }` — the provider as apps/text
   * registers it (`azure` → `azure-openai`) and the provider-native model id (`sourceUri`).
   *
   * `departmentId` is what makes the DEPARTMENT tier of that cascade reachable at all: this seam
   * used to call `resolve({ tenantId })` unconditionally, so a department-scoped `AgentAssignment`
   * could never win. Callers that hold the consultation pass its department; the rest pass null,
   * which starts the cascade at the tenant tier. Null is the honest answer — never a fabricated
   * department.
   *
   * Removed here: the node `llmBinding` (precedence 0), the `text.*` `AiTaskDefault` keys
   * (precedence 1) and the `HarnessPolicy.textProvider/textModel` columns (precedence 2). The
   * routing-policy read does NOT survive as a terminal fallback: the seed ships a SYSTEM
   * TENANT-scope TEXT_GENERATION assignment (`platform-summarization`), so "no agent anywhere"
   * is a configuration error, reported as such.
   *
   * Throws (fail-closed) when nothing is assigned or the resolver is not wired — selection is
   * `failMode: closed`; a tenant veto of the primary provider propagates unchanged.
   */
  async resolveTextSelection(
    tenantId?: string,
    task: TextRoutingTask = 'finalize',
    departmentId?: string | null,
  ): Promise<{ provider: string; model: string }> {
    const tid = tenantId ?? this.callerTenantId;
    if (!tid) throw new BadRequestException('Tenant ID is required');
    if (!this.textAgents) {
      throw new BadRequestException(
        `Text selection for the '${task}' task cannot be resolved: the TEXT_GENERATION agent resolver is not wired in this composition.`,
      );
    }
    try {
      const spec = await this.textAgents.resolve({ tenantId: tid, departmentId: departmentId ?? null });
      return { provider: spec.primary.provider, model: spec.primary.model };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new BadRequestException(
          'No TEXT_GENERATION agent is assigned for this tenant. Assign a published TEXT_GENERATION agent at TENANT or DEPARTMENT scope, or restore the SYSTEM platform default assignment.',
        );
      }
      throw error;
    }
  }

  /**
   * `resolveTextSelection` for the `getEffectivePolicy` overlay: `null` = nothing assigned, which
   * NULLS both fields so the Python node degrades `no_text_selection`. Logged at ERROR — with no
   * agent at the department, tenant OR SYSTEM tier the platform is misconfigured, and the one
   * thing that must never happen instead is the retired `HarnessPolicy` columns passing through
   * as a selection. A veto (or any non-`BadRequestException`) still propagates.
   */
  private async resolveTextSelectionOrNull(tenantId: string): Promise<{ provider: string; model: string } | null> {
    try {
      // No department: this route is reached with a tenant and (optionally) a CONSULTATION id,
      // and deriving the consultation's department here would mean a consultation read this
      // service has no repository for. Null is honest — the cascade starts at the tenant tier —
      // and it is never fabricated. Threading it is a follow-on for whoever gives this service
      // the consultation read.
      return await this.resolveTextSelection(tenantId, 'finalize', null);
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.error({
          message: 'No assigned TEXT_GENERATION agent for the effective-policy overlay — text selection nulled (configuration error, fail closed)',
          tenantId,
          error: error.message,
        });
        return null;
      }
      throw error;
    }
  }

  /**
   * The tenant's text FALLBACK for a task — the FIRST candidate of the resolved agent's
   * ordered chain (explicit fallback agent | the agent's own model chain, then the SYSTEM
   * platform default), gated by the tenant's per-agent HA toggle
   * (`parameters.fallback.autoSwitch`, ON by default — owner decision #4).
   *
   * Fail-OPEN by contract: `null` — never a throw — when the toggle is off, the chain is empty
   * (the primary IS the platform default), the resolver is un-wired, or the lookup faults. A
   * `null` means the caller runs no fallback. The per-tenant `text.*.fallback` AiTaskDefault
   * keys are no longer read.
   */
  async resolveTextFallbackSelection(
    tenantId?: string,
    task: Exclude<TextRoutingTask, 'test'> = 'finalize',
    departmentId?: string | null,
  ): Promise<{ provider: string; model: string } | null> {
    const tid = tenantId ?? this.callerTenantId;
    if (!tid || !this.textAgents) return null;
    try {
      const spec = await this.textAgents.resolve({ tenantId: tid, departmentId: departmentId ?? null });
      if (!spec.fallback.autoSwitch) return null;
      const next = spec.fallback.chain[0];
      return next ? { provider: next.provider, model: next.model } : null;
    } catch (error) {
      this.logger.warn({
        message: `Text fallback resolution failed for the '${task}' task — no fallback runs`,
        tenantId: tid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * TASK-876 — the RESOLVED TEXT_GENERATION fallback chain for the durable worker lane.
   *
   * The realtime lane and the harness `core.agent` activity already receive this block (on the
   * spec and on `GET /internal/agents/resolve` respectively). The DURABLE documentation workflow
   * received only `textProvider`/`textModel`, so a Text outage mid-run failed the run outright
   * while every other text lane had platform HA. The internal policy route now ships it too, the
   * workflow snapshots it as plain activity input, and the `generate` activity walks it.
   *
   * Deliberately NOT a field on `HarnessPolicyResponse`: that DTO is the PUBLIC admin-policy
   * shape, and the chain is worker-plane data (a candidate carries a one-hop provider override).
   * The `@ApiExcludeController()` internal route composes it onto its own answer instead.
   *
   * Fail-OPEN, exactly like `resolveTextFallbackSelection`: `null` when the toggle is off, the
   * chain is empty, the resolver is un-wired or the lookup faults — the workflow then runs the
   * primary alone, which is the behaviour it had before this block existed.
   */
  async resolveTextFallbackChain(tenantId?: string, departmentId?: string | null): Promise<ResolvedTextFallback | null> {
    const tid = tenantId ?? this.callerTenantId;
    if (!tid || !this.textAgents) return null;
    try {
      const spec = await this.textAgents.resolve({ tenantId: tid, departmentId: departmentId ?? null });
      return spec.fallback.chain.length > 0 ? spec.fallback : null;
    } catch (error) {
      this.logger.warn({
        message: 'Text fallback chain resolution failed for the worker policy read — the run keeps the primary alone',
        tenantId: tid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
