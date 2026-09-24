/**
 * TASK-1004 §4.2 — the consultation DECLARES its spoken-language mode once, in the typed column
 * `Consultation.spokenLanguageMode`, and every later recording inherits it.
 *
 *  - `open` takes `languageMode` (preferred) or `language`, normalized at the edge; an unknown value
 *    is 400 `LANGUAGE_MODE_UNKNOWN` before anything is written; `auto` is a mode, not a 400.
 *  - `open` on an EXISTING consultation with an explicit, DIFFERENT mode updates it (audited
 *    `ResourceUpdated`) — the ALaaS repeat-`start` ask; the same mode, or none, writes nothing.
 *  - `PATCH consultations/:id { languageMode }` changes it under the house OCC.
 *  - the legacy `metadata.summaryLanguage` is still written for one release, and the response's
 *    `language` reads the column first.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException } from '@nestjs/common';
import { ResourceStatusType, SysEventType } from '@arcaai/domains';
import { ConsultationService } from '../consultation.service';
import { ConsultationDtoMapper } from '../consultation.dto.mapper';
import { OpenConsultationRequest } from '../dto/open-consultation.request';
import { UpdateConsultationRequest } from '../dto/update-consultation.request';
import { SUMMARY_LANGUAGE_METADATA_KEY, readSpokenLanguageMode } from '../summary-language';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ConsultationFactory: {
      CreateNewVisit: vi.fn((data) => ({ ...data, id: 'new-consultation-id', version: 1, createdAt: new Date(), updatedAt: new Date() })),
      CreateRevisit: vi.fn((data) => ({ ...data, id: 'new-revisit-id', version: 1, createdAt: new Date(), updatedAt: new Date() })),
    },
  };
});

const TENANT = 'tenant-1';

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'existing-1',
    tenantId: TENANT,
    patientId: 'p-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-09-24'),
    version: 4,
    status: 'OPEN',
    metadata: { [SUMMARY_LANGUAGE_METADATA_KEY]: 'en' },
    spokenLanguageMode: 'en',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMocks() {
  return {
    consultationRepository: {
      findByUniqueKey: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(null),
      findWithRelations: vi.fn().mockResolvedValue(null),
      create: vi.fn(async (entity: unknown) => entity),
      updateWithVersion: vi.fn(async (_id: string, entity: Record<string, unknown>) => ({ ...entity, version: Number(entity.version) + 1 })),
    },
    departmentRepository: { findById: vi.fn().mockResolvedValue({ id: 'dept-1', tenantId: TENANT }) },
    userRoleAssignmentRepository: {
      findFirst: vi.fn().mockResolvedValue({ id: 'ura-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }),
    },
    userDepartmentRepository: {
      findFirst: vi.fn().mockResolvedValue({ id: 'ud-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }),
    },
    userRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'doctor-1', isServiceAccount: false }) },
    eventEmitter: { emit: vi.fn() },
    clsService: {
      get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-id-1' } : null)),
      set: vi.fn(),
    },
  };
}

function makeService(m: ReturnType<typeof makeMocks>) {
  return new ConsultationService(
    m.consultationRepository as never,
    m.departmentRepository as never,
    m.userRoleAssignmentRepository as never,
    m.userDepartmentRepository as never,
    m.userRepository as never,
    m.eventEmitter as never,
    m.clsService as never,
  );
}

const created = (m: ReturnType<typeof makeMocks>) => m.consultationRepository.create.mock.calls[0]?.[0] as Record<string, unknown>;
const sysEvents = (m: ReturnType<typeof makeMocks>, type: SysEventType) =>
  m.eventEmitter.emit.mock.calls.filter(([name]) => name === type).map(([, payload]) => payload as Record<string, unknown>);

describe('open — declares the spoken-language mode on the typed column', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('stores `languageMode` on spokenLanguageMode AND (one release) the legacy metadata key', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1', languageMode: 'ml-en' } as never, 'doctor-1');
    expect(created(m).spokenLanguageMode).toBe('ml-en');
    expect(created(m).metadata).toMatchObject({ [SUMMARY_LANGUAGE_METADATA_KEY]: 'ml-en' });
  });

  it('normalizes `language` (a BCP-47 tag) to its mode', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1', language: 'en-US' } as never, 'doctor-1');
    expect(created(m).spokenLanguageMode).toBe('en');
  });

  it('`languageMode` wins over `language`', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1', language: 'en', languageMode: 'ml-en' } as never, 'doctor-1');
    expect(created(m).spokenLanguageMode).toBe('ml-en');
  });

  it('accepts `auto` — a mode, not a 400', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1', language: 'auto' } as never, 'doctor-1');
    expect(created(m).spokenLanguageMode).toBe('auto');
  });

  it('an unknown value is 400 LANGUAGE_MODE_UNKNOWN and nothing is written', async () => {
    await expect(makeService(m).getOrCreate({ patientId: 'p-1', language: 'fr-FR' } as never, 'doctor-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(m.consultationRepository.create).not.toHaveBeenCalled();
    expect(m.consultationRepository.findByUniqueKey).not.toHaveBeenCalled();
  });

  it('undeclared stays undeclared (null column, no legacy key)', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1' } as never, 'doctor-1');
    expect(created(m).spokenLanguageMode ?? null).toBeNull();
    expect((created(m).metadata as Record<string, unknown> | undefined)?.[SUMMARY_LANGUAGE_METADATA_KEY]).toBeUndefined();
  });
});

describe('open on an EXISTING consultation — an explicit, different mode updates it', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('updates spokenLanguageMode under OCC and audits ResourceUpdated', async () => {
    const row = existingRow();
    m.consultationRepository.findByUniqueKey.mockResolvedValue(row);

    await makeService(m).getOrCreate({ patientId: 'p-1', languageMode: 'ml-en' } as never, 'doctor-1');

    expect(m.consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    const [id, entity, expected] = m.consultationRepository.updateWithVersion.mock.calls[0]!;
    expect(id).toBe('existing-1');
    expect(expected).toBe(4);
    expect((entity as Record<string, unknown>).spokenLanguageMode).toBe('ml-en');
    expect((entity as Record<string, unknown>).metadata).toMatchObject({ [SUMMARY_LANGUAGE_METADATA_KEY]: 'ml-en' });
    const updates = sysEvents(m, SysEventType.ResourceUpdated);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ resourceId: 'existing-1', data: expect.objectContaining({ previous: 'en', next: 'ml-en' }) });
    expect(m.consultationRepository.create).not.toHaveBeenCalled();
  });

  it('the same mode (after normalization) writes nothing', async () => {
    m.consultationRepository.findByUniqueKey.mockResolvedValue(existingRow());
    await makeService(m).getOrCreate({ patientId: 'p-1', language: 'en-IN' } as never, 'doctor-1');
    expect(m.consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('no declaration writes nothing — the consultation keeps its own', async () => {
    m.consultationRepository.findByUniqueKey.mockResolvedValue(existingRow());
    await makeService(m).getOrCreate({ patientId: 'p-1' } as never, 'doctor-1');
    expect(m.consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a row that only carries the legacy key is compared on that key', async () => {
    m.consultationRepository.findByUniqueKey.mockResolvedValue(
      existingRow({ spokenLanguageMode: null, metadata: { [SUMMARY_LANGUAGE_METADATA_KEY]: 'ml-en' } }),
    );
    await makeService(m).getOrCreate({ patientId: 'p-1', languageMode: 'ml-en' } as never, 'doctor-1');
    expect(m.consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });
});

describe('PATCH consultations/:id { languageMode }', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
    m.consultationRepository.findWithRelations.mockResolvedValue(existingRow());
  });

  it('sets the column + legacy key and CASes on the If-Match version', async () => {
    const response = await makeService(m).updateConsultation('existing-1', { languageMode: 'ML-EN' } as never, 4);
    const [, entity, expected] = m.consultationRepository.updateWithVersion.mock.calls[0]!;
    expect(expected).toBe(4);
    expect((entity as Record<string, unknown>).spokenLanguageMode).toBe('ml-en');
    expect((entity as Record<string, unknown>).metadata).toMatchObject({ [SUMMARY_LANGUAGE_METADATA_KEY]: 'ml-en' });
    expect(response.language).toBe('ml-en');
    expect(sysEvents(m, SysEventType.ResourceUpdated)).toHaveLength(1);
  });

  it('an unknown mode is 400 LANGUAGE_MODE_UNKNOWN and nothing is written', async () => {
    await expect(makeService(m).updateConsultation('existing-1', { languageMode: 'xx' } as never, 4)).rejects.toBeInstanceOf(BadRequestException);
    expect(m.consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });
});

describe('the edge DTOs declare the new field (the global pipe runs forbidNonWhitelisted)', () => {
  const opts = { whitelist: true, forbidNonWhitelisted: true };

  it('OpenConsultationRequest accepts `languageMode`, and `language: auto`', async () => {
    const dto = plainToInstance(OpenConsultationRequest, { patientId: 'p-1', languageMode: 'ml-en', language: 'auto' });
    expect(await validate(dto, opts)).toEqual([]);
  });

  it('UpdateConsultationRequest accepts `{ languageMode }` alone', async () => {
    const dto = plainToInstance(UpdateConsultationRequest, { languageMode: 'ml-en' });
    expect(await validate(dto, opts)).toEqual([]);
  });
});

describe('readers go through the column first', () => {
  it('readSpokenLanguageMode: column wins, the legacy key is the fallback', () => {
    expect(readSpokenLanguageMode({ spokenLanguageMode: 'ml-en', metadata: { [SUMMARY_LANGUAGE_METADATA_KEY]: 'en' } })).toBe('ml-en');
    expect(readSpokenLanguageMode({ spokenLanguageMode: null, metadata: { [SUMMARY_LANGUAGE_METADATA_KEY]: 'en-IN' } })).toBe('en-IN');
    expect(readSpokenLanguageMode({ spokenLanguageMode: null, metadata: null })).toBeNull();
    expect(readSpokenLanguageMode(null)).toBeNull();
  });

  it('the response `language` reads the column', () => {
    const response = ConsultationDtoMapper.toResponse(existingRow({ spokenLanguageMode: 'auto', metadata: {} }) as never);
    expect(response.language).toBe('auto');
  });
});
