/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';

// Per-tenant saved synthetic Workbench test input (TASK-721). `input` is
// Vault-Transit encrypted exactly like `GoldenCase.transcript` (README §6/R4,
// RESOLVED): the plaintext column was DROPPED, so `input` survives only as a
// TRANSIENT in-memory field, repopulated from `encryptedInput` by repository
// decrypt-on-read (`common/phi-read-decrypt.ts`). See
// packages/database/src/prisma/db_main/workflow-test-fixture.prisma.
export interface IWorkflowTestFixtureEntity extends IBaseTenantEntity {
  name: string;
  description?: string | null;
  paletteId?: string | null;
  workflowDefinitionId?: string | null;
  input: Record<string, unknown>;
  // Vault-Transit (hope-phi) ciphertext of `input` + the shared key version.
  encryptedInput?: Buffer | null;
  keyVersion?: number | null;
}

export class WorkflowTestFixtureEntity extends BaseTenantEntity {
  private _name: IWorkflowTestFixtureEntity['name'];
  private _description?: IWorkflowTestFixtureEntity['description'];
  private _paletteId?: IWorkflowTestFixtureEntity['paletteId'];
  private _workflowDefinitionId?: IWorkflowTestFixtureEntity['workflowDefinitionId'];
  private _input: IWorkflowTestFixtureEntity['input'];
  private _encryptedInput?: IWorkflowTestFixtureEntity['encryptedInput'];
  private _keyVersion?: IWorkflowTestFixtureEntity['keyVersion'];

  constructor(init: IWorkflowTestFixtureEntity) {
    super(init);
    this._name = init.name;
    this._description = init.description;
    this._paletteId = init.paletteId;
    this._workflowDefinitionId = init.workflowDefinitionId;
    this._input = init.input;
    this._encryptedInput = init.encryptedInput;
    this._keyVersion = init.keyVersion;
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

  // Transient plaintext payload. @Secret() marks it for audit-log redaction
  // (defense-in-depth) alongside its encrypted counterpart — mirrors
  // `GoldenCaseEntity.transcript`.
  @Secret()
  get input(): IWorkflowTestFixtureEntity['input'] {
    return this._input;
  }

  set input(value: IWorkflowTestFixtureEntity['input']) {
    this.setProperty('input', value);
  }

  // Vault-Transit ciphertext column. @Secret() guards the ciphertext from
  // audit-log surfaces.
  @Secret()
  get encryptedInput(): IWorkflowTestFixtureEntity['encryptedInput'] {
    return this._encryptedInput;
  }

  set encryptedInput(value: IWorkflowTestFixtureEntity['encryptedInput']) {
    this.setProperty('encryptedInput', value);
  }

  get keyVersion(): IWorkflowTestFixtureEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IWorkflowTestFixtureEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
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
