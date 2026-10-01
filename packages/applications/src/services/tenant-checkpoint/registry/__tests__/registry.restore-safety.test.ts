/**
 * Restore-safety rules of the registry (TASK-1032 final fix wave): unique slots, redacted credential
 * columns, secrets that never travel back in time, and the platform-governed boundary.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CHECKPOINT_REGISTRY, descriptorFor, GLOBAL_ONLY_SETTING_KEYS, HARNESS_POLICY_PLATFORM_COLUMNS } from '../registry';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCHEMA_DIR = resolve(HERE, '../../../../../../database/src/prisma/db_main');
const HARNESS_POLICY_SERVICE = resolve(HERE, '../../../harness-policy/harness-policy.service.ts');

interface PrismaModel {
  fields: string[];
  /** Non-partial unique keys (Prisma cannot declare a partial one), as field lists. */
  uniques: string[][];
}

/** model name → fields and unique keys, read from the multi-file Prisma schema. */
function prismaModels(): Map<string, PrismaModel> {
  const out = new Map<string, PrismaModel>();
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma'))) {
    const text = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    for (const block of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const fields: string[] = [];
      const uniques: string[][] = [];
      for (const raw of block[2].split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        if (!line) continue;
        const compound = /^@@unique\(\s*(?:fields:\s*)?\[([^\]]+)\]/.exec(line);
        if (compound) {
          uniques.push(compound[1].split(',').map((f) => f.trim().replace(/\(.*$/, '')));
          continue;
        }
        const field = /^(\w+)\s+\S+/.exec(line);
        if (!field || line.startsWith('@@')) continue;
        fields.push(field[1]);
        if (/\s@unique\b/.test(line)) uniques.push([field[1]]);
      }
      out.set(block[1], { fields, uniques });
    }
  }
  return out;
}

const MODELS = prismaModels();
const WRITING = new Set(['RECONCILE', 'INSERT_ONLY', 'RETIRE_ONLY']);

