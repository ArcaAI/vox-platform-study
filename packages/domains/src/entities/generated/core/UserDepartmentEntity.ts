/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

export interface IUserDepartmentEntity extends IBaseTenantEntity {
  isPrimary: boolean;
  userId: string;
  departmentId: string;
}

export class UserDepartmentEntity extends BaseTenantEntity {
  private _isPrimary: IUserDepartmentEntity['isPrimary'];
  private _userId: IUserDepartmentEntity['userId'];
  private _departmentId: IUserDepartmentEntity['departmentId'];

  constructor(init: IUserDepartmentEntity) {
    super(init);
    this._isPrimary = init.isPrimary;
    this._userId = init.userId;
    this._departmentId = init.departmentId;
  }

  get isPrimary(): IUserDepartmentEntity['isPrimary'] {
    return this._isPrimary;
  }

  set isPrimary(value: IUserDepartmentEntity['isPrimary']) {
    this.setProperty('isPrimary', value);
  }

  get userId(): IUserDepartmentEntity['userId'] {
    return this._userId;
  }

  set userId(value: IUserDepartmentEntity['userId']) {
    this.setProperty('userId', value);
  }

  get departmentId(): IUserDepartmentEntity['departmentId'] {
    return this._departmentId;
  }

  set departmentId(value: IUserDepartmentEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

}
