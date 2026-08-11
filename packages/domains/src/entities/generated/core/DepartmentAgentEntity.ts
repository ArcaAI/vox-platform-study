/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { DepartmentAgentDnaPolicy, DepartmentAgentRole } from '../../../enums';

// First-class agent entity (TASK-546): binds a tenant department to a
// PromptTemplate at a PINNED or TRACKED version, plus a DNA-style gate, (later)
// harness overrides and a golden set. Only STRUCTURAL invariants live here;
// binding-visibility, pin-approval and harness-override key validation are
// cross-aggregate rules and belong in the application service
// (`DepartmentAgentService`).
export interface IDepartmentAgentEntity extends IBaseTaggedEntity {
  departmentId: string;
  name: string;
  slug: string;
  description?: string | null;
  promptTemplateId: string;
  // null ⇒ track latest APPROVED version (movable-pointer pattern).
  pinnedVersionNumber?: number | null;
  dnaStylePolicy?: DepartmentAgentDnaPolicy;
  harnessOverrides?: Record<string, unknown> | null;
  goldenSetId?: string | null;
  // TASK-635 RF-4 — capability-keyed bindings. All optional/nullable; null ⇒
  // the legacy behavior for that capability (summary falls back to
  // `promptTemplateId`; pre-summary and live fall through to the tenant/SYSTEM
  // tiers). Loose template-id refs — visibility/approval are cross-aggregate
  // rules enforced in `DepartmentAgentService` and `PromptResolutionService`,
  // never here (only STRUCTURAL invariants live in the entity).
  newPatientTemplateId?: string | null;
  revisitTemplateId?: string | null;
  preSummaryTemplateId?: string | null;
  livePromptTemplateId?: string | null;
  /** Live-loop tool plan; null ⇒ platform default. Shape validated in the service. */
  toolConfig?: Record<string, unknown> | null;
  /** Per-task LLM override `{ live?, finalize? }`; null ⇒ tenant AiTaskDefault. */
  llmOverrides?: Record<string, unknown> | null;
  // Optional on the interface so the factory (create path) can omit it
  // (DB default = false); the tenant default is flipped only via the
  // repository transaction (`setDefaultForDepartment`).
  isDefault?: boolean;
  // Template lineage (consumed by TASK-548). Optional for the same reason as
  // `isDefault` — DB defaults cover creates.
  sourceAgentTemplateSlug?: string | null;
  templateLocked?: boolean;
  // TASK-659 — loop configuration + promotion surface. All optional; every
  // pre-existing agent is null on all but `role` (which carries a DB
  // default), so nothing here changes resolution behavior.
  role?: DepartmentAgentRole;
  subscribedKinds?: Record<string, unknown> | null;
  writeScope?: Record<string, unknown> | null;
  goal?: Record<string, unknown> | null;
  guardrailProfile?: string | null;
  alwaysActions?: string[] | null;
  neverActions?: string[] | null;
  // `IBaseEntity.metaData` is declared but not wired on the abstract base —
  // wired locally (the AiModelEntity precedent) so template-copy lineage extras
  // (TASK-548: `sourceTemplateVersionNumber`, the pristine-detection anchor for
  // the resync sweep) survive the entity ⇄ model round-trip.
  metaData?: Record<string, unknown> | null;
}

export class DepartmentAgentEntity extends BaseTaggedEntity {
  private _departmentId: IDepartmentAgentEntity['departmentId'];
  private _name: IDepartmentAgentEntity['name'];
  private _slug: IDepartmentAgentEntity['slug'];
  private _description?: IDepartmentAgentEntity['description'];
  private _promptTemplateId: IDepartmentAgentEntity['promptTemplateId'];
  private _pinnedVersionNumber?: IDepartmentAgentEntity['pinnedVersionNumber'];
  private _dnaStylePolicy: DepartmentAgentDnaPolicy;
  private _harnessOverrides?: IDepartmentAgentEntity['harnessOverrides'];
  private _goldenSetId?: IDepartmentAgentEntity['goldenSetId'];
  private _newPatientTemplateId?: IDepartmentAgentEntity['newPatientTemplateId'];
  private _revisitTemplateId?: IDepartmentAgentEntity['revisitTemplateId'];
  private _preSummaryTemplateId?: IDepartmentAgentEntity['preSummaryTemplateId'];
  private _livePromptTemplateId?: IDepartmentAgentEntity['livePromptTemplateId'];
  private _toolConfig?: IDepartmentAgentEntity['toolConfig'];
  private _llmOverrides?: IDepartmentAgentEntity['llmOverrides'];
  private _isDefault: boolean;
  private _sourceAgentTemplateSlug?: IDepartmentAgentEntity['sourceAgentTemplateSlug'];
  private _templateLocked: boolean;
  private _role: DepartmentAgentRole;
  private _subscribedKinds?: IDepartmentAgentEntity['subscribedKinds'];
  private _writeScope?: IDepartmentAgentEntity['writeScope'];
  private _goal?: IDepartmentAgentEntity['goal'];
  private _guardrailProfile?: IDepartmentAgentEntity['guardrailProfile'];
  private _alwaysActions?: IDepartmentAgentEntity['alwaysActions'];
  private _neverActions?: IDepartmentAgentEntity['neverActions'];
  private _metaData?: IDepartmentAgentEntity['metaData'];

