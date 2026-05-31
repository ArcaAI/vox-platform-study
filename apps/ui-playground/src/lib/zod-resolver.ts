import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

type ZodSchema = z.ZodType<unknown>;

export function zodResolver<T extends FieldValues>(schema: ZodSchema): Resolver<T> {
  return async (values) => {
    const result = schema.safeParse(values);

    if (result.success) {
      return { values: result.data as T, errors: {} };
    }

    const fieldErrors: FieldErrors<T> = {};
    for (const issue of result.error!.issues) {
      const path = issue.path.join('.');
      if (path && !(path in fieldErrors)) {
        (fieldErrors as Record<string, unknown>)[path] = {
          type: issue.code ?? 'validation',
          message: issue.message,
        };
      }
    }

    // react-hook-form's ResolverError requires `values: {}` (empty), not `T`.
    return { values: {}, errors: fieldErrors };
  };
}
