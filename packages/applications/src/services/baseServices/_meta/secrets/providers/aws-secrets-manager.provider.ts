import { Injectable, NotImplementedException } from '@nestjs/common';
import { ISecretsProvider, SecretsHealth } from '../ISecretsProvider';

/**
 * AwsSecretsManagerProvider stub.
 *
 * Future-option placeholder: keeps the ISecretsProvider
 * surface portable so a later change can swap providers without touching
 * consumers. Throws NotImplementedException on every call.
 *
 * NestJS maps NotImplementedException to HTTP 501, which is the correct
 * signal: the feature is not implemented, not just temporarily failing.
 */
@Injectable()
export class AwsSecretsManagerProvider implements ISecretsProvider {
  private fail(): never {
    throw new NotImplementedException('AwsSecretsManagerProvider is a future-option stub. Set SECRETS_PROVIDER=vault or =env.');
  }
  async getSecret(): Promise<string> {
    this.fail();
  }
  async getSecretOptional(): Promise<string | undefined> {
    this.fail();
  }
  async getSecretJson<T>(): Promise<T> {
    this.fail();
  }
  async getSecrets(): Promise<Record<string, string>> {
    this.fail();
  }
  async rotateSecret(): Promise<void> {
    this.fail();
  }
  async health(): Promise<SecretsHealth> {
    this.fail();
  }
}
