import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { Job } from 'bullmq';
import {
  DnaWritingStyleReportRepository,
  DnaWritingStyleVersionRepository,
  DnaUsageRecordRepository,
  PromptUsageRecordRepository,
  DnaWritingStyleReportFactory,
  DnaWritingStyleVersionFactory,
  DnaUsageRecordFactory,
  PromptUsageRecordFactory,
  ContextItemRepository,
  ContextItemVersionRepository,
  PromptTemplateRepository,
  JobQueue,
} from '@arcaai/domains';
import { PromptManagementService } from '../prompt-management/prompt-management.service';
import { encryptPhiFields } from '../../common';
import { HarnessPolicyService } from '../harness-policy/harness-policy.service';
import { ConfigResolver } from '../config-resolver';
import { IConsultationJobService } from '../consultation/jobs/consultation-job.service';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IPhiRedactor } from '../gate-edit-mining/IPhiRedactor';
import { GenerateDnaReportJobPayload, DnaReportJobResult } from './dna-writing-style.service';
import { JobMetricsService } from '../baseServices/observability/job-metrics.service';
import { IActiveUserContext } from '../../interfaces';

const CONTEXT_DEFAULTS = {
  maxSamples: 50,
  maxContextChars: 100_000,
} as const;

@Processor(JobQueue.GenerateDnaReport)
export class DnaWritingStyleProcessor extends WorkerHost {
  private readonly logger = new Logger(DnaWritingStyleProcessor.name);
  private readonly smrServiceUrl: string;

  constructor(
    @Inject(IConsultationJobService) private readonly jobService: IConsultationJobService,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly contextItemRepository: ContextItemRepository,
    // Used to filter the learning corpus to APPROVED summaries only.
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    private readonly dnaReportRepository: DnaWritingStyleReportRepository,
    private readonly dnaVersionRepository: DnaWritingStyleVersionRepository,
    private readonly dnaUsageRecordRepository: DnaUsageRecordRepository,
    private readonly promptUsageRecordRepository: PromptUsageRecordRepository,
    private readonly promptManagementService: PromptManagementService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly jobMetrics: JobMetricsService,
    private readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Resolver for the tenant's effective SMR {provider, model}.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // Gate the AUTOMATIC learning corpus on the
    // effective DNA flag (tenant AND doctor): a doctor who has opted out (or whose
    // tenant disabled DNA) is never learned-from. Optional + trailing so existing
    // positional fixtures keep their arity; production DI supplies it via
    // ConfigResolverModule. When unset, gating is a no-op (pre-Phase-6 behaviour).
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // TASK-700: reads the resolved DNA_ANALYSIS template's
    // `metaData.promptConfig.outputSchema` (entity-level access — the
    // `PromptTemplateResponse` DTO from `promptManagementService` does not
    // surface `metaData`; mirrors the `live-agent-resolution.service.ts`
    // precedent). Optional + trailing so existing positional fixtures keep
    // their arity; when unset, DNA generation falls back to the pre-Phase-7
    // unconstrained-JSON parsing (legacy fixtures / templates with no schema).
    @Optional() @Inject(PromptTemplateRepository) private readonly promptTemplateRepository?: PromptTemplateRepository,
    // PHI redaction seam (TASK-710, hop 2: approved-notes corpus → SMR).
    // Optional + trailing so existing positional fixtures keep their arity;
    // production DI (DnaWritingStyleServiceModule) always supplies it via
    // PhiRedactionServiceModule. FULL redaction — the DNA profile is a
    // retained, cross-patient artifact (see IPhiRedactor's mode doc), not
    // pseudonymization. Fail-closed: a throwing redactor propagates into the
    // existing outer catch and aborts the job (mirrors the opt-out throw
    // above); it never falls back to the unredacted corpus.
    @Optional() @Inject(IPhiRedactor) private readonly phiRedactor?: IPhiRedactor,
  ) {
    super();
    this.smrServiceUrl = this.configService.get<string>('TEXT_URL') ?? 'http://localhost:8862';
  }

