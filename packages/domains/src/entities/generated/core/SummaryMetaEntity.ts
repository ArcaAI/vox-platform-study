/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Entities from '../../../entities';

export interface ISummaryMetaEntity extends IBaseTenantEntity {
  contextItemId: string;
  aiModelId?: string | null;
  aiModelVersion?: string | null;
  promptVersion?: string | null;
  processingTimeMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  // AD-1 generation-stats headline fields.
  stopReason?: string | null;
  ttftMs?: number | null;
  tokensPerSecond?: number | null;
  caseNoteIds: string[];
  preSummaryIds: string[];
  previousSummaryIds: string[];
  generatedAt?: Date | null;
  cacheHit?: boolean | null;
  qualityScore?: number | null;
  promptResolvedFrom?: string | null;
  resolvedPromptId?: string | null;
  // Session-agent lineage frozen at recording start and carried
  // through the live loop into finalize. Null for non-live-session summaries.
  // `sessionAgentPromptVersion` is "<templateId>@<versionNumber>".
  sessionAgentId?: string | null;
  sessionAgentPromptVersion?: string | null;
  // Clinical-harness sensor scores + citation provenance
  entityFaithfulnessScore?: number | null;
  coverageScore?: number | null;
  ragTriadScore?: number | null;
  citationsMap?: JsonValue | null;
  guardrailDecisions?: JsonValue | null;
  // Vault-Transit (hope-phi) ciphertext of the JSONB
  // provenance blobs (citationsMap / guardrailDecisions) + shared key version.
  // Phase 6 dropped the plaintext columns; plaintext survives only as transient
  // fields repopulated by decrypt-on-read.
  encryptedCitationsMap?: Buffer | null;
  encryptedGuardrailDecisions?: Buffer | null;
  keyVersion?: number | null;
  attestationRef?: string | null;
  modelName?: string | null;
  // Two-phase (optimistic) assurance state
  gateDecision?: string | null;
  assuranceCompletedAt?: Date | null;
  // DNA redaction/rewrite audit. `redactionApplied` is a plaintext,
  // queryable marker; `redactionManifest` is the transient plaintext audit blob
  // (rule ids / actions / spans / counts — NEVER removed PHI plaintext),
  // encrypt-on-write into `encryptedRedactionManifest` (the persisted ciphertext).
  redactionApplied?: boolean | null;
  redactionManifest?: JsonValue | null;
  encryptedRedactionManifest?: Buffer | null;
  ContextItem?: Entities.ContextItemEntity | null;
}

export class SummaryMetaEntity extends BaseTenantEntity {
  private _contextItemId: ISummaryMetaEntity['contextItemId'];
  private _aiModelId?: ISummaryMetaEntity['aiModelId'];
  private _aiModelVersion?: ISummaryMetaEntity['aiModelVersion'];
  private _promptVersion?: ISummaryMetaEntity['promptVersion'];
  private _processingTimeMs?: ISummaryMetaEntity['processingTimeMs'];
  private _inputTokens?: ISummaryMetaEntity['inputTokens'];
  private _outputTokens?: ISummaryMetaEntity['outputTokens'];
  private _stopReason?: ISummaryMetaEntity['stopReason'];
  private _ttftMs?: ISummaryMetaEntity['ttftMs'];
  private _tokensPerSecond?: ISummaryMetaEntity['tokensPerSecond'];
  private _caseNoteIds: ISummaryMetaEntity['caseNoteIds'];
  private _preSummaryIds: ISummaryMetaEntity['preSummaryIds'];
  private _previousSummaryIds: ISummaryMetaEntity['previousSummaryIds'];
  private _generatedAt?: ISummaryMetaEntity['generatedAt'];
  private _cacheHit?: ISummaryMetaEntity['cacheHit'];
  private _qualityScore?: ISummaryMetaEntity['qualityScore'];
  private _promptResolvedFrom?: ISummaryMetaEntity['promptResolvedFrom'];
  private _resolvedPromptId?: ISummaryMetaEntity['resolvedPromptId'];
  private _sessionAgentId?: ISummaryMetaEntity['sessionAgentId'];
  private _sessionAgentPromptVersion?: ISummaryMetaEntity['sessionAgentPromptVersion'];
  private _entityFaithfulnessScore?: ISummaryMetaEntity['entityFaithfulnessScore'];
  private _coverageScore?: ISummaryMetaEntity['coverageScore'];
  private _ragTriadScore?: ISummaryMetaEntity['ragTriadScore'];
  private _citationsMap?: ISummaryMetaEntity['citationsMap'];
  private _guardrailDecisions?: ISummaryMetaEntity['guardrailDecisions'];
  private _encryptedCitationsMap?: ISummaryMetaEntity['encryptedCitationsMap'];
  private _encryptedGuardrailDecisions?: ISummaryMetaEntity['encryptedGuardrailDecisions'];
  private _keyVersion?: ISummaryMetaEntity['keyVersion'];
  private _attestationRef?: ISummaryMetaEntity['attestationRef'];
  private _modelName?: ISummaryMetaEntity['modelName'];
  private _gateDecision?: ISummaryMetaEntity['gateDecision'];
  private _assuranceCompletedAt?: ISummaryMetaEntity['assuranceCompletedAt'];
  private _redactionApplied?: ISummaryMetaEntity['redactionApplied'];
  private _redactionManifest?: ISummaryMetaEntity['redactionManifest'];
  private _encryptedRedactionManifest?: ISummaryMetaEntity['encryptedRedactionManifest'];
  private _ContextItem?: ISummaryMetaEntity['ContextItem'];

