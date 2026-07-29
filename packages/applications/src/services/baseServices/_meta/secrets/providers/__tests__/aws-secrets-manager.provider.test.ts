import { describe, it, expect } from 'vitest';
import { NotImplementedException } from '@nestjs/common';
import { AwsSecretsManagerProvider } from '../aws-secrets-manager.provider';

describe('AwsSecretsManagerProvider (stub)', () => {
  it('throws NotImplementedException on getSecret', async () => {
    await expect(new AwsSecretsManagerProvider().getSecret('X')).rejects.toBeInstanceOf(NotImplementedException);
  });
  it('throws NotImplementedException on health', async () => {
    await expect(new AwsSecretsManagerProvider().health()).rejects.toBeInstanceOf(NotImplementedException);
  });
  it('throws NotImplementedException on rotateSecret', async () => {
    await expect(new AwsSecretsManagerProvider().rotateSecret('K')).rejects.toBeInstanceOf(NotImplementedException);
  });
});