  async process(job: Job<GenerateDnaReportJobPayload>): Promise<DnaReportJobResult> {
    return this.clsService.run(async () => {
      return this.processWithContext(job);
    });
  }

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  private async processWithContext(job: Job<GenerateDnaReportJobPayload>): Promise<DnaReportJobResult> {
    const { doctorId, tenantId, userId, textSamples, sourceIds } = job.data;

    this.clsService.set('tenantId', tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.clsService.set('user', { id: userId } as any);

    const maxSamples = this.appSettingsService.getValueWithDefault<number>('dna-regen.max-samples', CONTEXT_DEFAULTS.maxSamples);
    const maxContextChars = this.appSettingsService.getValueWithDefault<number>('dna-regen.max-context-chars', CONTEXT_DEFAULTS.maxContextChars);
    const endTimer = this.jobMetrics.recordJobStart(JobQueue.GenerateDnaReport);
    const waitMs = Date.now() - job.timestamp;
    this.jobMetrics.recordWaitingDuration(JobQueue.GenerateDnaReport, waitMs / 1000);

    try {
      await job.updateProgress(10);
      this.jobService.notifyProgress(job.data.jobId, 10, 'Gathering text samples');
      let samples: string;
      // Explainability: track which context items contributed.
      let sourceContextItemIds: string[] = [];

      // Gate BOTH paths on the effective DNA flag (tenant AND doctor). A
      // doctor who has opted out (or whose tenant disabled DNA) must never be
      // learned-from — this now applies to the automatic corpus AND an
      // explicit `textSamples` request (admin/migration): the opt-out is a
      // patient-privacy control, not merely a "don't auto-learn" toggle, so an
      // admin/migration caller cannot use `textSamples` to override it. Only
      // the approved-notes-only corpus filter below stays scoped to the
      // automatic path (see its own comment). No-op when ConfigResolver is
      // unwired (legacy fixtures).
      if (this.configResolver) {
        const { effective } = await this.configResolver.resolveEffectiveDnaStyleEnabled({ tenantId, doctorId });
        if (!effective) {
          this.jobService.notifyFailed(job.data.jobId, 'DNA writing style is disabled for this doctor');
          throw new Error('DNA writing style is disabled for this doctor (opt-out or tenant flag off)');
        }
      }

      if (textSamples && textSamples.length > 0) {
        samples = textSamples.join('\n\n---\n\n');
        // Generate-from-history passes samples directly plus the
        // selected source IDs; record them so the report stays explainable.
        if (sourceIds && sourceIds.length > 0) {
          sourceContextItemIds = sourceIds;
        }
      } else {
        const contextItems = await this.contextItemRepository.findAll({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filters: { doctorId } as any,
          sort: [{ createdAt: 'desc' }],
          limit: maxSamples,
        });

        if (!contextItems || contextItems.length === 0) {
          this.jobService.notifyFailed(job.data.jobId, 'No text samples available');
          throw new Error('No text samples available for DNA analysis');
        }

        // Corpus filter:
        //   1. Only RAW_SUMMARY or MODIFIED_SUMMARY (final summaries).
        //   2. Only items with at least one ContextItemVersion whose
        //      changeReason is 'approved' (see SummaryService.approveSummary).
        // This prevents the DNA writing-style model from learning from
        // unreviewed AI output or from non-summary content (transcripts,
        // pre-summaries, case notes).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const finalSummaries = (contextItems as any[]).filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (item: any) => item?.type === 'RAW_SUMMARY' || item?.type === 'MODIFIED_SUMMARY',
        );

        // Build draft↔approved PAIRS: for each approved
        // summary also fetch its immutable `ai_draft_v1` snapshot so the DNA model
        // learns the doctor's EDIT behaviour (draft → approved), not just the final
        // prose. Back-compat: a legacy summary with no v1 snapshot
        // falls back to final-only.
        const pairs: Array<{ id: string; draft: string | null; approved: string }> = [];
        for (const item of finalSummaries) {
          if (!item?.id) continue;
          const approvedVersions = await this.contextItemVersionRepository.getVersionsByChangeReason(item.id, 'approved');
          if (approvedVersions && approvedVersions.length > 0) {
            const approvedContent: string = item.content ?? item.text ?? '';
            const draftVersions = await this.contextItemVersionRepository.getVersionsByChangeReason(item.id, 'ai_draft_v1');
            const draftContent: string | null = draftVersions?.[0]?.content ?? null;
            pairs.push({ id: item.id, draft: draftContent, approved: approvedContent });
          }
        }

        if (pairs.length === 0) {
          this.jobService.notifyFailed(job.data.jobId, 'No approved samples available');
          throw new Error('No approved text samples available for DNA analysis');
        }

        sourceContextItemIds = pairs.map((p) => p.id);
        samples = DnaWritingStyleProcessor.buildCorpus(pairs);
      }

      if (samples.length > maxContextChars) {
        samples = samples.substring(0, maxContextChars);
      }

      // TASK-710 hop 2: FULL redaction before the corpus reaches SMR — the DNA
      // profile is a retained, cross-patient artifact (see IPhiRedactor's mode
      // doc), unlike hop 1's pseudonymize-for-NER posture. Scoped to inserting
      // the call regardless of which branch (textSamples bypass vs. the
      // automatic corpus) populated `samples` — the branch itself is TASK-700's
      // territory, not touched here. Fail-closed by propagation: a throwing
      // redactor falls into the existing outer catch below and aborts the job.
      if (this.phiRedactor) {
        samples = await this.phiRedactor.redact(samples, 'full');
      }

      await job.updateProgress(20);
      this.jobService.notifyProgress(job.data.jobId, 20, 'Loading DNA analysis prompt');
      const templates = await this.promptManagementService.listPromptTemplates({ category: 'DNA_ANALYSIS' });
      const resolvedTemplate = templates[0] ?? null;
      const systemPrompt = resolvedTemplate?.content ?? 'Analyze the following text samples and extract the writing style patterns.';

      // The `PromptTemplateResponse` DTO does not surface `metaData` (it is
      // internal prompt config, not part of the admin-console-facing
      // contract), so read the entity directly — same pattern as
      // `live-agent-resolution.service.ts`'s `systemPromptFor`. A schema-read
      // failure degrades to `null` (unconstrained legacy parsing) rather than
      // failing the job — the schema is a containment IMPROVEMENT, not itself
      // a new single point of failure.
      let outputSchema: Record<string, unknown> | null = null;
      if (resolvedTemplate && this.promptTemplateRepository) {
        try {
          const templateEntity = await this.promptTemplateRepository.findById(resolvedTemplate.id);
          outputSchema = DnaWritingStyleProcessor.extractOutputSchema(templateEntity?.metaData);
        } catch (error) {
          this.logger.warn(`Failed to resolve DNA output schema for template ${resolvedTemplate.id}: ${error}`);
        }
      }

      await job.updateProgress(40);
      this.jobService.notifyProgress(job.data.jobId, 40, 'Generating DNA analysis');
      const smrResponse = await this.callSmr(samples, systemPrompt, outputSchema);

      await job.updateProgress(80);
      this.jobService.notifyProgress(job.data.jobId, 80, 'Storing results');

      let reportData: Record<string, unknown> = {};
      let styleText = '';

      let parsed: unknown;
      try {
        parsed = JSON.parse(smrResponse.content);
      } catch {
        this.jobService.notifyFailed(job.data.jobId, 'DNA analysis returned an unparseable or non-conforming response');
        throw new Error('DNA analysis returned an unparseable or non-conforming response');
      }

      if (outputSchema) {
        // Never trust `strict: true` alone — validate the parsed shape against
        // the schema's `required` list, closed `additionalProperties`, and
        // per-property `enum`/`maxLength` constraints before accepting it. A
        // schema-mismatched response (missing key, extra key, or a value
        // outside its closed vocabulary — e.g. a free sentence smuggled into
        // `sectionOrderPreference`) hard-fails the job; no partial recovery.
        if (!DnaWritingStyleProcessor.conformsToSchema(parsed, outputSchema)) {
          this.jobService.notifyFailed(job.data.jobId, 'DNA analysis returned an unparseable or non-conforming response');
          throw new Error('DNA analysis returned an unparseable or non-conforming response');
        }
        reportData = parsed;
        // The persisted `styleText` is rendered DETERMINISTICALLY from the
        // validated closed-vocabulary fields — never the model's raw prose —
        // so nothing outside the schema's enum/length-capped values can ever
        // reach the text injected into a future summary's system prompt.
        styleText = DnaWritingStyleProcessor.buildStyleTextFromSchema(reportData);
      } else if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Legacy path: no schema attached to the resolved template (an
        // un-migrated tenant/template, or the fallback prompt with no
        // resolved template at all). Preserves pre-TASK-700 permissive
        // mapping for backward compatibility.
        const obj = parsed as Record<string, unknown>;
        reportData = (obj.reportData as Record<string, unknown> | undefined) ?? obj;
        styleText = typeof obj.styleText === 'string' ? obj.styleText : smrResponse.content;
      } else {
        // Valid JSON but not an object (e.g. a bare string/number/array) and
        // no schema to validate against — nothing safe to persist.
        this.jobService.notifyFailed(job.data.jobId, 'DNA analysis returned an unparseable or non-conforming response');
        throw new Error('DNA analysis returned an unparseable or non-conforming response');
      }

      // Explainability: persist the corpus source IDs alongside
      // the analytic report. Consumers can audit which approved summaries
      // shaped this DNA writing-style snapshot.
      if (sourceContextItemIds.length > 0) {
        reportData = { ...reportData, sourceContextItemIds };
      }

      const previousLatest = await this.dnaReportRepository.findLatestForDoctor(doctorId);
      if (previousLatest) {
        previousLatest.isLatest = false;
        await this.dnaReportRepository.update(previousLatest.id, previousLatest);
      }

      const reportEntity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({
        tenantId,
        doctorId,
        reportData,
        styleText,
        isLatest: true,
        currentVersionNumber: 1,
        createdBy: userId,
      });

      // Encrypt reportData/styleText into the ciphertext columns before the
      // first persist. Best-effort: a Vault outage must not fail DNA generation.
      await this.encryptBestEffort('DnaWritingStyleReport', () =>
        this.dnaReportRepository.encryptFieldsIntoEntity(reportEntity, this.secretsService!),
      );

      const saved = await this.dnaReportRepository.create(reportEntity);

      const versionEntity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({
        tenantId,
        dnaReportId: saved.id,
        versionNumber: 1,
        reportData,
        styleText,
        changeReason: 'AI-generated initial analysis',
        changedBy: userId,
      });

      await this.encryptBestEffort('DnaWritingStyleVersion', () =>
        this.dnaVersionRepository.encryptFieldsIntoEntity(versionEntity, this.secretsService!),
      );

      await this.dnaVersionRepository.create(versionEntity);

      const usageEntity = DnaUsageRecordFactory.CreateDnaUsageRecord({
        tenantId,
        doctorId,
        dnaReportId: saved.id,
        dnaVersionNumber: 1,
      });

      await this.dnaUsageRecordRepository.create(usageEntity);

      if (resolvedTemplate) {
        const promptUsageEntity = PromptUsageRecordFactory.CreatePromptUsageRecord({
          tenantId,
          doctorId,
          promptTemplateId: resolvedTemplate.id,
          promptVersionNumber: resolvedTemplate.currentVersionNumber ?? 1,
        });
        await this.promptUsageRecordRepository.create(promptUsageEntity);
      }

      const duration = endTimer();
      this.jobMetrics.recordJobComplete(JobQueue.GenerateDnaReport, 'DnaWritingStyleProcessor', duration);

      await job.updateProgress(100);
      this.jobService.notifyProgress(job.data.jobId, 100, 'Complete');
      this.jobService.notifyComplete(job.data.jobId, { reportId: saved.id });

      return {
        reportId: saved.id,
        reportData,
        styleText,
      };
    } catch (error) {
      endTimer();
      this.jobMetrics.recordJobFailed(
        JobQueue.GenerateDnaReport,
        'DnaWritingStyleProcessor',
        error instanceof Error ? error.constructor.name : 'UnknownError',
      );
      this.logger.error(`DNA report generation failed: ${error}`);
      this.jobService.notifyFailed(job.data.jobId, `DNA generation failed: ${error}`);
      throw error;
    }
  }

