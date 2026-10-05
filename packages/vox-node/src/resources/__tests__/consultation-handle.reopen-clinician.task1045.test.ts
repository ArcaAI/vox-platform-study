import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import { ConsultationsResource } from '../consultations';

const BASE = 'http://localhost:8868';
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', etag: '"3"' } });
const row = { id: 'c1', patientId: 'p1', doctorId: 'd1', appointmentDate: '2026-10-06', status: 'CLOSED_INCOMPLETE', processing: 'IDLE', version: 3 };

describe('handle.reopen — a machine caller may name the clinician, like approve and close', () => {
  it('sends clinicianUserId when given, and only then', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/reopen')) {
        bodies.push(JSON.parse(String(init?.body)));
        return ok({ ...row, status: 'OPEN', version: 4 });
      }
      return ok(row);
    });
    const handle = await new ConsultationsResource(new Transport({ baseUrl: BASE, fetch: fetchImpl })).attach('c1');

    await handle.reopen({ reason: 'late copy', clinicianUserId: 'doctor-7' });
    await handle.reopen({ reason: 'again' });

    expect(bodies).toEqual([{ reason: 'late copy', clinicianUserId: 'doctor-7' }, { reason: 'again' }]);
  });
});
