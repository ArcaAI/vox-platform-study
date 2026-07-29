import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConsultation, getConsultationAggregate, listConsultations } from '../client';
import { consultationKeys } from '../keys';
import { visitTypeOf } from '../types';

interface RecordedCall {
  url: string;
  method: string;
}

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json({ success: true });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('consultationKeys', () => {
  it('is stable and separates list, aggregate and detail', () => {
    expect(consultationKeys.list({ page: 1 })).toEqual(consultationKeys.list({ page: 1 }));
    expect(consultationKeys.list({ page: 1 })).not.toEqual(consultationKeys.list({ page: 2 }));
    expect(consultationKeys.aggregate({ from: '2026-04-06', to: '2026-07-05' })).toEqual(
      consultationKeys.aggregate({ from: '2026-04-06', to: '2026-07-05' }),
    );
    expect(consultationKeys.aggregate({ from: '2026-04-06', to: '2026-07-05' })).not.toEqual(
      consultationKeys.aggregate({ from: '2026-04-06', to: '2026-07-05', granularity: 'day' }),
    );
    expect(consultationKeys.detail('c-1')).not.toEqual(consultationKeys.detail('c-2'));
    expect(consultationKeys.detail('c-1')[0]).toBe('consultations');
    expect(consultationKeys.aggregate({ from: 'a', to: 'b' })[0]).toBe('consultations');
  });
});

describe('consultations client', () => {
  it('lists consultations with the 1-based page and the four filter params', async () => {
    const calls = installFetchMock();
    await listConsultations();
    await listConsultations({ page: 1, limit: 25 });
    await listConsultations({ page: 2, limit: 50, patientId: 'pt_44s1x9', doctorId: 'usr-vasquez', departmentId: 'dep-card', status: 'SIGNED' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/consultations',
      'GET /api/hope/admin/consultations?page=1&limit=25',
      'GET /api/hope/admin/consultations?page=2&limit=50&patientId=pt_44s1x9&doctorId=usr-vasquez&departmentId=dep-card&status=SIGNED',
    ]);
  });

  it('fetches the aggregate with the required from/to and an optional granularity', async () => {
    const calls = installFetchMock();
    await getConsultationAggregate({ from: '2026-04-06', to: '2026-07-05' });
    await getConsultationAggregate({ from: '2026-01-01', to: '2026-06-30', granularity: 'month' });
    await getConsultationAggregate({ from: '2026-06-28', to: '2026-07-05', granularity: 'day' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/consultations/aggregate?from=2026-04-06&to=2026-07-05',
      'GET /api/hope/admin/consultations/aggregate?from=2026-01-01&to=2026-06-30&granularity=month',
      'GET /api/hope/admin/consultations/aggregate?from=2026-06-28&to=2026-07-05&granularity=day',
    ]);
  });

  it('fetches the read-only detail by id', async () => {
    const calls = installFetchMock();
    await getConsultation('c_9f2ka7');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/consultations/c_9f2ka7']);
  });
});

describe('visitTypeOf', () => {
  it('derives new vs revisit from parentConsultationId (the aggregate DTO semantics)', () => {
    expect(visitTypeOf({ parentConsultationId: undefined })).toBe('new');
    expect(visitTypeOf({ parentConsultationId: 'c-parent' })).toBe('revisit');
  });
});
