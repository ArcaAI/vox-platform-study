import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../../common';

export class UserProfileResponse extends BaseResponse {
  @ApiProperty({ description: 'First name of the user', required: false })
  firstName?: string;

  @ApiProperty({ description: 'Last name of the user', required: false })
  lastName?: string;

  @ApiProperty({ description: 'Email address', required: false })
  email?: string;

  @ApiProperty({ description: 'Phone number', required: false })
  phone?: string;

  @ApiProperty({ description: 'Avatar media ID', required: false })
  avatarId?: string;

  @ApiProperty({ description: 'Preferred backend prompt template ID', required: false })
  preferredPromptTemplateId?: string;

  // TASK-950 — the tenant staff identifier. Declared here so `AutoClassMapper` copies it (the
  // mapper copies a field only when the target instance declares it), which is what puts it on
  // `GET admin/users/:id/profile` and therefore on the console's profile tab.
  @ApiPropertyOptional({ description: 'Tenant staff identifier, unique within the tenant. Null/absent when the user has none.', nullable: true })
  staffId?: string | null;

  @ApiProperty({ description: 'ID of the associated user' })
  userId!: string;

  constructor(init: UserProfileResponse & BaseResponseProps) {
    super(init);
    this.firstName = init.firstName;
    this.lastName = init.lastName;
    this.email = init.email;
    this.phone = init.phone;
    this.avatarId = init.avatarId;
    this.preferredPromptTemplateId = init.preferredPromptTemplateId;
    this.staffId = init.staffId;
    this.userId = init.userId;
  }
}
