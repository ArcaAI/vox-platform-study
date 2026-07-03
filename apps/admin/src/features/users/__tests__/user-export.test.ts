import { describe, expect, it } from 'vitest';
import type { User } from '@arcaai/vox';
import { buildUserExportRows, toUserCsv } from '../user-export';

const deptNames: Record<string, string> = { d1: 'Cardiology', d2: 'Emergency' };

const users: User[] = [
  { id: 'u1', username: 'maya.chen', email: 'maya@acme.health', resourceStatus: 'ENABLED', isServiceAccount: false, departmentIds: ['d1', 'd2'] },
  { id: 'u2', username: 'svc.ingest', resourceStatus: 'DISABLED', isServiceAccount: true, departmentIds: [] },
];

describe('buildUserExportRows (selection/grid → flat export rows)', () => {
  it('maps username/email/type/status + resolves department names', () => {
    expect(buildUserExportRows(users, deptNames)).toEqual([
      { id: 'u1', username: 'maya.chen', email: 'maya@acme.health', type: 'Human', status: 'Active', departments: 'Cardiology; Emergency' },
      { id: 'u2', username: 'svc.ingest', email: '', type: 'Service account', status: 'Inactive', departments: '' },
    ]);
  });
});

describe('toUserCsv (REAL near-term CSV export; Excel/PDF are TARGET)', () => {
  it('emits a header row then one CRLF-separated line per user', () => {
    const csv = toUserCsv(users, deptNames);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Username,Email,Type,Status,Departments,ID');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('maya.chen,maya@acme.health,Human,Active,Cardiology; Emergency,u1');
  });

  it('RFC-4180 escapes values containing commas, quotes or newlines', () => {
    const tricky: User[] = [{ id: 'x"1', username: 'a,b', email: 'q"q', resourceStatus: 'ENABLED', departmentIds: [] }];
    const line = toUserCsv(tricky, {}).split('\r\n')[1];
    expect(line).toBe('"a,b","q""q",Human,Active,,"x""1"');
  });
});
