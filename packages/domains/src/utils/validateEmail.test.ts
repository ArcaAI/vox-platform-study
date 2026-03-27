import { validateEmail } from './validateEmail';
import { describe, it, expect } from 'vitest';

describe('validateEmail', () => {
  it('should return true for valid email addresses', () => {
    const validEmails = [
      'test@example.com',
      'user.name+tag+sorting@example.com',
      'user-name@example.co.uk',
      'user_name@example.co.in',
      'user@sub.example.com',
      'user123@example123.com',
      'user.name@example.museum',
      'user.name@example.travel',
      'user+name@example.email',
    ];

    validEmails.forEach((email) => {
      expect(validateEmail(email)).toBe(true);
    });
  });

  it('should return false for invalid email addresses', () => {
    const invalidEmails = [
      'plainaddress',
      '@missingusername.com',
      'username@.com',
      'username@.com.',
      'username@domain..com',
      'username@domain',
      'username@domain.c',
      'username@domain,com',
      'username@domain..com',
      'username@domain..com',
      'username@-domain.com',
      'username@domain-.com',
    ];

    invalidEmails.forEach((email) => {
      expect(validateEmail(email)).toBe(false);
    });
  });
});
