import { Injectable } from '@nestjs/common';
import { JobQueue } from '@arcaai/domains';

@Injectable()
export class JobDataRedactorService {
  private static readonly REDACTED = '[REDACTED]';
  private static readonly TRUNCATED_SUFFIX = '...[TRUNCATED]';

  private static readonly SENSITIVE_KEY_PATTERNS: RegExp[] = [
    /password/i,
    /secret/i,
    /token/i,
    /apikey/i,
    /api[-_]?key/i,
    /authorization/i,
    /credential/i,
    /ssn/i,
    /social[-_]?security/i,
    /date[-_]?of[-_]?birth/i,
    /dob/i,
    /mrn/i,
    /medical[-_]?record/i,
    /patient[-_]?name/i,
    /doctor[-_]?name/i,
  ];

  private static readonly SENSITIVE_VALUE_PATTERNS: RegExp[] = [
    /\b\d{3}-\d{2}-\d{4}\b/,
    /\b\d{9}\b/,
  ];

  private static readonly QUEUE_SPECIFIC_RULES: Record<string, string[]> = {
    [JobQueue.SendEmail]: ['body', 'subject'],
    [JobQueue.SendSms]: ['message'],
    [JobQueue.GenerateDnaReport]: ['textSamples'],
  };

  redact(
    data: Record<string, unknown>,
    queueName: string,
    mode: 'detail' | 'list' = 'detail',
  ): Record<string, unknown> {
    if (!data || typeof data !== 'object') return data;

    const queueFields = new Set(
      JobDataRedactorService.QUEUE_SPECIFIC_RULES[queueName] ?? [],
    );
    const maxValueLength = mode === 'list' ? 200 : 500;

    return this.redactObject(data, queueFields, maxValueLength);
  }

  private redactObject(
    obj: Record<string, unknown>,
    queueFields: Set<string>,
    maxValueLength: number,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (queueFields.has(key)) {
        result[key] = JobDataRedactorService.REDACTED;
        continue;
      }

      if (this.isSensitiveKey(key)) {
        result[key] = JobDataRedactorService.REDACTED;
        continue;
      }

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.redactObject(
          value as Record<string, unknown>,
          queueFields,
          maxValueLength,
        );
        continue;
      }

      if (Array.isArray(value)) {
        result[key] = value.map((item) => {
          if (item !== null && typeof item === 'object') {
            return this.redactObject(
              item as Record<string, unknown>,
              queueFields,
              maxValueLength,
            );
          }
          if (typeof item === 'string') {
            return this.redactStringValue(item, maxValueLength);
          }
          return item;
        });
        continue;
      }

      if (typeof value === 'string') {
        result[key] = this.redactStringValue(value, maxValueLength);
        continue;
      }

      result[key] = value;
    }

    return result;
  }

  private isSensitiveKey(key: string): boolean {
    return JobDataRedactorService.SENSITIVE_KEY_PATTERNS.some((pattern) =>
      pattern.test(key),
    );
  }

  private redactStringValue(value: string, maxLength: number): string {
    for (const pattern of JobDataRedactorService.SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        return JobDataRedactorService.REDACTED;
      }
    }

    if (value.length > maxLength) {
      return (
        value.substring(0, maxLength) +
        JobDataRedactorService.TRUNCATED_SUFFIX
      );
    }

    return value;
  }
}
