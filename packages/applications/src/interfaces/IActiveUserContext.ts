import { ClsStore } from 'nestjs-cls';
import type { AppAbility } from '../authorization';
import { UserSession } from '../services';
import type { IServiceAccountPrincipal } from './IServiceAccountPrincipal';

export interface IActiveUserContext extends ClsStore {
  user: UserSession;
  /**
   * TASK-762 — the MACHINE principal, on its own key. Never overloaded onto
   * `user`: every `requestUser?.id` read in the codebase would otherwise
   * attribute a machine action to a person.
   */
  serviceAccount?: IServiceAccountPrincipal;
  correlationId: string;
  requestIp: string;
  tenantId?: string;
  tenantCode?: string;
  userAbility: AppAbility;
}