describe('checkpoint registry — restore safety', () => {
  it('reads the Prisma schema (sanity)', () => {
    expect(MODELS.get('AgentModelFallback')?.uniques).toContainEqual(['agentId', 'priority']);
    expect(MODELS.get('User')?.uniques).toContainEqual(['username']);
  });

  it('a soft retire never leaves a non-partial unique slot to fail the restore: hard delete, or skip the claimant', () => {
    const offenders: string[] = [];
    for (const d of CHECKPOINT_REGISTRY) {
      if (!WRITING.has(d.policy) || d.retire.kind === 'hardDelete') continue;
      const keys = (MODELS.get(d.model)?.uniques ?? []).filter((k) => !k.includes('id'));
      if (keys.length && d.uniqueSlot !== 'skip') offenders.push(`${d.model} [${keys.map((k) => k.join('+')).join(', ')}]`);
    }
    expect(offenders).toEqual([]);
  });

  it('AgentModelFallback is hard-deleted on retire (the app replaces chains by delete + recreate) and never inserted under a published agent', () => {
    const d = descriptorFor('AgentModelFallback');
    expect(d.retire.kind).toBe('hardDelete');
    expect(d.immutableWhen).toBeTruthy();
    expect(d.insertFrozenWhen).toMatch(/PUBLISHED/);
  });

  it('credential hashes, verifiers and passwords are redacted (exported as NULL)', () => {
    expect(descriptorFor('User').redactColumns).toEqual(['password', 'secret1', 'secret2']);
    expect(descriptorFor('User').redactInsert?.password).toMatch(/^'!/); // bcrypt never matches a '!' hash
    expect(descriptorFor('ApiKey').redactColumns).toEqual(['keyHash']);
    expect(descriptorFor('ServiceAccount').redactColumns).toEqual(['secretVerifier', 'previousSecretVerifier']);
    expect(descriptorFor('StorageAccessKey').redactColumns).toEqual(['secretAccessKey']);
    expect(descriptorFor('PasswordResetToken').policy).toBe('EXCLUDED');
  });

  it('every hash / verifier / secret column of a RETIRE_ONLY credential model is redacted', () => {
    for (const d of CHECKPOINT_REGISTRY.filter((x) => x.policy === 'RETIRE_ONLY')) {
      const sensitive = (MODELS.get(d.model)?.fields ?? []).filter((f) => /hash|verifier|secret/i.test(f) && !/Ref$|At$|Expiry$/.test(f));
      expect([...(d.redactColumns ?? [])].sort(), d.model).toEqual(sensitive.sort());
    }
  });

  it('secrets never travel back in time: these columns are kept on update and NULL on insert', () => {
    const secrets = Object.fromEntries(CHECKPOINT_REGISTRY.filter((d) => d.secretColumns?.length).map((d) => [d.model, d.secretColumns]));
    expect(secrets).toEqual({
      AiProviderConnection: ['encryptedApiKey', 'keyVersion'],
      WorkflowWebhookSecret: ['encryptedSecret'],
      Webhook: ['hashedSecret'],
      TenantIdentityProvider: ['encryptedSecretRef', 'directoryCredentialsRef'],
      GlobalSetting: ['encryptedValue', 'keyVersion'],
    });
  });

  it('every redacted / secret / platform-governed column exists on its model', () => {
    for (const d of CHECKPOINT_REGISTRY) {
      const fields = MODELS.get(d.model)?.fields ?? [];
      const named = [
        ...(d.redactColumns ?? []),
        ...(d.secretColumns ?? []),
        ...(d.platformGoverned?.kind === 'columns' ? d.platformGoverned.columns : []),
        ...(d.slots ?? []).flatMap((s) => [s.column, ...s.key]),
      ];
      for (const c of named) expect(fields, `${d.model}.${c}`).toContain(c);
    }
  });

  it('platform-governed rows: RateLimitRule, super-admin AiRoutingPolicy task keys, globalOnly settings, HarnessPolicy platform knobs', () => {
    const governed = Object.fromEntries(CHECKPOINT_REGISTRY.filter((d) => d.platformGoverned).map((d) => [d.model, d.platformGoverned!.kind]));
    expect(governed).toEqual({ RateLimitRule: 'model', AiRoutingPolicy: 'rows', GlobalSetting: 'rows', HarnessPolicy: 'columns' });
    const routing = descriptorFor('AiRoutingPolicy').platformGoverned as { where: string };
    for (const p of ['nlp.', 'harness.', 'guardrail.']) expect(routing.where).toContain(`LIKE '${p}%'`);
    expect(GLOBAL_ONLY_SETTING_KEYS).toContain('console.tools.mcp.enabled');
    expect((descriptorFor('GlobalSetting').platformGoverned as { where: string }).where).toContain(`'console.tools.mcp.enabled'`);
  });

  it('HARNESS_POLICY_PLATFORM_COLUMNS mirrors SUPER_ADMIN_ONLY_POLICY_KEYS in the harness policy service', () => {
    const src = readFileSync(HARNESS_POLICY_SERVICE, 'utf8');
    const body = /const SUPER_ADMIN_ONLY_POLICY_KEYS = \[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
    const keys = [...body.replace(/\/\/.*$/gm, '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect([...HARNESS_POLICY_PLATFORM_COLUMNS].sort()).toEqual(keys.sort());
  });

  it('an elevated-role assignment (SUPER_ADMIN) is never touched by any restore', () => {
    expect(descriptorFor('UserRoleAssignment').neverTouch).toMatch(/"name" IN \('SUPER_ADMIN'\)/);
  });

  it('retiring a consultation frees its encounter key and keeps the original in _metadata', () => {
    const set = descriptorFor('Consultation').retireSet ?? [];
    expect(set[0]).toBe(`"externalRef" = NULL`);
    expect(set[1]).toContain(`jsonb_build_object('retiredExternalRef', l."externalRef")`);
  });

  it('declares the single-holder slots of the partial / marker unique indexes', () => {
    const slots = Object.fromEntries(CHECKPOINT_REGISTRY.filter((d) => d.slots?.length).map((d) => [d.model, d.slots!.map((s) => s.column)]));
    expect(slots).toEqual({
      Agent: ['isActive'],
      WorkflowDefinition: ['isActive'],
      AiProviderConnection: ['defaultForProvider'],
      AiRoutingPolicy: ['isDefault'],
      UserVoiceProfile: ['isActive'],
    });
  });
});
