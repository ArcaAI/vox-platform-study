/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class UserChangelogAcknowledgement extends BaseTenantDataModel {
  public userId: string;
  public changelogEntryId: string;
  public acknowledgedAt: Date;
  public autoAcknowledged: boolean;
  @VirtualDbProperty()
  public ChangelogEntry: Models.ChangelogEntry | undefined;

  constructor(data: UserChangelogAcknowledgement & BaseTenantDataModel) {
    super(data);
    this.userId = data.userId;
    this.changelogEntryId = data.changelogEntryId;
    this.acknowledgedAt = data.acknowledgedAt;
    this.autoAcknowledged = data.autoAcknowledged;
    this.ChangelogEntry = data.ChangelogEntry;
  }
}
