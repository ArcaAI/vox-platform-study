/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { UserDepartmentEntity, IUserDepartmentEntity } from '../../../entities';

export interface CreateUserDepartmentProps extends BaseEntityFactoryCreateProps {
  isPrimary?: IUserDepartmentEntity['isPrimary'];
  userId: IUserDepartmentEntity['userId'];
  departmentId: IUserDepartmentEntity['departmentId'];
  tenantId: IUserDepartmentEntity['tenantId'];

  createdAt?: IUserDepartmentEntity['createdAt'];
  updatedAt?: IUserDepartmentEntity['updatedAt'];
  createdBy?: IUserDepartmentEntity['createdBy'];
  updatedBy?: IUserDepartmentEntity['updatedBy'];
}

export class UserDepartmentFactory {
  static CreateUserDepartment(props: CreateUserDepartmentProps): UserDepartmentEntity {
    const id = generateId();
    const now = new Date();

    return new UserDepartmentEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId,
      isPrimary: props.isPrimary ?? false,
      userId: props.userId,
      departmentId: props.departmentId,
    });
  }
}
