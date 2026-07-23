/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class PromptTemplate extends BaseTenantDataModel {
  public name: string;
  public description: string | null;
  public content: string;
  public category: Enums.PromptTemplateCategory;
  public status: Enums.PromptTemplateStatus;
  public variables: JsonValue | null;
  public lastTestScore: number | null;
  public lastTestAt: Date | null;
  // Plaintext lastTestOutput column DROPPED; persistence is
  // ciphertext-only. The entity keeps `lastTestOutput` as a transient field
  // repopulated by repository decrypt-on-read. (`content` is the prompt body and
  // is NOT encrypted — it remains a plaintext column.)
  // Vault-Transit ciphertext column + key version.
  public encryptedLastTestOutput: Uint8Array | null;
  public keyVersion: number | null;
  public currentVersionNumber: number;
  public departmentId: string | null;
  public scope: Enums.PromptTemplateScope;
  public ownerUserId: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];
  @VirtualDbProperty()
  public Department: Models.Department | undefined;
  @VirtualDbProperty()
  public Owner: Models.User | undefined;
  @VirtualDbProperty()
  public Versions: Models.PromptVersion[] | undefined;
  @VirtualDbProperty()
  public DepartmentAgents: Models.DepartmentAgent[] | undefined;

  constructor(data: PromptTemplate & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.description = data.description;
    this.content = data.content;
    this.category = data.category;
    this.status = data.status;
    this.variables = data.variables;
    this.lastTestScore = data.lastTestScore;
    this.lastTestAt = data.lastTestAt;
    this.encryptedLastTestOutput = data.encryptedLastTestOutput;
    this.keyVersion = data.keyVersion;
    this.currentVersionNumber = data.currentVersionNumber;
    this.departmentId = data.departmentId;
    this.scope = data.scope;
    this.ownerUserId = data.ownerUserId;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
    this.Department = data.Department;
    this.Owner = data.Owner;
    this.Versions = data.Versions;
    this.DepartmentAgents = data.DepartmentAgents;
  }
}
