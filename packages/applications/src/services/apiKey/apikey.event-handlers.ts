import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ApiKeyStatus, ApiKeyRepository } from '@arcaai/domains';

export interface UserDeletedPayload {
  userId: string;
  tenantId: string;
}

@Injectable()
export class ApiKeyEventHandlers {
  private readonly logger = new Logger(ApiKeyEventHandlers.name);

  constructor(private readonly apiKeyRepository: ApiKeyRepository) {}

  @OnEvent('user.deleted')
  async handleUserDeleted(payload: UserDeletedPayload): Promise<void> {
    try {
      const activeKeys = await this.apiKeyRepository.findAll({
        where: { userId: payload.userId, keyStatus: ApiKeyStatus.ACTIVE },
      });

      if (!activeKeys || activeKeys.length === 0) {
        this.logger.log({
          message: 'No active API keys found for deleted user',
          userId: payload.userId,
        });
        return;
      }

      let deactivatedCount = 0;
      for (const key of activeKeys) {
        try {
          key.keyStatus = ApiKeyStatus.INACTIVE;
          await this.apiKeyRepository.update(key.id, key);
          deactivatedCount++;
        } catch (updateError) {
          this.logger.error({
            message: 'Failed to deactivate individual API key',
            keyId: key.id,
            userId: payload.userId,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        }
      }

      this.logger.log({
        message: `Deactivated ${deactivatedCount} of ${activeKeys.length} API key(s) for deleted user`,
        userId: payload.userId,
        keyIds: activeKeys.map((k) => k.id),
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to deactivate API keys for deleted user',
        userId: payload.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
