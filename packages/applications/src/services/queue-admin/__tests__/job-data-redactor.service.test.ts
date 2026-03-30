import { describe, it, expect, beforeEach } from 'vitest';
import { JobDataRedactorService } from '../job-data-redactor.service';

describe('JobDataRedactorService', () => {
  let service: JobDataRedactorService;

  beforeEach(() => {
    service = new JobDataRedactorService();
  });

  describe('redact', () => {
    it('should return the data unchanged when no sensitive fields are present', () => {
      const data = { jobName: 'test', retryCount: 3 };
      const result = service.redact(data, 'SomeQueue');

      expect(result).toEqual({ jobName: 'test', retryCount: 3 });
    });

    it('should return the input as-is when data is null', () => {
      const result = service.redact(null as any, 'SomeQueue');
      expect(result).toBeNull();
    });

    it('should return the input as-is when data is not an object', () => {
      const result = service.redact('string' as any, 'SomeQueue');
      expect(result).toBe('string');
    });

    describe('field-name matching', () => {
      it('should redact fields matching "password"', () => {
        const data = { password: 'secret123', username: 'admin' };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({ password: '[REDACTED]', username: 'admin' });
      });

      it('should redact fields matching "token" (case-insensitive)', () => {
        const data = { accessToken: 'abc', refreshToken: 'xyz', status: 'ok' };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          accessToken: '[REDACTED]',
          refreshToken: '[REDACTED]',
          status: 'ok',
        });
      });

      it('should redact fields matching "apiKey" and "api_key"', () => {
        const data = { apiKey: 'key1', api_key: 'key2', name: 'svc' };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          apiKey: '[REDACTED]',
          api_key: '[REDACTED]',
          name: 'svc',
        });
      });

      it('should redact fields matching "ssn" and "socialSecurity"', () => {
        const data = { ssn: '123-45-6789', socialSecurityNumber: '987654321' };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          ssn: '[REDACTED]',
          socialSecurityNumber: '[REDACTED]',
        });
      });

      it('should redact fields matching medical identifiers (mrn, patientName, doctorName)', () => {
        const data = { mrn: 'MRN-001', patientName: 'John Doe', doctorName: 'Dr. Smith' };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          mrn: '[REDACTED]',
          patientName: '[REDACTED]',
          doctorName: '[REDACTED]',
        });
      });

      it('should redact "dateOfBirth" and "dob"', () => {
        const data = { dateOfBirth: '1990-01-01', dob: '1990-01-01', age: 36 };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          dateOfBirth: '[REDACTED]',
          dob: '[REDACTED]',
          age: 36,
        });
      });

      it('should redact "authorization" and "credential"', () => {
        const data = { authorization: 'Bearer xxx', credential: 'cert-data' };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          authorization: '[REDACTED]',
          credential: '[REDACTED]',
        });
      });

      it('should redact "secret" fields', () => {
        const data = { clientSecret: 'sec_abc', publicKey: 'pk_abc' };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          clientSecret: '[REDACTED]',
          publicKey: 'pk_abc',
        });
      });
    });

    describe('nested object traversal', () => {
      it('should redact sensitive keys in nested objects', () => {
        const data = {
          config: {
            apiKey: 'key123',
            endpoint: 'https://api.example.com',
          },
        };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          config: {
            apiKey: '[REDACTED]',
            endpoint: 'https://api.example.com',
          },
        });
      });

      it('should redact sensitive keys deeply nested', () => {
        const data = {
          level1: {
            level2: {
              level3: {
                password: 'deep-secret',
                visible: true,
              },
            },
          },
        };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          level1: {
            level2: {
              level3: {
                password: '[REDACTED]',
                visible: true,
              },
            },
          },
        });
      });
    });

    describe('array traversal', () => {
      it('should redact sensitive keys within array objects', () => {
        const data = {
          users: [
            { name: 'Alice', ssn: '111-22-3333' },
            { name: 'Bob', ssn: '444-55-6666' },
          ],
        };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          users: [
            { name: 'Alice', ssn: '[REDACTED]' },
            { name: 'Bob', ssn: '[REDACTED]' },
          ],
        });
      });

      it('should redact string values in arrays that match PII patterns', () => {
        const data = { ids: ['normal-text', '123-45-6789'] };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          ids: ['normal-text', '[REDACTED]'],
        });
      });

      it('should leave non-string, non-object array items unchanged', () => {
        const data = { counts: [1, 2, 3] };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({ counts: [1, 2, 3] });
      });
    });

    describe('value-pattern matching', () => {
      it('should redact string values matching SSN format (###-##-####)', () => {
        const data = { note: 'Patient SSN is 123-45-6789 for records' };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({ note: '[REDACTED]' });
      });

      it('should redact 9-digit numeric strings (SSN without dashes)', () => {
        const data = { identifier: '123456789' };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({ identifier: '[REDACTED]' });
      });

      it('should not redact shorter or longer digit-only strings', () => {
        const data = { short: '12345678', long: '1234567890' };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({ short: '12345678', long: '1234567890' });
      });
    });

    describe('size truncation', () => {
      it('should truncate strings longer than 500 chars in detail mode', () => {
        const longText = 'a'.repeat(600);
        const data = { description: longText };
        const result = service.redact(data, 'SomeQueue', 'detail');

        expect(result.description).toBe('a'.repeat(500) + '...[TRUNCATED]');
      });

      it('should truncate strings longer than 200 chars in list mode', () => {
        const longText = 'b'.repeat(300);
        const data = { description: longText };
        const result = service.redact(data, 'SomeQueue', 'list');

        expect(result.description).toBe('b'.repeat(200) + '...[TRUNCATED]');
      });

      it('should not truncate strings within the limit', () => {
        const shortText = 'hello world';
        const data = { description: shortText };
        const result = service.redact(data, 'SomeQueue', 'detail');

        expect(result.description).toBe('hello world');
      });

      it('should default to detail mode when mode is not specified', () => {
        const text = 'c'.repeat(400);
        const data = { description: text };
        const result = service.redact(data, 'SomeQueue');

        expect(result.description).toBe(text);
      });
    });

    describe('queue-specific rules', () => {
      it('should redact "body" and "subject" for SendEmail queue', () => {
        const data = {
          fromEmailAddressId: 'addr-1',
          subject: 'Your appointment with Dr. Smith',
          body: '<p>Dear patient, your lab results are...</p>',
          recipientEmailAddressId: 'addr-2',
        };
        const result = service.redact(data, 'SendEmail');

        expect(result).toEqual({
          fromEmailAddressId: 'addr-1',
          subject: '[REDACTED]',
          body: '[REDACTED]',
          recipientEmailAddressId: 'addr-2',
        });
      });

      it('should redact "message" for SendSms queue', () => {
        const data = {
          fromPhoneNumberId: 'phone-1',
          message: 'Your prescription is ready',
          recipientPhoneNumberId: 'phone-2',
        };
        const result = service.redact(data, 'SendSms');

        expect(result).toEqual({
          fromPhoneNumberId: 'phone-1',
          message: '[REDACTED]',
          recipientPhoneNumberId: 'phone-2',
        });
      });

      it('should redact "textSamples" for GenerateDnaReport queue', () => {
        const data = {
          userId: 'user-1',
          textSamples: ['Clinical note 1', 'Clinical note 2'],
          reportType: 'full',
        };
        const result = service.redact(data, 'GenerateDnaReport');

        expect(result).toEqual({
          userId: 'user-1',
          textSamples: '[REDACTED]',
          reportType: 'full',
        });
      });

      it('should not apply queue-specific rules for unregistered queues', () => {
        const data = {
          body: 'This is visible for AuditLog queue',
          subject: 'Audit subject',
        };
        const result = service.redact(data, 'AuditLog');

        expect(result).toEqual({
          body: 'This is visible for AuditLog queue',
          subject: 'Audit subject',
        });
      });
    });

    describe('combined strategies', () => {
      it('should apply both queue-specific and field-name rules', () => {
        const data = {
          subject: 'Appointment reminder',
          body: '<p>Hello</p>',
          password: 'admin123',
          retryCount: 2,
        };
        const result = service.redact(data, 'SendEmail');

        expect(result).toEqual({
          subject: '[REDACTED]',
          body: '[REDACTED]',
          password: '[REDACTED]',
          retryCount: 2,
        });
      });

      it('should apply value-pattern matching after queue-specific and key rules', () => {
        const data = {
          reference: '987-65-4321',
          note: 'Normal note text',
        };
        const result = service.redact(data, 'SomeQueue');

        expect(result).toEqual({
          reference: '[REDACTED]',
          note: 'Normal note text',
        });
      });
    });
  });
});
