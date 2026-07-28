import { describe, it, expect } from 'vitest';
import { NotImplementedException } from '@nestjs/common';
import { AzureKeyVaultProvider } from '../azure-keyvault.provider';

describe('AzureKeyVaultProvider (stub)', () => {
  it('throws NotImplementedException on getSecret', async () => {
    await expect(new AzureKeyVaultProvider().getSecret('X')).rejects.toBeInstanceOf(NotImplementedException);
  });
  it('throws NotImplementedException on health', async () => {
    await expect(new AzureKeyVaultProvider().health()).rejects.toBeInstanceOf(NotImplementedException);
  });
});
