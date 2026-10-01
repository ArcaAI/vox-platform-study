import type { CheckpointModelDescriptor } from '../contracts';
import { descriptorFor, tableName } from './registry';

const MEMBERS =
  '(SELECT "userId" FROM core."UserRoleAssignment" WHERE "tenantId" = $1 UNION SELECT "userId" FROM core."UserDepartment" WHERE "tenantId" = $1)';

/** WHERE-clause over alias `alias` for this descriptor; tenant id is always `$1`. Recurses through `parent`. */
export function scopePredicate(d: CheckpointModelDescriptor, alias: string): string {
  return predicate(d, alias, 0);
}

function predicate(d: CheckpointModelDescriptor, alias: string, depth: number): string {
  const scope = d.scope;
  switch (scope.kind) {
    case 'tenantColumn':
      return `${alias}."${scope.column ?? 'tenantId'}" = $1`;
    case 'tenantMembers':
      return `${alias}."id" IN ${MEMBERS}`;
    case 'parent': {
      if (depth > 8) throw new Error(`checkpoint scope: parent chain too deep at ${d.model}`);
      const parent = descriptorFor(scope.parent);
      const p = depth === 0 ? 'p' : `p${depth + 1}`;
      return `${alias}."${scope.fk}" IN (SELECT ${p}."id" FROM ${tableName(parent)} ${p} WHERE ${predicate(parent, p, depth + 1)})`;
    }
    case 'none':
      throw new Error(`checkpoint scope: ${d.model} is EXCLUDED and has no tenant scope`);
  }
}
