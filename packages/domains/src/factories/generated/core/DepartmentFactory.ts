/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { DepartmentEntity, IDepartmentEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateDepartmentProps extends BaseEntityFactoryCreateProps {
  code?: IDepartmentEntity['code'];
  name?: IDepartmentEntity['name'];
  description?: IDepartmentEntity['description'];
  parentDepartmentId?: IDepartmentEntity['parentDepartmentId'];
  tenantId?: IDepartmentEntity['tenantId'];

  // Prompt configuration (GAP-3)
  defaultSummaryTemplate?: IDepartmentEntity['defaultSummaryTemplate'];
  preSummaryPromptId?: IDepartmentEntity['preSummaryPromptId'];
  newPatientPromptId?: IDepartmentEntity['newPatientPromptId'];
  revisitPromptId?: IDepartmentEntity['revisitPromptId'];
  promptConfig?: IDepartmentEntity['promptConfig'];

  createdAt?: IDepartmentEntity['createdAt'];
  updatedAt?: IDepartmentEntity['updatedAt'];
  createdBy?: IDepartmentEntity['createdBy'];
  updatedBy?: IDepartmentEntity['updatedBy'];
}

export class DepartmentFactory {
  /**
   * Create a new department
   */
  static CreateDepartment(props: CreateDepartmentProps): DepartmentEntity {
    const id = generateId();
    const now = new Date();

    return new DepartmentEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      code: props.code ?? null,
      name: props.name ?? null,
      description: props.description ?? null,
      parentDepartmentId: props.parentDepartmentId ?? null,
      tenantId: props.tenantId ?? '',

      // Prompt configuration
      defaultSummaryTemplate: props.defaultSummaryTemplate ?? null,
      preSummaryPromptId: props.preSummaryPromptId ?? null,
      newPatientPromptId: props.newPatientPromptId ?? null,
      revisitPromptId: props.revisitPromptId ?? null,
      promptConfig: props.promptConfig ?? null,
    });
  }

  /**
   * Create a root department (no parent)
   */
  static CreateRootDepartment(tenantId: string, code?: string, name?: string, description?: string, createdBy?: string): DepartmentEntity {
    return this.CreateDepartment({
      tenantId,
      code,
      name,
      description,
      parentDepartmentId: undefined,
      createdBy,
    });
  }

  /**
   * Create a child department
   */
  static CreateChildDepartment(
    tenantId: string,
    parentDepartmentId: string,
    code?: string,
    name?: string,
    description?: string,
    createdBy?: string,
  ): DepartmentEntity {
    return this.CreateDepartment({
      tenantId,
      code,
      name,
      description,
      parentDepartmentId,
      createdBy,
    });
  }
}