  constructor(init: ISummaryMetaEntity) {
    super(init);
    this._contextItemId = init.contextItemId;
    this._aiModelId = init.aiModelId;
    this._aiModelVersion = init.aiModelVersion;
    this._promptVersion = init.promptVersion;
    this._processingTimeMs = init.processingTimeMs;
    this._inputTokens = init.inputTokens;
    this._outputTokens = init.outputTokens;
    this._stopReason = init.stopReason;
    this._ttftMs = init.ttftMs;
    this._tokensPerSecond = init.tokensPerSecond;
    this._caseNoteIds = init.caseNoteIds ?? [];
    this._preSummaryIds = init.preSummaryIds ?? [];
    this._previousSummaryIds = init.previousSummaryIds ?? [];
    this._generatedAt = init.generatedAt;
    this._cacheHit = init.cacheHit;
    this._qualityScore = init.qualityScore;
    this._promptResolvedFrom = init.promptResolvedFrom;
    this._resolvedPromptId = init.resolvedPromptId;
    this._sessionAgentId = init.sessionAgentId ?? null;
    this._sessionAgentPromptVersion = init.sessionAgentPromptVersion ?? null;
    this._entityFaithfulnessScore = init.entityFaithfulnessScore;
    this._coverageScore = init.coverageScore;
    this._ragTriadScore = init.ragTriadScore;
    this._citationsMap = init.citationsMap;
    this._guardrailDecisions = init.guardrailDecisions;
    this._encryptedCitationsMap = init.encryptedCitationsMap;
    this._encryptedGuardrailDecisions = init.encryptedGuardrailDecisions;
    this._keyVersion = init.keyVersion;
    this._attestationRef = init.attestationRef;
    this._modelName = init.modelName;
    this._gateDecision = init.gateDecision;
    this._assuranceCompletedAt = init.assuranceCompletedAt;
    this._redactionApplied = init.redactionApplied;
    this._redactionManifest = init.redactionManifest;
    this._encryptedRedactionManifest = init.encryptedRedactionManifest;
    this._ContextItem = init.ContextItem;
  }

  get contextItemId(): ISummaryMetaEntity['contextItemId'] {
    return this._contextItemId;
  }