  /**
   * Render the learning corpus from draft↔approved pairs.
   * A pair whose captured AI draft DIFFERS from the approved text is rendered as
   * an explicit `AI DRAFT` → `DOCTOR APPROVED` block so the model learns the
   * doctor's edit behaviour. Pairs with no draft snapshot (legacy) or an unchanged
   * draft fall back to the raw approved text only — byte-identical to the
   * pre-Phase-6 final-only corpus (so empty approvals still contribute nothing).
   */
  private static buildCorpus(pairs: Array<{ draft: string | null; approved: string }>): string {
    return pairs
      .map(({ draft, approved }) => {
        const hasDraftDelta = !!draft && draft.trim().length > 0 && draft !== approved;
        return hasDraftDelta ? `AI DRAFT:\n${draft}\n\nDOCTOR APPROVED:\n${approved}` : approved;
      })
      .filter((s) => s.length > 0)
      .join('\n\n---\n\n');
  }

  private async callSmr(
    textSamples: string,
    systemPrompt: string,
    outputSchema?: Record<string, unknown> | null,
  ): Promise<{
    content: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    latency_ms?: number;
  }> {
    const smrStart = Date.now();
    // SMR is a stateless gateway with no model default; resolve the
    // tenant's effective {provider, model} (CLS tenant set by processWithContext)
    // and pass both explicitly on the generate call.
    let provider: string | undefined;
    let model: string | undefined;
    if (this.harnessPolicyService) {
      ({ provider, model } = await this.harnessPolicyService.resolveSmrSelection());
    }
    const response = await this.httpService.axiosRef.post(
      `${this.smrServiceUrl}/api/v1/generate`,
      {
        prompt: textSamples,
        system_prompt: systemPrompt,
        stream: false,
        provider,
        model,
        // TASK-700: constrain DNA output to the closed-vocabulary schema
        // (mirrors the SOAP `response_format` binding —
        // `smr-compat.controller.ts`'s `response_format: { type: 'json_schema',
        // json_schema: responseSchema, strict: true }`). Omitted entirely
        // (not even as `undefined`) when the resolved template carries no
        // schema, so the outgoing payload shape is unchanged for legacy
        // templates/fixtures.
        ...(outputSchema ? { response_format: { type: 'json_schema' as const, json_schema: outputSchema, strict: true } } : {}),
      },
      {
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': (await this.secretsService?.getSecretOptional('TEXT_SERVICE_TOKEN')) ?? '',
        },
      },
    );
    this.jobMetrics.recordSmrCallDuration(JobQueue.GenerateDnaReport, 'smr', (Date.now() - smrStart) / 1000);
    return response.data;
  }

  /**
   * Defensive extraction of `metaData.promptConfig.outputSchema`. `metaData`
   * is JSON with no DB-enforced shape, so every level is validated: not an
   * object, an array, missing, or the wrong type at any step ⇒ `null` (the
   * caller's cue to fall back to the legacy unconstrained parse). Mirrors
   * `live-agent-resolution.service.ts`'s `extractCustomSystemPrompt`.
   */
  private static extractOutputSchema(metaData: unknown): Record<string, unknown> | null {
    if (!metaData || typeof metaData !== 'object' || Array.isArray(metaData)) return null;
    const promptConfig = (metaData as Record<string, unknown>).promptConfig;
    if (!promptConfig || typeof promptConfig !== 'object' || Array.isArray(promptConfig)) return null;
    const outputSchema = (promptConfig as Record<string, unknown>).outputSchema;
    if (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) return null;
    return outputSchema as Record<string, unknown>;
  }

  /**
   * Validate a parsed SMR response against a (JSON-Schema-shaped) DNA output
   * schema — client-side, never trusting that SMR/the model honored
   * `strict: true`. Checks, in order:
   *   1. `parsed` is a plain object.
   *   2. every `required` top-level key is present (not `undefined`/`null`).
   *   3. when `additionalProperties === false`, no key outside `properties`.
   *   4. every property with a declared `enum` has a value inside it.
   *   5. every property with a declared `maxLength` has a value within it —
   *      the specific defense against a free-text/quoted-sentence value
   *      smuggled into an otherwise-permitted string field (e.g.
   *      `sectionOrderPreference`).
   */
  private static conformsToSchema(parsed: unknown, schema: Record<string, unknown>): parsed is Record<string, unknown> {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const obj = parsed as Record<string, unknown>;

    const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string') : [];
    for (const key of required) {
      if (obj[key] === undefined || obj[key] === null) return false;
    }

    const properties = (
      schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {}
    ) as Record<string, { enum?: unknown[]; maxLength?: number }>;

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) return false;
      }
    }

    for (const [key, propSchema] of Object.entries(properties)) {
      const value = obj[key];
      if (value === undefined) continue;
      if (Array.isArray(propSchema.enum) && typeof value === 'string' && !propSchema.enum.includes(value)) return false;
      if (typeof propSchema.maxLength === 'number' && typeof value === 'string' && value.length > propSchema.maxLength) return false;
    }

    return true;
  }

  /**
   * Deterministically render the persisted `styleText` from a
   * schema-validated DNA profile. Every value used here has already passed
   * `conformsToSchema` (a closed enum or a length-capped string), so this can
   * never emit anything the model wrote freely — the structural PHI
   * containment guarantee lives here, not in a post-hoc scan of the text.
   */
  private static buildStyleTextFromSchema(profile: Record<string, unknown>): string {
    const str = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim().length > 0 ? value : fallback);

    const sentenceStructure = str(profile.sentenceStructure, 'mixed');
    const verbosity = str(profile.verbosity, 'moderate');
    const listVsNarrative = str(profile.listVsNarrative, 'mixed');
    const sectionOrderPreference = str(profile.sectionOrderPreference, '');
    const abbreviationFrequency = str(profile.abbreviationFrequency, 'medium');
    const toneFormality = str(profile.toneFormality, 'neutral');

    return [
      `Sentence structure: ${sentenceStructure}.`,
      `Verbosity: ${verbosity}.`,
      `Lists vs narrative: ${listVsNarrative}.`,
      sectionOrderPreference ? `Preferred section order: ${sectionOrderPreference}.` : null,
      `Abbreviation frequency: ${abbreviationFrequency}.`,
      `Tone: ${toneFormality}.`,
    ]
      .filter((part): part is string => part !== null)
      .join(' ');
  }
}
