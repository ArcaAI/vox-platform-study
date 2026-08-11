/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { DepartmentAgentVersionEntity, IDepartmentAgentVersionEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateDepartmentAgentVersionProps extends BaseEntityFactoryCreateProps {
  tenantId: IDepartmentAgentVersionEntity['tenantId'];
  agentId: IDepartmentAgentVersionEntity['agentId'];
  versionNumber: IDepartmentAgentVersionEntity['versionNumber'];
  configSnapshot: IDepartmentAgentVersionEntity['configSnapshot'];
  checksum: IDepartmentAgentVersionEntity['checksum'];
  changeReason?: IDepartmentAgentVersionEntity['changeReason'];

  createdAt?: IDepartmentAgentVersionEntity['createdAt'];
  createdBy?: IDepartmentAgentVersionEntity['createdBy'];
}

export class DepartmentAgentVersionFactory {
  /**
   * One immutable loop-config snapshot. `checksum` is supplied by the caller
   * rather than computed here so the SAME canonicalisation used to decide
   * "is this write a no-op" is the one persisted — a second implementation
   * here would be a second source of truth. Mirrors
   * `ConsultationContextSchemaVersionFactory`.
   *
   * No `updatedAt`/`updatedBy`: the row is never updated (the mapper strips
   * them).
   */
  static CreateDepartmentAgentVersion(props: CreateDepartmentAgentVersionProps): DepartmentAgentVersionEntity {
    const id = generateId();
    const now = new Date();

    return new DepartmentAgentVersionEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.createdAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      agentId: props.agentId,
      versionNumber: props.versionNumber,
      configSnapshot: props.configSnapshot,
      checksum: props.checksum,
      changeReason: props.changeReason ?? null,
    });
  }
}
