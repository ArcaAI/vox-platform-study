/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { WorkflowRulePredicateType, WorkflowRuleSeverity } from '../../../enums';

// One PARAMETERIZATION of a code-owned predicate kind — the DATA half of the
// validator's "code-owned predicate types, data-owned rule instances" split

// packages/database/src/prisma/db_main/workflow-invariant-rule.prisma for the
// ownership rules (SYSTEM rows are the platform register; a tenant row may only
// ADD strictness, never loosen or disable a SYSTEM row — enforced in the
// service, not here).
//
// `predicateConfig` is deliberately `unknown`-shaped (JsonB): its schema is
// owned per predicate kind by `predicateConfigProblems()` in
// `packages/workflow-contract/src/predicates/`, and is checked at EVALUATION
// time (a malformed config resolves to a synthetic `WF-INTERNAL` ERROR
// finding, never to `ok: true`). Duplicating that dispatch here would be the
// second implementation the contract package exists to prevent.
export interface IWorkflowInvariantRuleEntity extends IBaseTenantEntity {
  ruleId: string;
  registerRefs: string[];
  title: string;
  rationale?: string | null;
  predicateType: WorkflowRulePredicateType;
  predicateConfig: unknown;
  /** null => applies to every palette (the palette-agnostic structural rules). */
  paletteKey?: string | null;
  severity: WorkflowRuleSeverity;
  ruleVersion: number;
  effectiveFrom: Date;
}

/** Mirrors `WORKFLOW_NODE_ID_PATTERN`'s sibling convention for platform rule ids
 *  (`WF-S-001`, `WF-I-006`, `WF-C-004`, and the palette sets' `WF-CONS-012`). */
const WORKFLOW_RULE_ID_PATTERN = /^[A-Z0-9-]{3,48}$/;

export class WorkflowInvariantRuleEntity extends BaseTenantEntity {
  private _ruleId: IWorkflowInvariantRuleEntity['ruleId'];
  private _registerRefs: IWorkflowInvariantRuleEntity['registerRefs'];
  private _title: IWorkflowInvariantRuleEntity['title'];
  private _rationale?: IWorkflowInvariantRuleEntity['rationale'];
  private _predicateType: IWorkflowInvariantRuleEntity['predicateType'];
  private _predicateConfig: IWorkflowInvariantRuleEntity['predicateConfig'];
  private _paletteKey?: IWorkflowInvariantRuleEntity['paletteKey'];
  private _severity: IWorkflowInvariantRuleEntity['severity'];
  private _ruleVersion: IWorkflowInvariantRuleEntity['ruleVersion'];
  private _effectiveFrom: IWorkflowInvariantRuleEntity['effectiveFrom'];

  constructor(init: IWorkflowInvariantRuleEntity) {
    super(init);
    this._ruleId = init.ruleId;
    this._registerRefs = init.registerRefs;
    this._title = init.title;
    this._rationale = init.rationale;
    this._predicateType = init.predicateType;
    this._predicateConfig = init.predicateConfig;
    this._paletteKey = init.paletteKey;
    this._severity = init.severity;
    this._ruleVersion = init.ruleVersion;
    this._effectiveFrom = init.effectiveFrom;
  }

  get ruleId(): IWorkflowInvariantRuleEntity['ruleId'] {
    return this._ruleId;
  }

  set ruleId(value: IWorkflowInvariantRuleEntity['ruleId']) {
    this.setProperty('ruleId', value);
  }

  get registerRefs(): IWorkflowInvariantRuleEntity['registerRefs'] {
    return this._registerRefs;
  }

  set registerRefs(value: IWorkflowInvariantRuleEntity['registerRefs']) {
    this.setProperty('registerRefs', value);
  }

  get title(): IWorkflowInvariantRuleEntity['title'] {
    return this._title;
  }

  set title(value: IWorkflowInvariantRuleEntity['title']) {
    this.setProperty('title', value);
  }

  get rationale(): IWorkflowInvariantRuleEntity['rationale'] {
    return this._rationale;
  }

  set rationale(value: IWorkflowInvariantRuleEntity['rationale']) {
    this.setProperty('rationale', value);
  }

  get predicateType(): IWorkflowInvariantRuleEntity['predicateType'] {
    return this._predicateType;
  }

  set predicateType(value: IWorkflowInvariantRuleEntity['predicateType']) {
    this.setProperty('predicateType', value);
  }

  get predicateConfig(): IWorkflowInvariantRuleEntity['predicateConfig'] {
    return this._predicateConfig;
  }

  set predicateConfig(value: IWorkflowInvariantRuleEntity['predicateConfig']) {
    this.setProperty('predicateConfig', value);
  }

  get paletteKey(): IWorkflowInvariantRuleEntity['paletteKey'] {
    return this._paletteKey;
  }

  set paletteKey(value: IWorkflowInvariantRuleEntity['paletteKey']) {
    this.setProperty('paletteKey', value);
  }

  get severity(): IWorkflowInvariantRuleEntity['severity'] {
    return this._severity;
  }

  set severity(value: IWorkflowInvariantRuleEntity['severity']) {
    this.setProperty('severity', value);
  }

  get ruleVersion(): IWorkflowInvariantRuleEntity['ruleVersion'] {
    return this._ruleVersion;
  }

  set ruleVersion(value: IWorkflowInvariantRuleEntity['ruleVersion']) {
    this.setProperty('ruleVersion', value);
  }

  get effectiveFrom(): IWorkflowInvariantRuleEntity['effectiveFrom'] {
    return this._effectiveFrom;
  }

  set effectiveFrom(value: IWorkflowInvariantRuleEntity['effectiveFrom']) {
    this.setProperty('effectiveFrom', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._ruleId || !WORKFLOW_RULE_ID_PATTERN.test(this._ruleId)) {
      throw new BusinessException('Rule id must match /^[A-Z0-9-]{3,48}$/');
    }
    if (!this._title || this._title.trim().length === 0) {
      throw new BusinessException('Rule title is required');
    }
    if (this._predicateConfig === undefined || this._predicateConfig === null) {
      throw new BusinessException('Rule predicateConfig is required');
    }
    // The re-validation sweep keys off `ruleVersion`; a non-positive value would
    // make "has this rule changed since the definition was validated?"
    // unanswerable.
    if (!Number.isInteger(this._ruleVersion) || this._ruleVersion < 1) {
      throw new BusinessException('Rule ruleVersion must be a positive integer');
    }
  }
}
