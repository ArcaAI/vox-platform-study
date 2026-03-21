import { ClsStore } from 'nestjs-cls';
import { UserSession } from '../services';

export interface IClsContext extends ClsStore {
    tenantId: string;
    user: UserSession;
}
