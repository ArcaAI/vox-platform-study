import { BaseEntityFactoryCreateProps } from '../../../common';
import { IUserChangelogAcknowledgementEntity, UserChangelogAcknowledgementEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateUserChangelogAcknowledgementProps extends BaseEntityFactoryCreateProps {
  tenantId: IUserChangelogAcknowledgementEntity['tenantId'];
  userId: IUserChangelogAcknowledgementEntity['userId'];
  changelogEntryId: IUserChangelogAcknowledgementEntity['changelogEntryId'];
  acknowledgedAt?: IUserChangelogAcknowledgementEntity['acknowledgedAt'];
  autoAcknowledged?: IUserChangelogAcknowledgementEntity['autoAcknowledged'];

  createdAt?: IUserChangelogAcknowledgementEntity['createdAt'];
  updatedAt?: IUserChangelogAcknowledgementEntity['updatedAt'];
  createdBy?: IUserChangelogAcknowledgementEntity['createdBy'];
  updatedBy?: IUserChangelogAcknowledgementEntity['updatedBy'];
}

export class UserChangelogAcknowledgementFactory {
  static CreateUserChangelogAcknowledgement(props: CreateUserChangelogAcknowledgementProps): UserChangelogAcknowledgementEntity {
    const id = generateId();
    const now = new Date();

    return new UserChangelogAcknowledgementEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      userId: props.userId,
      changelogEntryId: props.changelogEntryId,
      acknowledgedAt: props.acknowledgedAt || now,
      autoAcknowledged: props.autoAcknowledged ?? false,
    });
  }
}
