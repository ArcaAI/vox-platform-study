// Phase 2A (TASK-302 Stream B) - secrets module barrel.
// Exports are added incrementally as Tasks 2.2-2.20 land.
export * from './ISecretsProvider';
export * from './providers/env-secrets.provider';
export * from './providers/in-memory-secrets.provider';
export * from './providers/aws-secrets-manager.provider';
export * from './providers/azure-keyvault.provider';
export * from './providers/vault-secrets.provider';
export * from './SecretsService';
export * from './secrets.module';
export * from './secrets.health';
// Phase 6 Task 6.3 (TASK-302 Stream B) — rotation worker.
export * from './vault-rotation-worker';
// Phase 6 Task 6.6 (TASK-302 Stream B) — rotation policy helpers.
export * from './scheduled-rotation.policy';
