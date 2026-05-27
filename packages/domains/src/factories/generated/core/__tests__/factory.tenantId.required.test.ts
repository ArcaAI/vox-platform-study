/**
 * Factory tenantId-required regression tests — TASK-305 Phase A.9.
 *
 * Red-then-green proof that the schema-hardening work (A.0 → A.7) has
 * actually closed the "factory silently invents a tenantId" hole at
 * EVERY layer:
 *
 *   1. Compile-time (TS): the factory props interface refuses to
 *      construct an entity without `tenantId`.
 *   2. Runtime (validate()): even if a caller bypasses TypeScript
 *      (e.g. hydrating from an untyped Prisma row, `as any` cast,
 *      JS-only test fixture), `entity.validate()` throws.
 *
 * We pick `ConsultationFactory` and `AuditLogFactory` as representative
 * cases — Consultation is the PHI hot-path entity audit B11 flagged as
 * highest impact; AuditLog used to be the worst silent-default case
 * because of the NULL → '50000000-…' fallback chain that caused audit
 * rows to leak into the Global customer tenant on write.
 */

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ConsultationFactory } from '../ConsultationFactory';
import { AuditLogFactory } from '../AuditLogFactory';
import { AuditAction, ResourceType } from '../../../../enums';

const VALID_TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('Factory tenantId is structurally required (TASK-305 A.6 / A.9)', () => {
  describe('ConsultationFactory.CreateConsultation', () => {
    it('happily creates a consultation when tenantId is provided', () => {
      const consultation = ConsultationFactory.CreateConsultation({
        tenantId: VALID_TENANT_ID,
        patientId: 'patient-1',
        appointmentDate: new Date('2026-05-27T09:00:00Z'),
        doctorId: 'doctor-1',
      });

      expect(consultation.tenantId).toBe(VALID_TENANT_ID);
      expect(() => consultation.validate()).not.toThrow();
    });

    it('TS refuses to compile a CreateConsultation call without tenantId', () => {
      // @ts-expect-error — `tenantId` is now REQUIRED in
      // CreateConsultationProps (TASK-305 A.6). This line MUST fail to
      // compile; if it ever stops being a TS error, the @ts-expect-error
      // directive itself becomes a build failure — closing the loophole
      // permanently.
      ConsultationFactory.CreateConsultation({
        patientId: 'patient-1',
        appointmentDate: new Date('2026-05-27T09:00:00Z'),
        doctorId: 'doctor-1',
      });
    });

    it('validate() throws BadRequestException if tenantId is empty (runtime backstop)', () => {
      // Simulate a caller that bypasses TypeScript — e.g. an entity
      // hydrated from a manually-crafted Prisma row in a test fixture.
      const consultation = ConsultationFactory.CreateConsultation({
        tenantId: '' as never,
        patientId: 'patient-1',
        appointmentDate: new Date('2026-05-27T09:00:00Z'),
        doctorId: 'doctor-1',
      });

      expect(() => consultation.validate()).toThrow(BadRequestException);
      expect(() => consultation.validate()).toThrow(
        /ConsultationEntity is missing tenant context/,
      );
    });

    it('validate() throws when tenantId is null (runtime backstop)', () => {
      const consultation = ConsultationFactory.CreateConsultation({
        tenantId: null as unknown as string,
        patientId: 'patient-1',
        appointmentDate: new Date('2026-05-27T09:00:00Z'),
        doctorId: 'doctor-1',
      });

      expect(() => consultation.validate()).toThrow(BadRequestException);
    });
  });

  describe('AuditLogFactory.CreateAuditLog', () => {
    // Fully-populated baseline used by the happy-path test. AuditLog's
    // factory has a pre-existing quirk where the optional-but-validated
    // string fields (`responsibleUserId`, `responsibleIp`, `resourceId`)
    // default to `''` via `?? ''` and then fail the entity's "non-blank
    // when provided" guard. Passing valid values explicitly keeps this
    // test focused on the tenantId guard rather than the unrelated
    // blank-string default (out of scope for TASK-305 A).
    const validAuditLogProps = {
      responsibleUserId: '60000000-0000-0000-0000-000000000000',
      responsibleIp: '127.0.0.1',
      resourceType: ResourceType.Consultation,
      resourceId: 'consult-1',
      action: AuditAction.CREATE,
      data: { id: 'consult-1' },
      previousData: null,
    } as const;

    it('happily creates an audit log when tenantId is provided', () => {
      const auditLog = AuditLogFactory.CreateAuditLog({
        ...validAuditLogProps,
        tenantId: VALID_TENANT_ID,
      });

      expect(auditLog.tenantId).toBe(VALID_TENANT_ID);
      expect(() => auditLog.validate()).not.toThrow();
    });

    it('TS refuses to compile a CreateAuditLog call without tenantId', () => {
      // @ts-expect-error — `tenantId` is REQUIRED. Same closure as
      // the ConsultationFactory case above.
      AuditLogFactory.CreateAuditLog({
        ...validAuditLogProps,
      });
    });

    it('validate() throws if tenantId is empty (runtime backstop)', () => {
      const auditLog = AuditLogFactory.CreateAuditLog({
        ...validAuditLogProps,
        tenantId: '' as never,
      });

      expect(() => auditLog.validate()).toThrow(BadRequestException);
      expect(() => auditLog.validate()).toThrow(
        /AuditLogEntity is missing tenant context/,
      );
    });
  });
});
