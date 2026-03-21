import { validateVietnamesePhoneNumber } from './validateVietnamesePhoneNumber';
import { describe, it, expect } from 'vitest';

describe('validateVietnamesePhoneNumber', () => {
    it('should return true for valid Vietnamese mobile numbers', () => {
        const validMobileNumbers = [
            '0912345678',
            '0912 345 678',
            '+84912345678',
            '+84 912 345 678',
            '0312345678',
            '0512345678',
            '0712345678',
            '0812345678',
            '0912345678',
        ];

        validMobileNumbers.forEach((number) => {
            expect(validateVietnamesePhoneNumber(number)).toBe(true);
        });
    });

    it('should return true for valid Vietnamese landline numbers', () => {
        const validLandlineNumbers = [
            '0212345678',
            '02 1234 5678',
            '+84212345678',
            '+84 21 234 5678',
            '02838235789',
            '028 3823 5789',
            '+842838235789',
            '+84 28 3823 5789',
            '02438235789',
            '024 3823 5789',
        ];

        validLandlineNumbers.forEach((number) => {
            expect(validateVietnamesePhoneNumber(number)).toBe(true);
        });
    });

    it('should return false for invalid Vietnamese phone numbers', () => {
        const invalidNumbers = [
            '123456',
            '0912',
            '0912 345 67',
            '+84912 345 67',
            '0123456789',
            '01 1234 5678',
            '+840912345678',
            '0912 3456 7890',
            '+8491234567890',
        ];

        invalidNumbers.forEach((number) => {
            expect(validateVietnamesePhoneNumber(number)).toBe(false);
        });
    });

    it('should return false for non-Vietnamese phone numbers', () => {
        const nonVietnameseNumbers = [
            '+441632960961', // UK number
            '+15551234567', // US number
            '07123456789', // UK mobile number
            '+61412345678', // Australian number
        ];

        nonVietnameseNumbers.forEach((number) => {
            expect(validateVietnamesePhoneNumber(number)).toBe(false);
        });
    });
});
