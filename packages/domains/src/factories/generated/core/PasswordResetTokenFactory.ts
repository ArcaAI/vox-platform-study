/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { PasswordResetTokenEntity, IPasswordResetTokenEntity } from '../../../entities';

export interface CreatePasswordResetTokenProps extends BaseEntityFactoryCreateProps {
  userId: IPasswordResetTokenEntity['userId'];
  tokenHash: IPasswordResetTokenEntity['tokenHash'];
  expiresAt: IPasswordResetTokenEntity['expiresAt'];
  purpose?: IPasswordResetTokenEntity['purpose'];
  requestedByUserId?: IPasswordResetTokenEntity['requestedByUserId'];
  requestedVia?: IPasswordResetTokenEntity['requestedVia'];
  requestIp?: IPasswordResetTokenEntity['requestIp'];
  /** Arbitrary purpose-specific payload (e.g. `{ pendingTenantName }` for `email_verification`). */
  metaData?: IPasswordResetTokenEntity['metaData'];

  createdAt?: IPasswordResetTokenEntity['createdAt'];
  updatedAt?: IPasswordResetTokenEntity['updatedAt'];
  createdBy?: IPasswordResetTokenEntity['createdBy'];
  updatedBy?: IPasswordResetTokenEntity['updatedBy'];
}

export class PasswordResetTokenFactory {
  static CreatePasswordResetToken(props: CreatePasswordResetTokenProps): PasswordResetTokenEntity {
    const id = generateId();
    const now = new Date();

    return new PasswordResetTokenEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      userId: props.userId,
      tokenHash: props.tokenHash,
      purpose: props.purpose ?? 'password_reset',
      expiresAt: props.expiresAt,
      usedAt: null,
      revokedAt: null,
      requestedByUserId: props.requestedByUserId ?? null,
      requestedVia: props.requestedVia ?? null,
      requestIp: props.requestIp ?? null,
      metaData: props.metaData ?? null,
    });
  }
}
