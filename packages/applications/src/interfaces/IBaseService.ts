import {
    BaseEntity,
    SysEvent,
    SysEventType,
} from '@arcaai/domains';

export interface IBaseService {
    broadcastSysEvent(
        type: SysEventType,
        data: Partial<SysEvent>,
    ): void;

    updateEntity<T extends BaseEntity>(entity: T, changes: Partial<T>): void;
}