  set contextItemId(value: ISummaryMetaEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  get aiModelId(): ISummaryMetaEntity['aiModelId'] {
    return this._aiModelId;
  }

  set aiModelId(value: ISummaryMetaEntity['aiModelId']) {
    this.setProperty('aiModelId', value);
  }

  get aiModelVersion(): ISummaryMetaEntity['aiModelVersion'] {
    return this._aiModelVersion;
  }

  set aiModelVersion(value: ISummaryMetaEntity['aiModelVersion']) {
    this.setProperty('aiModelVersion', value);
  }

  get promptVersion(): ISummaryMetaEntity['promptVersion'] {
    return this._promptVersion;
  }

  set promptVersion(value: ISummaryMetaEntity['promptVersion']) {
    this.setProperty('promptVersion', value);
  }

  get processingTimeMs(): ISummaryMetaEntity['processingTimeMs'] {
    return this._processingTimeMs;
  }

  set processingTimeMs(value: ISummaryMetaEntity['processingTimeMs']) {
    this.setProperty('processingTimeMs', value);
  }

  get inputTokens(): ISummaryMetaEntity['inputTokens'] {
    return this._inputTokens;
  }

  set inputTokens(value: ISummaryMetaEntity['inputTokens']) {
    this.setProperty('inputTokens', value);
  }

  get outputTokens(): ISummaryMetaEntity['outputTokens'] {
    return this._outputTokens;
  }

  set outputTokens(value: ISummaryMetaEntity['outputTokens']) {
    this.setProperty('outputTokens', value);
  }

  // AD-1 generation-stats headline fields (normalized stop
  // reason, time-to-first-token, decode throughput). Additive/nullable.
  get stopReason(): ISummaryMetaEntity['stopReason'] {
    return this._stopReason;
  }

  set stopReason(value: ISummaryMetaEntity['stopReason']) {
    this.setProperty('stopReason', value);
  }

  get ttftMs(): ISummaryMetaEntity['ttftMs'] {
    return this._ttftMs;
  }

  set ttftMs(value: ISummaryMetaEntity['ttftMs']) {
    this.setProperty('ttftMs', value);
  }

  get tokensPerSecond(): ISummaryMetaEntity['tokensPerSecond'] {
    return this._tokensPerSecond;
  }

  set tokensPerSecond(value: ISummaryMetaEntity['tokensPerSecond']) {
    this.setProperty('tokensPerSecond', value);
  }

  get caseNoteIds(): ISummaryMetaEntity['caseNoteIds'] {
    return this._caseNoteIds;
  }

  set caseNoteIds(value: ISummaryMetaEntity['caseNoteIds']) {
    this.setProperty('caseNoteIds', value);
  }

  get preSummaryIds(): ISummaryMetaEntity['preSummaryIds'] {
    return this._preSummaryIds;
  }

  set preSummaryIds(value: ISummaryMetaEntity['preSummaryIds']) {
    this.setProperty('preSummaryIds', value);
  }

  get previousSummaryIds(): ISummaryMetaEntity['previousSummaryIds'] {
    return this._previousSummaryIds;
  }

  set previousSummaryIds(value: ISummaryMetaEntity['previousSummaryIds']) {
    this.setProperty('previousSummaryIds', value);
  }

  get generatedAt(): ISummaryMetaEntity['generatedAt'] {
    return this._generatedAt;
  }

  set generatedAt(value: ISummaryMetaEntity['generatedAt']) {
    this.setProperty('generatedAt', value);
  }

  get cacheHit(): ISummaryMetaEntity['cacheHit'] {
    return this._cacheHit;
  }

  set cacheHit(value: ISummaryMetaEntity['cacheHit']) {
    this.setProperty('cacheHit', value);
  }

  get qualityScore(): ISummaryMetaEntity['qualityScore'] {
    return this._qualityScore;
  }

  set qualityScore(value: ISummaryMetaEntity['qualityScore']) {
    this.setProperty('qualityScore', value);
  }

  get promptResolvedFrom(): ISummaryMetaEntity['promptResolvedFrom'] {
    return this._promptResolvedFrom;
  }

  set promptResolvedFrom(value: ISummaryMetaEntity['promptResolvedFrom']) {
    this.setProperty('promptResolvedFrom', value);
  }

  get resolvedPromptId(): ISummaryMetaEntity['resolvedPromptId'] {
    return this._resolvedPromptId;
  }

  set resolvedPromptId(value: ISummaryMetaEntity['resolvedPromptId']) {
    this.setProperty('resolvedPromptId', value);
  }

  get sessionAgentId(): ISummaryMetaEntity['sessionAgentId'] {
    return this._sessionAgentId;
  }

  set sessionAgentId(value: ISummaryMetaEntity['sessionAgentId']) {
    this.setProperty('sessionAgentId', value);
  }

  get sessionAgentPromptVersion(): ISummaryMetaEntity['sessionAgentPromptVersion'] {
    return this._sessionAgentPromptVersion;
  }

  set sessionAgentPromptVersion(value: ISummaryMetaEntity['sessionAgentPromptVersion']) {
    this.setProperty('sessionAgentPromptVersion', value);
  }

  get entityFaithfulnessScore(): ISummaryMetaEntity['entityFaithfulnessScore'] {
    return this._entityFaithfulnessScore;
  }

  set entityFaithfulnessScore(value: ISummaryMetaEntity['entityFaithfulnessScore']) {
    this.setProperty('entityFaithfulnessScore', value);
  }

  get coverageScore(): ISummaryMetaEntity['coverageScore'] {
    return this._coverageScore;
  }

  set coverageScore(value: ISummaryMetaEntity['coverageScore']) {
    this.setProperty('coverageScore', value);
  }

  get ragTriadScore(): ISummaryMetaEntity['ragTriadScore'] {
    return this._ragTriadScore;
  }

  set ragTriadScore(value: ISummaryMetaEntity['ragTriadScore']) {
    this.setProperty('ragTriadScore', value);
  }

  // Citation provenance + guardrail decisions can echo
  // clinical content. @Secret() marks them for audit-log redaction.
  @Secret()
  get citationsMap(): ISummaryMetaEntity['citationsMap'] {
    return this._citationsMap;
  }

  set citationsMap(value: ISummaryMetaEntity['citationsMap']) {
    this.setProperty('citationsMap', value);
  }

  @Secret()
  get guardrailDecisions(): ISummaryMetaEntity['guardrailDecisions'] {
    return this._guardrailDecisions;
  }

  set guardrailDecisions(value: ISummaryMetaEntity['guardrailDecisions']) {
    this.setProperty('guardrailDecisions', value);
  }

  // Vault-Transit ciphertext columns. @Secret() guards the
  // ciphertext from audit-log surfaces.
  @Secret()
  get encryptedCitationsMap(): ISummaryMetaEntity['encryptedCitationsMap'] {
    return this._encryptedCitationsMap;
  }

  set encryptedCitationsMap(value: ISummaryMetaEntity['encryptedCitationsMap']) {
    this.setProperty('encryptedCitationsMap', value);
  }

  @Secret()
  get encryptedGuardrailDecisions(): ISummaryMetaEntity['encryptedGuardrailDecisions'] {
    return this._encryptedGuardrailDecisions;
  }

  set encryptedGuardrailDecisions(value: ISummaryMetaEntity['encryptedGuardrailDecisions']) {
    this.setProperty('encryptedGuardrailDecisions', value);
  }

  get keyVersion(): ISummaryMetaEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: ISummaryMetaEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get attestationRef(): ISummaryMetaEntity['attestationRef'] {
    return this._attestationRef;
  }

  set attestationRef(value: ISummaryMetaEntity['attestationRef']) {
    this.setProperty('attestationRef', value);
  }

  get modelName(): ISummaryMetaEntity['modelName'] {
    return this._modelName;
  }

  set modelName(value: ISummaryMetaEntity['modelName']) {
    this.setProperty('modelName', value);
  }

  get gateDecision(): ISummaryMetaEntity['gateDecision'] {
    return this._gateDecision;
  }

  set gateDecision(value: ISummaryMetaEntity['gateDecision']) {
    this.setProperty('gateDecision', value);
  }

  get assuranceCompletedAt(): ISummaryMetaEntity['assuranceCompletedAt'] {
    return this._assuranceCompletedAt;
  }

  set assuranceCompletedAt(value: ISummaryMetaEntity['assuranceCompletedAt']) {
    this.setProperty('assuranceCompletedAt', value);
  }

  get redactionApplied(): ISummaryMetaEntity['redactionApplied'] {
    return this._redactionApplied;
  }

  set redactionApplied(value: ISummaryMetaEntity['redactionApplied']) {
    this.setProperty('redactionApplied', value);
  }

  // The redaction audit manifest can echo rule ids / span coordinates.
  // @Secret() marks the transient plaintext + ciphertext for audit-log redaction.
  @Secret()
  get redactionManifest(): ISummaryMetaEntity['redactionManifest'] {
    return this._redactionManifest;
  }

  set redactionManifest(value: ISummaryMetaEntity['redactionManifest']) {
    this.setProperty('redactionManifest', value);
  }

  @Secret()
  get encryptedRedactionManifest(): ISummaryMetaEntity['encryptedRedactionManifest'] {
    return this._encryptedRedactionManifest;
  }

  set encryptedRedactionManifest(value: ISummaryMetaEntity['encryptedRedactionManifest']) {
    this.setProperty('encryptedRedactionManifest', value);
  }

  get ContextItem(): ISummaryMetaEntity['ContextItem'] {
    return this._ContextItem;
  }

  set ContextItem(value: ISummaryMetaEntity['ContextItem']) {
    this.setProperty('ContextItem', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Get total tokens used
   */
  get totalTokens(): number {
    return (this._inputTokens ?? 0) + (this._outputTokens ?? 0);
  }

  /**
   * Get processing time in seconds
   */
  get processingTimeSeconds(): number | null {
    return this._processingTimeMs ? this._processingTimeMs / 1000 : null;
  }

  /**
   * Check if this summary used case notes as context
   */
  get hasCaseNoteContext(): boolean {
    return this._caseNoteIds.length > 0;
  }

  /**
   * Check if this summary used pre-summaries as context
   */
  get hasPreSummaryContext(): boolean {
    return this._preSummaryIds.length > 0;
  }

  /**
   * Check if this summary used previous consultation summaries as context
   */
  get hasPreviousSummaryContext(): boolean {
    return this._previousSummaryIds.length > 0;
  }

  /**
   * Check if any context was used for generation
   */
  get hasAnyContext(): boolean {
    return this.hasCaseNoteContext || this.hasPreSummaryContext || this.hasPreviousSummaryContext;
  }

  public override validate(): void {
    super.validate();
    if (!this._contextItemId) {
      throw new BusinessException('Context item ID is required');
    }
  }
}
