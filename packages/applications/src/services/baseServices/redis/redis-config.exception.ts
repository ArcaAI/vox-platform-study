import { BadRequestException } from '@nestjs/common';

/**
 * Exception thrown when Redis configuration is missing or invalid
 */
export class RedisConfigurationException extends BadRequestException {
  constructor(message: string, missingKeys?: string[]) {
    const errorMessage = missingKeys && missingKeys.length > 0 ? `${message}. Missing configuration keys: ${missingKeys.join(', ')}` : message;

    super({
      message: errorMessage,
      error: 'Redis Configuration Error',
      statusCode: 400,
      details: {
        missingKeys: missingKeys || [],
        service: 'RedisService',
        timestamp: new Date().toISOString(),
      },
    });
  }
}
