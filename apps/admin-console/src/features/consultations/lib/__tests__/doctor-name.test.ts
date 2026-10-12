import { describe, expect, it } from 'vitest';
import { doctorDisplayName } from '../doctor-name';

describe('doctorDisplayName', () => {
  it('prefers first + last name', () => {
    expect(doctorDisplayName({ id: 'd', username: 'dr.a', firstName: 'Asha', lastName: 'Nair' })).toEqual({ label: 'Asha Nair', secondary: 'dr.a' });
  });
  it('labels auto-provisioned usernames', () => {
    expect(doctorDisplayName({ id: 'd', username: 'auto_1234' })).toEqual({ label: 'Auto-provisioned clinician', secondary: 'auto_1234' });
  });
  it('falls back to the username', () => {
    expect(doctorDisplayName({ id: 'd', username: 'dr.b' })).toEqual({ label: 'dr.b' });
  });
  it('returns null without a doctor', () => {
    expect(doctorDisplayName(undefined)).toBeNull();
  });
});
