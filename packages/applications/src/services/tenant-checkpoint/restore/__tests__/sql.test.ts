import { describe, expect, it } from 'vitest';

import { descriptorFor } from '../../registry/registry';
import { divergedSql, insertSql, retireSql, scopeViolationsSql, stagingTable, updateSql } from '../sql';

const DEPT_COLS = [
  '_metadata', '_version', 'id', 'tenantId', 'name', 'code',
  'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy', 'updatedBy', 'updatedAt',
];

describe('restore SQL builders', () => {
  it('stagingTable is a pg_temp table named after the model', () => {
    expect(stagingTable(descriptorFor('Department'))).toBe('pg_temp."stg_Department"');
  });

  describe('Department — soft-delete RECONCILE', () => {
    const d = descriptorFor('Department');

    it('retires by soft delete, stamping the actor and bumping _version', () => {
      expect(retireSql(d, { columns: DEPT_COLS })).toBe(
        `UPDATE core."Department" l SET "resourceStatus" = 'DELETED', "resourceStatusUpdatedAt" = now(), "resourceStatusUpdatedBy" = $2, ` +
          `"updatedAt" = now(), "updatedBy" = $2, "_version" = l."_version" + 1 ` +
          `WHERE l."tenantId" = $1 AND l."resourceStatus" <> 'DELETED' ` +
          `AND NOT EXISTS (SELECT 1 FROM pg_temp."stg_Department" s WHERE s."id" = l."id")`,
      );
    });

    it('clears isActive on retire when the table has it', () => {
      expect(retireSql(descriptorFor('UserVoiceProfile'), { columns: ['id', 'tenantId', 'resourceStatus', 'isActive'] })).toBe(
        `UPDATE core."UserVoiceProfile" l SET "resourceStatus" = 'DELETED', "isActive" = false ` +
          `WHERE l."tenantId" = $1 AND l."resourceStatus" <> 'DELETED' ` +
          `AND NOT EXISTS (SELECT 1 FROM pg_temp."stg_UserVoiceProfile" s WHERE s."id" = l."id")`,
      );
    });

    it('updates only differing rows, never id/tenantId/_version/stamps from staging', () => {
      expect(updateSql(d, DEPT_COLS)).toBe(
        `UPDATE core."Department" l SET "_metadata" = s."_metadata", "name" = s."name", "code" = s."code", ` +
          `"resourceStatus" = s."resourceStatus", "resourceStatusUpdatedAt" = s."resourceStatusUpdatedAt", "resourceStatusUpdatedBy" = s."resourceStatusUpdatedBy", ` +
          `"updatedAt" = now(), "updatedBy" = $2, "_version" = l."_version" + 1 ` +
          `FROM pg_temp."stg_Department" s WHERE s."id" = l."id" AND l."tenantId" = $1 AND (` +
          `l."_metadata" IS DISTINCT FROM s."_metadata" OR l."name" IS DISTINCT FROM s."name" OR l."code" IS DISTINCT FROM s."code" OR ` +
          `l."resourceStatus" IS DISTINCT FROM s."resourceStatus" OR l."resourceStatusUpdatedAt" IS DISTINCT FROM s."resourceStatusUpdatedAt" OR ` +
          `l."resourceStatusUpdatedBy" IS DISTINCT FROM s."resourceStatusUpdatedBy")`,
      );
    });

    it('the release pass is limited to rows giving up a partial-unique slot', () => {
      expect(updateSql(d, ['id', 'tenantId', 'name', 'resourceStatus'], { release: true })).toBe(
        `UPDATE core."Department" l SET "name" = s."name", "resourceStatus" = s."resourceStatus" ` +
          `FROM pg_temp."stg_Department" s WHERE s."id" = l."id" AND l."tenantId" = $1 ` +
          `AND ((l."resourceStatus" <> 'DELETED' AND s."resourceStatus" = 'DELETED')) ` +
          `AND (l."name" IS DISTINCT FROM s."name" OR l."resourceStatus" IS DISTINCT FROM s."resourceStatus")`,
      );
      expect(updateSql(d, ['id', 'tenantId', 'name'], { release: true })).toBeNull();
    });

    it('inserts missing rows with the checkpoint column list', () => {
      expect(insertSql(d, ['id', 'tenantId', 'name'])).toBe(
        `INSERT INTO core."Department" ("id", "tenantId", "name") SELECT s."id", s."tenantId", s."name" ` +
          `FROM pg_temp."stg_Department" s WHERE NOT EXISTS (SELECT 1 FROM core."Department" l WHERE l."id" = s."id")`,
      );
    });

    it('has no divergence check', () => {
      expect(divergedSql(d, DEPT_COLS)).toBeNull();
    });
  });

  it('PromptVersion — a model without soft delete is retired by DELETE', () => {
    expect(retireSql(descriptorFor('PromptVersion'), { columns: ['id', 'tenantId', 'content'] })).toBe(
      `DELETE FROM core."PromptVersion" l WHERE l."tenantId" = $1 ` +
        `AND NOT EXISTS (SELECT 1 FROM pg_temp."stg_PromptVersion" s WHERE s."id" = l."id")`,
    );
  });

  it('User — INSERT_ONLY never retires and never updates', () => {
    const d = descriptorFor('User');
    expect(retireSql(d, { columns: ['id', 'username', 'password'] })).toBeNull();
    expect(updateSql(d, ['id', 'username', 'password'])).toBeNull();
    expect(insertSql(d, ['id', 'username'])).toBe(
      `INSERT INTO core."User" ("id", "username") SELECT s."id", s."username" ` +
        `FROM pg_temp."stg_User" s WHERE NOT EXISTS (SELECT 1 FROM core."User" l WHERE l."id" = s."id")`,
    );
  });

  it('ApiKey — RETIRE_ONLY revokes with its setSql, guarded so revoked keys are not re-stamped', () => {
    const d = descriptorFor('ApiKey');
    expect(retireSql(d, { columns: ['id', 'tenantId', 'keyStatus', '_version', 'updatedAt'] })).toBe(
      `UPDATE core."ApiKey" l SET "keyStatus" = 'REVOKED', "updatedAt" = now(), "_version" = l."_version" + 1 ` +
        `WHERE l."tenantId" = $1 AND (l."keyStatus" IS DISTINCT FROM 'REVOKED') ` +
        `AND NOT EXISTS (SELECT 1 FROM pg_temp."stg_ApiKey" s WHERE s."id" = l."id")`,
    );
    expect(updateSql(d, ['id', 'tenantId', 'keyStatus'])).toBeNull();
    expect(insertSql(d, ['id', 'tenantId', 'keyStatus'])).toBeNull();
  });

  it('ServiceAccount — the now() part of the revoke SET is not part of the guard', () => {
    expect(retireSql(descriptorFor('ServiceAccount'), { columns: ['id', 'tenantId', 'resourceStatus', 'resourceStatusUpdatedAt'] })).toBe(
      `UPDATE core."ServiceAccount" l SET "resourceStatus" = 'DELETED', "resourceStatusUpdatedAt" = now() ` +
        `WHERE l."tenantId" = $1 AND (l."resourceStatus" IS DISTINCT FROM 'DELETED') ` +
        `AND NOT EXISTS (SELECT 1 FROM pg_temp."stg_ServiceAccount" s WHERE s."id" = l."id")`,
    );
  });

  describe('Agent — partial immutability', () => {
    const d = descriptorFor('Agent');
    const cols = ['id', 'tenantId', 'name', 'status', 'isActive', 'instruction', 'modelId'];

    it('skips a whole row whose immutable columns diverged on a published live row', () => {
      expect(updateSql(d, cols)).toBe(
        `UPDATE core."Agent" l SET "name" = s."name", "status" = s."status", "isActive" = s."isActive", "instruction" = s."instruction", "modelId" = s."modelId" ` +
          `FROM pg_temp."stg_Agent" s WHERE s."id" = l."id" AND l."tenantId" = $1 ` +
          `AND NOT ((l."status" IN ('PUBLISHED','DEPRECATED')) AND (l."modelId" IS DISTINCT FROM s."modelId" OR l."instruction" IS DISTINCT FROM s."instruction")) ` +
          `AND (l."name" IS DISTINCT FROM s."name" OR l."status" IS DISTINCT FROM s."status" OR l."isActive" IS DISTINCT FROM s."isActive" OR ` +
          `l."instruction" IS DISTINCT FROM s."instruction" OR l."modelId" IS DISTINCT FROM s."modelId")`,
      );
    });

    it('reports the diverged ids', () => {
      expect(divergedSql(d, cols)).toBe(
        `SELECT l."id" FROM core."Agent" l JOIN pg_temp."stg_Agent" s ON s."id" = l."id" ` +
          `WHERE l."tenantId" = $1 AND (l."status" IN ('PUBLISHED','DEPRECATED')) ` +
          `AND (l."modelId" IS DISTINCT FROM s."modelId" OR l."instruction" IS DISTINCT FROM s."instruction")`,
      );
    });

    it('a published agent may still be soft-deleted (the trigger allows resourceStatus/isActive)', () => {
      expect(retireSql(d, { columns: ['id', 'tenantId', 'resourceStatus', 'isActive'] })).toBe(
        `UPDATE core."Agent" l SET "resourceStatus" = 'DELETED', "isActive" = false ` +
          `WHERE l."tenantId" = $1 AND l."resourceStatus" <> 'DELETED' ` +
          `AND NOT EXISTS (SELECT 1 FROM pg_temp."stg_Agent" s WHERE s."id" = l."id")`,
      );
    });
  });

  describe("immutableColumns ['*'] — the whole row is frozen while immutableWhen holds", () => {
    it('AgentModelFallback: neither updated nor retired under a published parent; inserts allowed', () => {
      const d = descriptorFor('AgentModelFallback');
      const when = `EXISTS (SELECT 1 FROM core."Agent" a WHERE a."id" = l."agentId" AND a."status" IN ('PUBLISHED','DEPRECATED'))`;
      expect(retireSql(d, { columns: ['id', 'tenantId', 'resourceStatus'] })).toBe(
        `UPDATE core."AgentModelFallback" l SET "resourceStatus" = 'DELETED' ` +
          `WHERE l."tenantId" = $1 AND l."resourceStatus" <> 'DELETED' AND NOT (${when}) ` +
          `AND NOT EXISTS (SELECT 1 FROM pg_temp."stg_AgentModelFallback" s WHERE s."id" = l."id")`,
      );
      expect(updateSql(d, ['id', 'tenantId', 'priority', 'modelId'])).toBe(
        `UPDATE core."AgentModelFallback" l SET "priority" = s."priority", "modelId" = s."modelId" ` +
          `FROM pg_temp."stg_AgentModelFallback" s WHERE s."id" = l."id" AND l."tenantId" = $1 AND NOT (${when}) ` +
          `AND (l."priority" IS DISTINCT FROM s."priority" OR l."modelId" IS DISTINCT FROM s."modelId")`,
      );
      expect(divergedSql(d, ['id', 'tenantId', 'priority'])).toBe(
        `SELECT l."id" FROM core."AgentModelFallback" l JOIN pg_temp."stg_AgentModelFallback" s ON s."id" = l."id" ` +
          `WHERE l."tenantId" = $1 AND (${when}) AND (l."priority" IS DISTINCT FROM s."priority")`,
      );
      expect(insertSql(d, ['id', 'tenantId'])).not.toBeNull();
    });

    it("DocumentTemplateVersion (immutableWhen 'true'): insert-missing only", () => {
      const d = descriptorFor('DocumentTemplateVersion');
      expect(retireSql(d, { columns: ['id', 'tenantId'] })).toBeNull();
      expect(updateSql(d, ['id', 'tenantId', 'body'])).toBeNull();
      expect(insertSql(d, ['id', 'tenantId', 'body'])).not.toBeNull();
    });
  });

  it('AuditLog — CAPTURE_ONLY builds nothing', () => {
    const d = descriptorFor('AuditLog');
    const cols = ['id', 'tenantId', 'data', 'resourceStatus'];
    expect(retireSql(d, { columns: cols })).toBeNull();
    expect(updateSql(d, cols)).toBeNull();
    expect(insertSql(d, cols)).toBeNull();
    expect(divergedSql(d, cols)).toBeNull();
  });

  it('rejects an unsafe column name', () => {
    expect(() => insertSql(descriptorFor('Department'), ['id', 'na"me'])).toThrow(/unsafe column/);
  });

  describe('staging scope check', () => {
    it('tenant column', () => {
      expect(scopeViolationsSql(descriptorFor('Department'), new Set(['Department']))).toBe(
        `SELECT count(*)::int AS n FROM pg_temp."stg_Department" s WHERE NOT COALESCE(s."tenantId" = $1, false)`,
      );
    });

    it('parent scope accepts a staged parent as well as a live one', () => {
      expect(scopeViolationsSql(descriptorFor('RolePolicy'), new Set(['Role', 'RolePolicy']))).toBe(
        `SELECT count(*)::int AS n FROM pg_temp."stg_RolePolicy" s WHERE NOT COALESCE(s."roleId" IN (` +
          `SELECT sp."id" FROM pg_temp."stg_Role" sp UNION SELECT lp."id" FROM core."Role" lp WHERE lp."tenantId" = $1), false)`,
      );
    });

    it('tenant members include staged memberships', () => {
      expect(scopeViolationsSql(descriptorFor('User'), new Set(['User', 'UserRoleAssignment']))).toBe(
        `SELECT count(*)::int AS n FROM pg_temp."stg_User" s WHERE NOT COALESCE(s."id" IN (` +
          `SELECT "userId" FROM core."UserRoleAssignment" WHERE "tenantId" = $1 UNION ` +
          `SELECT "userId" FROM core."UserDepartment" WHERE "tenantId" = $1 UNION ` +
          `SELECT "userId" FROM pg_temp."stg_UserRoleAssignment"), false)`,
      );
    });
  });
});