  constructor(init: IDepartmentAgentEntity) {
    super(init);
    this._departmentId = init.departmentId;
    this._name = init.name;
    this._slug = init.slug;
    this._description = init.description;
    this._promptTemplateId = init.promptTemplateId;
    this._pinnedVersionNumber = init.pinnedVersionNumber ?? null;
    this._dnaStylePolicy = init.dnaStylePolicy ?? DepartmentAgentDnaPolicy.INHERIT;
    this._harnessOverrides = init.harnessOverrides ?? null;
    this._goldenSetId = init.goldenSetId ?? null;
    this._newPatientTemplateId = init.newPatientTemplateId ?? null;
    this._revisitTemplateId = init.revisitTemplateId ?? null;
    this._preSummaryTemplateId = init.preSummaryTemplateId ?? null;
    this._livePromptTemplateId = init.livePromptTemplateId ?? null;
    this._toolConfig = init.toolConfig ?? null;
    this._llmOverrides = init.llmOverrides ?? null;
    this._isDefault = init.isDefault ?? false;
    this._sourceAgentTemplateSlug = init.sourceAgentTemplateSlug ?? null;
    this._templateLocked = init.templateLocked ?? false;
    this._role = init.role ?? DepartmentAgentRole.SPECIALIST;
    this._subscribedKinds = init.subscribedKinds ?? null;
    this._writeScope = init.writeScope ?? null;
    this._goal = init.goal ?? null;
    this._guardrailProfile = init.guardrailProfile ?? null;
    this._alwaysActions = init.alwaysActions ?? null;
    this._neverActions = init.neverActions ?? null;
    this._metaData = init.metaData ?? null;
  }

  get departmentId(): IDepartmentAgentEntity['departmentId'] {
    return this._departmentId;
  }

