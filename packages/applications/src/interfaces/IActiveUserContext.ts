import { ClsStore } from 'nestjs-cls';
import type { AppAbility } from '../authorization';
import { UserSession } from '../services';

export interface IActiveUserContext extends ClsStore {
  user: UserSession;
  correlationId: string;
  requestIp: string;
  tenantId?: string;
  tenantCode?: string;
  userAbility: AppAbility;
}
