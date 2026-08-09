/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { ChangelogAudience, ChangelogPublishStatus, ChangelogSeverity } from '../../../enums';

// Curated release notes ("What's New", TASK-648 §3.5/§3.6) — one row per
// platform (`ALL-`) train version. CI creates a DRAFT pre-filled from
// Conventional Commits; a global admin edits it into human language and
// PUBLISHes it. This is the ONE model in the Service Version & Release
// Registry that is genuinely human-edited, so it carries real OCC (see
// ChangelogEntryEntityMapper's `FIELDS_NOT_WRITABLE`). Always platform-wide
// under the SYSTEM tenant.
export interface IChangelogEntryEntity extends IBaseTenantEntity {
  platformVersion: string;
  title: string;
  summary: string;
  body: string;
  severity: ChangelogSeverity;
  audience: ChangelogAudience;
  publishStatus: ChangelogPublishStatus;
  publishedAt?: Date | null;
}

export class ChangelogEntryEntity extends BaseTenantEntity {
  private _platformVersion: IChangelogEntryEntity['platformVersion'];
  private _title: IChangelogEntryEntity['title'];
  private _summary: IChangelogEntryEntity['summary'];
  private _body: IChangelogEntryEntity['body'];
  private _severity: IChangelogEntryEntity['severity'];
  private _audience: IChangelogEntryEntity['audience'];
  private _publishStatus: IChangelogEntryEntity['publishStatus'];
  private _publishedAt?: IChangelogEntryEntity['publishedAt'];

  constructor(init: IChangelogEntryEntity) {
    super(init);
    this._platformVersion = init.platformVersion;
    this._title = init.title;
    this._summary = init.summary;
    this._body = init.body;
    this._severity = init.severity;
    this._audience = init.audience;
    this._publishStatus = init.publishStatus;
    this._publishedAt = init.publishedAt;
  }

  get platformVersion(): IChangelogEntryEntity['platformVersion'] {
    return this._platformVersion;
  }

  set platformVersion(value: IChangelogEntryEntity['platformVersion']) {
    this.setProperty('platformVersion', value);
  }

  get title(): IChangelogEntryEntity['title'] {
    return this._title;
  }

  set title(value: IChangelogEntryEntity['title']) {
    this.setProperty('title', value);
  }

  get summary(): IChangelogEntryEntity['summary'] {
    return this._summary;
  }

  set summary(value: IChangelogEntryEntity['summary']) {
    this.setProperty('summary', value);
  }

  get body(): IChangelogEntryEntity['body'] {
    return this._body;
  }

  set body(value: IChangelogEntryEntity['body']) {
    this.setProperty('body', value);
  }

  get severity(): IChangelogEntryEntity['severity'] {
    return this._severity;
  }

  set severity(value: IChangelogEntryEntity['severity']) {
    this.setProperty('severity', value);
  }

  get audience(): IChangelogEntryEntity['audience'] {
    return this._audience;
  }

  set audience(value: IChangelogEntryEntity['audience']) {
    this.setProperty('audience', value);
  }

  get publishStatus(): IChangelogEntryEntity['publishStatus'] {
    return this._publishStatus;
  }

  set publishStatus(value: IChangelogEntryEntity['publishStatus']) {
    this.setProperty('publishStatus', value);
  }

  get publishedAt(): IChangelogEntryEntity['publishedAt'] {
    return this._publishedAt;
  }

  set publishedAt(value: IChangelogEntryEntity['publishedAt']) {
    this.setProperty('publishedAt', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._platformVersion || this._platformVersion.trim().length === 0) {
      throw new BusinessException('Platform version is required');
    }
    if (!this._title || this._title.trim().length === 0) {
      throw new BusinessException('Title is required');
    }
    if (!this._summary || this._summary.trim().length === 0) {
      throw new BusinessException('Summary is required');
    }
    if (!this._body || this._body.trim().length === 0) {
      throw new BusinessException('Body is required');
    }
    if (this._publishStatus === ChangelogPublishStatus.PUBLISHED && !this._publishedAt) {
      throw new BusinessException('A published entry must carry a publishedAt timestamp');
    }
  }
}
