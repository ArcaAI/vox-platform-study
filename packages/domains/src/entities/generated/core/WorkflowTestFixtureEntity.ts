/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// Per-tenant saved synthetic Workbench test input (TASK-721). `input` is a
// PLAIN, unencrypted JsonB payload — "synthetic" is a contract enforced by
// application/UI copy, not by this entity. See
// packages/database/src/prisma/db_main/workflow-test-fixture.prisma for the
// full PHI-posture note (README §6/R4, HUMAN-GATED — not resolved here).
export interface IWorkflowTestFixtureEntity extends IBaseTenantEntity {
  name: string;
  description?: string | null;
  paletteId?: string | null;
  workflowDefinitionId?: string | null;
  input: Record<string, unknown>;
}

export class WorkflowTestFixtureEntity extends BaseTenantEntity {
  private _name: IWorkflowTestFixtureEntity['name'];
  private _description?: IWorkflowTestFixtureEntity['description'];
  private _paletteId?: IWorkflowTestFixtureEntity['paletteId'];
  private _workflowDefinitionId?: IWorkflowTestFixtureEntity['workflowDefinitionId'];
  private _input: IWorkflowTestFixtureEntity['input'];

  constructor(init: IWorkflowTestFixtureEntity) {
    super(init);
    this._name = init.name;
    this._description = init.description;
    this._paletteId = init.paletteId;
    this._workflowDefinitionId = init.workflowDefinitionId;
    this._input = init.input;
  }

  get name(): IWorkflowTestFixtureEntity['name'] {
    return this._name;
  }

  set name(value: IWorkflowTestFixtureEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IWorkflowTestFixtureEntity['description'] {
    return this._description;
  }

  set description(value: IWorkflowTestFixtureEntity['description']) {
    this.setProperty('description', value);
  }

  get paletteId(): IWorkflowTestFixtureEntity['paletteId'] {
    return this._paletteId;
  }

  set paletteId(value: IWorkflowTestFixtureEntity['paletteId']) {
    this.setProperty('paletteId', value);
  }

  get workflowDefinitionId(): IWorkflowTestFixtureEntity['workflowDefinitionId'] {
    return this._workflowDefinitionId;
  }

  set workflowDefinitionId(value: IWorkflowTestFixtureEntity['workflowDefinitionId']) {
    this.setProperty('workflowDefinitionId', value);
  }

  get input(): IWorkflowTestFixtureEntity['input'] {
    return this._input;
  }

  set input(value: IWorkflowTestFixtureEntity['input']) {
    this.setProperty('input', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Fixture name is required');
    }
    if (this._input === undefined || this._input === null) {
      throw new BusinessException('Fixture input is required');
    }
  }
}