  set departmentId(value: IDepartmentAgentEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

  get name(): IDepartmentAgentEntity['name'] {
    return this._name;
  }

  set name(value: IDepartmentAgentEntity['name']) {
    this.setProperty('name', value);
  }

  get slug(): IDepartmentAgentEntity['slug'] {
    return this._slug;
  }

  set slug(value: IDepartmentAgentEntity['slug']) {
    this.setProperty('slug', value);
  }

  get description(): IDepartmentAgentEntity['description'] {
    return this._description;
  }

  set description(value: IDepartmentAgentEntity['description']) {
    this.setProperty('description', value);
  }

  get promptTemplateId(): IDepartmentAgentEntity['promptTemplateId'] {
    return this._promptTemplateId;
  }

  set promptTemplateId(value: IDepartmentAgentEntity['promptTemplateId']) {
    this.setProperty('promptTemplateId', value);
  }

  get pinnedVersionNumber(): IDepartmentAgentEntity['pinnedVersionNumber'] {
    return this._pinnedVersionNumber;
  }

  set pinnedVersionNumber(value: IDepartmentAgentEntity['pinnedVersionNumber']) {
    this.setProperty('pinnedVersionNumber', value);
  }

  get dnaStylePolicy(): DepartmentAgentDnaPolicy {
    return this._dnaStylePolicy;
  }

  set dnaStylePolicy(value: DepartmentAgentDnaPolicy) {
    this.setProperty('dnaStylePolicy', value);
  }

  get harnessOverrides(): IDepartmentAgentEntity['harnessOverrides'] {
    return this._harnessOverrides;
  }

  set harnessOverrides(value: IDepartmentAgentEntity['harnessOverrides']) {
    this.setProperty('harnessOverrides', value);
  }

  get goldenSetId(): IDepartmentAgentEntity['goldenSetId'] {
    return this._goldenSetId;
  }

  set goldenSetId(value: IDepartmentAgentEntity['goldenSetId']) {
    this.setProperty('goldenSetId', value);
  }

  get newPatientTemplateId(): IDepartmentAgentEntity['newPatientTemplateId'] {
    return this._newPatientTemplateId;
  }

  set newPatientTemplateId(value: IDepartmentAgentEntity['newPatientTemplateId']) {
    this.setProperty('newPatientTemplateId', value);
  }

  get revisitTemplateId(): IDepartmentAgentEntity['revisitTemplateId'] {
    return this._revisitTemplateId;
  }

  set revisitTemplateId(value: IDepartmentAgentEntity['revisitTemplateId']) {
    this.setProperty('revisitTemplateId', value);
  }

  get preSummaryTemplateId(): IDepartmentAgentEntity['preSummaryTemplateId'] {
    return this._preSummaryTemplateId;
  }

  set preSummaryTemplateId(value: IDepartmentAgentEntity['preSummaryTemplateId']) {
    this.setProperty('preSummaryTemplateId', value);
  }

  get livePromptTemplateId(): IDepartmentAgentEntity['livePromptTemplateId'] {
    return this._livePromptTemplateId;
  }

  set livePromptTemplateId(value: IDepartmentAgentEntity['livePromptTemplateId']) {
    this.setProperty('livePromptTemplateId', value);
  }

  get toolConfig(): IDepartmentAgentEntity['toolConfig'] {
    return this._toolConfig;
  }

  set toolConfig(value: IDepartmentAgentEntity['toolConfig']) {
    this.setProperty('toolConfig', value);
  }

  get llmOverrides(): IDepartmentAgentEntity['llmOverrides'] {
    return this._llmOverrides;
  }

  set llmOverrides(value: IDepartmentAgentEntity['llmOverrides']) {
    this.setProperty('llmOverrides', value);
  }

  get isDefault(): boolean {
    return this._isDefault;
  }

  set isDefault(value: boolean) {
    this.setProperty('isDefault', value);
  }

  get sourceAgentTemplateSlug(): IDepartmentAgentEntity['sourceAgentTemplateSlug'] {
    return this._sourceAgentTemplateSlug;
  }

  set sourceAgentTemplateSlug(value: IDepartmentAgentEntity['sourceAgentTemplateSlug']) {
    this.setProperty('sourceAgentTemplateSlug', value);
  }

  get templateLocked(): boolean {
    return this._templateLocked;
  }

  set templateLocked(value: boolean) {
    this.setProperty('templateLocked', value);
  }

  get role(): DepartmentAgentRole {
    return this._role;
  }

  set role(value: DepartmentAgentRole) {
    this.setProperty('role', value);
  }

  get subscribedKinds(): IDepartmentAgentEntity['subscribedKinds'] {
    return this._subscribedKinds;
  }

  set subscribedKinds(value: IDepartmentAgentEntity['subscribedKinds']) {
    this.setProperty('subscribedKinds', value);
  }

  get writeScope(): IDepartmentAgentEntity['writeScope'] {
    return this._writeScope;
  }

  set writeScope(value: IDepartmentAgentEntity['writeScope']) {
    this.setProperty('writeScope', value);
  }

  get goal(): IDepartmentAgentEntity['goal'] {
    return this._goal;
  }

  set goal(value: IDepartmentAgentEntity['goal']) {
    this.setProperty('goal', value);
  }

  get guardrailProfile(): IDepartmentAgentEntity['guardrailProfile'] {
    return this._guardrailProfile;
  }

  set guardrailProfile(value: IDepartmentAgentEntity['guardrailProfile']) {
    this.setProperty('guardrailProfile', value);
  }

  get alwaysActions(): IDepartmentAgentEntity['alwaysActions'] {
    return this._alwaysActions;
  }

  set alwaysActions(value: IDepartmentAgentEntity['alwaysActions']) {
    this.setProperty('alwaysActions', value);
  }

  get neverActions(): IDepartmentAgentEntity['neverActions'] {
    return this._neverActions;
  }

  set neverActions(value: IDepartmentAgentEntity['neverActions']) {
    this.setProperty('neverActions', value);
  }

  get metaData(): IDepartmentAgentEntity['metaData'] {
    return this._metaData;
  }

  set metaData(value: IDepartmentAgentEntity['metaData']) {
    this.setProperty('metaData', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._departmentId || this._departmentId.trim().length === 0) {
      throw new BusinessException('Department agent requires a departmentId');
    }
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Department agent name is required');
    }
    if (!this._slug || this._slug.trim().length === 0) {
      throw new BusinessException('Department agent slug is required');
    }
    if (!this._promptTemplateId || this._promptTemplateId.trim().length === 0) {
      throw new BusinessException('Department agent requires a promptTemplateId');
    }
    // Slug format (lowercase, alphanumeric, hyphens only) — mirrors AsrPipeline.
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(this._slug)) {
      throw new BusinessException('Department agent slug must be lowercase alphanumeric with hyphens (e.g., "cardiology-soap")');
    }
    // A pinned version number, when set, must be a positive integer.
    if (this._pinnedVersionNumber !== null && this._pinnedVersionNumber !== undefined) {
      if (!Number.isInteger(this._pinnedVersionNumber) || this._pinnedVersionNumber < 1) {
        throw new BusinessException('Department agent pinnedVersionNumber must be a positive integer');
      }
    }
  }
}
