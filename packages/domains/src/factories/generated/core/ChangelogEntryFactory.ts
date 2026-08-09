import { BaseEntityFactoryCreateProps } from '../../../common';
import { IChangelogEntryEntity, ChangelogEntryEntity } from '../../../entities';
import { ChangelogAudience, ChangelogPublishStatus, ChangelogSeverity } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateChangelogEntryProps extends BaseEntityFactoryCreateProps {
  tenantId: IChangelogEntryEntity['tenantId'];
  platformVersion: IChangelogEntryEntity['platformVersion'];
  title: IChangelogEntryEntity['title'];
  summary: IChangelogEntryEntity['summary'];
  body: IChangelogEntryEntity['body'];
  severity?: IChangelogEntryEntity['severity'];
  audience?: IChangelogEntryEntity['audience'];
  publishStatus?: IChangelogEntryEntity['publishStatus'];
  publishedAt?: IChangelogEntryEntity['publishedAt'];

  createdAt?: IChangelogEntryEntity['createdAt'];
  updatedAt?: IChangelogEntryEntity['updatedAt'];
  createdBy?: IChangelogEntryEntity['createdBy'];
  updatedBy?: IChangelogEntryEntity['updatedBy'];
}

export class ChangelogEntryFactory {
  static CreateChangelogEntry(props: CreateChangelogEntryProps): ChangelogEntryEntity {
    const id = generateId();
    const now = new Date();

    return new ChangelogEntryEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      platformVersion: props.platformVersion,
      title: props.title,
      summary: props.summary,
      body: props.body,
      severity: props.severity ?? ChangelogSeverity.INFO,
      audience: props.audience ?? ChangelogAudience.ALL,
      publishStatus: props.publishStatus ?? ChangelogPublishStatus.DRAFT,
      publishedAt: props.publishedAt ?? null,
    });
  }
}
