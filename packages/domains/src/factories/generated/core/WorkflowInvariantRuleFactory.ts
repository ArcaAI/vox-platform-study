/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { WorkflowInvariantRuleEntity, IWorkflowInvariantRuleEntity } from '../../../entities';
import { WorkflowRuleSeverity } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateWorkflowInvariantRuleProps extends BaseEntityFactoryCreateProps {
  tenantId: IWorkflowInvariantRuleEntity['tenantId'];
  ruleId: IWorkflowInvariantRuleEntity['ruleId'];
  registerRefs?: IWorkflowInvariantRuleEntity['registerRefs'];
  title: IWorkflowInvariantRuleEntity['title'];
  rationale?: IWorkflowInvariantRuleEntity['rationale'];
  predicateType: IWorkflowInvariantRuleEntity['predicateType'];
  predicateConfig: IWorkflowInvariantRuleEntity['predicateConfig'];
  paletteKey?: IWorkflowInvariantRuleEntity['paletteKey'];
  severity?: IWorkflowInvariantRuleEntity['severity'];
  ruleVersion?: IWorkflowInvariantRuleEntity['ruleVersion'];
  effectiveFrom?: IWorkflowInvariantRuleEntity['effectiveFrom'];

  createdAt?: IWorkflowInvariantRuleEntity['createdAt'];
  updatedAt?: IWorkflowInvariantRuleEntity['updatedAt'];
  createdBy?: IWorkflowInvariantRuleEntity['createdBy'];
  updatedBy?: IWorkflowInvariantRuleEntity['updatedBy'];
}

export class WorkflowInvariantRuleFactory {
  static CreateWorkflowInvariantRule(props: CreateWorkflowInvariantRuleProps): WorkflowInvariantRuleEntity {
    const id = generateId();
    const now = new Date();

    return new WorkflowInvariantRuleEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      ruleId: props.ruleId,
      registerRefs: props.registerRefs ?? [],
      title: props.title,
      rationale: props.rationale ?? null,
      predicateType: props.predicateType,
      predicateConfig: props.predicateConfig,
      paletteKey: props.paletteKey ?? null,
      // Mirrors the column default. ERROR is the safe default: a rule that
      // silently defaulted to WARNING would be authored as a gate and behave as
      // advice.
      severity: props.severity ?? WorkflowRuleSeverity.ERROR,
      ruleVersion: props.ruleVersion ?? 1,
      effectiveFrom: props.effectiveFrom ?? now,
    });
  }
}
