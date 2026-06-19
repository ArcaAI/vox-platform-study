/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Role extends BaseDataModel {
  public name: string;
  public description: string | null;
  public externalName: string | null;
  public externalId: string | null;
  public isSystemRole: boolean;
  public parentRoleId: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public ParentRole: Models.Role | undefined;
  @VirtualDbProperty()
  public ChildRoles: Models.Role[] | undefined;
  @VirtualDbProperty()
  public RolePolicies: Models.RolePolicy[] | undefined;
  @VirtualDbProperty()
  public UserRoleAssignments: Models.UserRoleAssignment[] | undefined;

  constructor(data: Role & BaseDataModel) {
    super(data);
    this.name = data.name;
    this.description = data.description;
    this.externalName = data.externalName;
    this.externalId = data.externalId;
    this.isSystemRole = data.isSystemRole;
    this.parentRoleId = data.parentRoleId;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.ParentRole = data.ParentRole;
    this.ChildRoles = data.ChildRoles;
    this.RolePolicies = data.RolePolicies;
    this.UserRoleAssignments = data.UserRoleAssignments;
  }
}
