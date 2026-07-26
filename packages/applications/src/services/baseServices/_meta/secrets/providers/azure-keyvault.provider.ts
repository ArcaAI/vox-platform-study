import { Injectable, NotImplementedException } from '@nestjs/common';
import { ISecretsProvider, SecretsHealth } from '../ISecretsProvider';

/**
 * AzureKeyVaultProvider stub.
 *
 * Future-option placeholder. Mirrors AwsSecretsManagerProvider.
 */
@Injectable()
export class AzureKeyVaultProvider implements ISecretsProvider {
  readonly name = 'azure' as const;

  private fail(): never {
    throw new NotImplementedException('AzureKeyVaultProvider is a future-option stub. Set SECRETS_PROVIDER=vault or =env.');
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
