import type { ConsultationDoctor } from '../api/types';

export interface DoctorDisplay {
  label: string;
  /** The username, shown muted beside a label that is not the username itself. */
  secondary?: string;
}

const AUTO_PREFIX = 'auto_';

/** "first last"; an `auto_` username reads as an auto-provisioned clinician; otherwise the username. */
export function doctorDisplayName(doctor: ConsultationDoctor | undefined | null): DoctorDisplay | null {
  if (!doctor) return null;
  const fullName = [doctor.firstName, doctor.lastName].filter(Boolean).join(' ');
  if (fullName) return { label: fullName, secondary: doctor.username };
  if (doctor.username.startsWith(AUTO_PREFIX)) return { label: 'Auto-provisioned clinician', secondary: doctor.username };
  return { label: doctor.username };
}
