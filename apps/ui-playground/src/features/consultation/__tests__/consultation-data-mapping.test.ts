import { describe, it, expect } from 'vitest';

interface DoctorInfo {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
}

interface DepartmentInfo {
  id: string;
  code?: string;
  name?: string;
}

interface ConsultationLike {
  doctorName?: string;
  department?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  doctor?: DoctorInfo;
}

function getDoctorDisplayName(c: ConsultationLike): string | undefined {
  if (c.doctorName) return c.doctorName;
  const doc = (c as Record<string, unknown>).doctor as DoctorInfo | undefined;
  if (!doc) return undefined;
  const parts = [doc.firstName, doc.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : doc.username;
}

function getDepartmentDisplayName(c: ConsultationLike): string | undefined {
  if (typeof c.department === 'string') return c.department;
  const dept = (c as Record<string, unknown>).department as DepartmentInfo | undefined;
  if (!dept) return undefined;
  return dept.name || dept.code || undefined;
}

function getConsultationStatus(c: ConsultationLike): string | undefined {
  if (c.status) return c.status;
  const meta = c.metadata as Record<string, unknown> | undefined;
  return (meta?.status as string) ?? undefined;
}

describe('Consultation Data Mapping', () => {
  describe('getDoctorDisplayName', () => {
    it('should return doctorName when present (SDK flat format)', () => {
      expect(getDoctorDisplayName({ doctorName: 'Dr. Smith' })).toBe('Dr. Smith');
    });

    it('should return full name from nested doctor object (API format)', () => {
      const c = {
        doctor: { id: 'd1', username: 'doctor', firstName: 'John', lastName: 'Smith' },
      };
      expect(getDoctorDisplayName(c as ConsultationLike)).toBe('John Smith');
    });

    it('should return first name only when last name is missing', () => {
      const c = {
        doctor: { id: 'd1', username: 'doctor', firstName: 'John' },
      };
      expect(getDoctorDisplayName(c as ConsultationLike)).toBe('John');
    });

    it('should fall back to username when no first/last name', () => {
      const c = {
        doctor: { id: 'd1', username: 'doctor_user' },
      };
      expect(getDoctorDisplayName(c as ConsultationLike)).toBe('doctor_user');
    });

    it('should return undefined when no doctor info at all', () => {
      expect(getDoctorDisplayName({})).toBeUndefined();
    });

    it('should prefer doctorName over nested doctor object', () => {
      const c = {
        doctorName: 'Flat Name',
        doctor: { id: 'd1', username: 'nested', firstName: 'Nested', lastName: 'Name' },
      };
      expect(getDoctorDisplayName(c as ConsultationLike)).toBe('Flat Name');
    });
  });

  describe('getDepartmentDisplayName', () => {
    it('should return department string when present (SDK flat format)', () => {
      expect(getDepartmentDisplayName({ department: 'Cardiology' })).toBe('Cardiology');
    });

    it('should return name from nested department object (API format)', () => {
      const c = { department: { id: 'dept-1', code: 'CARD', name: 'Cardiology' } };
      expect(getDepartmentDisplayName(c as unknown as ConsultationLike)).toBe('Cardiology');
    });

    it('should fall back to code when name is missing', () => {
      const c = { department: { id: 'dept-1', code: 'CARD' } };
      expect(getDepartmentDisplayName(c as unknown as ConsultationLike)).toBe('CARD');
    });

    it('should return undefined when department has no name or code', () => {
      const c = { department: { id: 'dept-1' } };
      expect(getDepartmentDisplayName(c as unknown as ConsultationLike)).toBeUndefined();
    });

    it('should return undefined when no department at all', () => {
      expect(getDepartmentDisplayName({})).toBeUndefined();
    });
  });

  describe('getConsultationStatus', () => {
    it('should return status when directly present', () => {
      expect(getConsultationStatus({ status: 'OPEN' })).toBe('OPEN');
    });

    it('should extract status from metadata when status field is missing', () => {
      const c = { metadata: { status: 'CLOSED' } };
      expect(getConsultationStatus(c)).toBe('CLOSED');
    });

    it('should prefer direct status over metadata status', () => {
      const c = { status: 'OPEN', metadata: { status: 'CLOSED' } };
      expect(getConsultationStatus(c)).toBe('OPEN');
    });

    it('should return undefined when no status anywhere', () => {
      expect(getConsultationStatus({})).toBeUndefined();
    });

    it('should return undefined when metadata exists but has no status', () => {
      expect(getConsultationStatus({ metadata: { other: 'value' } })).toBeUndefined();
    });
  });
});
