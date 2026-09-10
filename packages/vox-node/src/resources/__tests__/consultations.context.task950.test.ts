/**
 * TASK-950 lane F — the consultation-context payload on `open()`, and the
 * `userIdentity` marker on a `STRUCTURED` context kind.
 *
 * Hermetic: every gateway call goes through a `fetch` double. Nothing here
 * opens a socket or reaches a live gateway. The gateway-side resolution
 * (matching or provisioning a tenant user from the marked field) is out of
 * scope here — this only proves the SDK sends `context` verbatim and that
 * the types accept the new shapes.
 */

import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import type { ContextKindDeclaration } from '../../types/consultation-context-schema';
import type { OpenConsultationRequest } from '../../types/consultation-realtime';
import { ConsultationsResource } from '../consultations';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function transportWith(fetchImpl: typeof fetch): Transport {
  return new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
}

const CONSULTATION = {
  id: 'c1',
  patientId: 'p1',
  doctorId: 'auto-provisioned-user',
  departmentId: 'dept-1',
  appointmentDate: '2026-09-11',
  status: 'OPEN' as const,
  isNew: true,
  createdAt: '2026-09-11T00:00:00Z',
  updatedAt: '2026-09-11T00:00:00Z',
};

describe('ConsultationsResource#open — context (TASK-950)', () => {
  it('sends `context` verbatim in the JSON body, without adding clinicianUserId', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, CONSULTATION));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    const request: OpenConsultationRequest = {
      patientId: 'p1',
      departmentId: 'dept-1',
      context: { context: { consultant_id: 'DR-1001' } },
    };

    const result = await resource.open(request);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/consultations/open');
    expect(init.method).toBe('POST');
    const sentBody = JSON.parse(String(init.body));
    expect(sentBody).toEqual({
      patientId: 'p1',
      departmentId: 'dept-1',
      context: { context: { consultant_id: 'DR-1001' } },
    });
    expect(sentBody.clinicianUserId).toBeUndefined();
    expect(result.doctorId).toBe('auto-provisioned-user');
  });

  it('sends both `clinicianUserId` and `context` when the caller supplies both', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, CONSULTATION));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    await resource.open({
      patientId: 'p1',
      clinicianUserId: 'clinician-1',
      context: { context: { consultant_id: 'DR-1001' } },
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      patientId: 'p1',
      clinicianUserId: 'clinician-1',
      context: { context: { consultant_id: 'DR-1001' } },
    });
  });

  it('omits `context` entirely when the caller does not supply one (unchanged wire shape)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, CONSULTATION));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    await resource.open({ patientId: 'p1', clinicianUserId: 'clinician-1' });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('context');
  });
});

describe('type shapes (TASK-950)', () => {
  it('`OpenConsultationRequest.context` accepts a `{ [kindKey]: payload }` record', () => {
    const request: OpenConsultationRequest = {
      patientId: 'p1',
      // No `clinicianUserId` — a service account may name the clinician
      // through the schema's user-identity field alone.
      context: { context: { consultant_id: 'DR-1001' } },
    };

    expect(request.context).toEqual({ context: { consultant_id: 'DR-1001' } });
  });

  it('`ContextKindDeclaration.userIdentity` names the property carrying the staff identifier', () => {
    const kind: ContextKindDeclaration = {
      key: 'context',
      primitive: 'STRUCTURED',
      cardinality: 'ONE',
      fields: {
        type: 'object',
        properties: { consultant_id: { type: 'string' } },
      },
      userIdentity: { field: 'consultant_id' },
    };

    expect(kind.userIdentity?.field).toBe('consultant_id');
  });

  it('`ContextKindDeclaration` without `userIdentity` still type-checks (optional marker)', () => {
    const kind: ContextKindDeclaration = {
      key: 'vitals',
      primitive: 'STRUCTURED',
    };

    expect(kind.userIdentity).toBeUndefined();
  });
});
