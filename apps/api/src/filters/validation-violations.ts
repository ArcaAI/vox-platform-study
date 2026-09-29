import { ValidationPipe, type ValidationError } from '@nestjs/common';

import { attachFailureLogContext } from './failure-log';

/**
 * One rejected field, as the failure line reports it: the dotted property
 * path (`child.name`, `items.0.code`) and the NAMES of the constraints it
 * failed (`isEmail`). Never the submitted value — a request body is where a
 * patient's name, MRN or note text arrives.
 */
export interface ValidationViolation {
  property: string;
  constraints: string[];
}

export function toViolations(errors: readonly ValidationError[], parentPath = ''): ValidationViolation[] {
  const out: ValidationViolation[] = [];
  for (const error of errors) {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const names = Object.keys(error.constraints ?? {});
    if (names.length > 0) out.push({ property: path, constraints: names });
    if (error.children && error.children.length > 0) out.push(...toViolations(error.children, path));
  }
  return out;
}

/**
 * The global validation pipe. Its CLIENT behaviour is exactly the stock pipe's
 * (same options, same flattened messages, which `ExceptionInterceptor` then
 * reshapes into the `VALIDATION.FAILED` envelope); the only addition is the
 * structured `violations` list attached to the exception for the failure line.
 */
class ViolationLoggingValidationPipe extends ValidationPipe {
  public override createExceptionFactory(): (errors: ValidationError[]) => unknown {
    const base = super.createExceptionFactory();
    return (errors: ValidationError[]) => attachFailureLogContext(base(errors), { violations: toViolations(errors) });
  }
}

export function createGlobalValidationPipe(): ValidationPipe {
  // Strict input validation: whitelist + forbidNonWhitelisted + forbidUnknownValues
  // rejects any DTO key not declared on the target class (mass-assignment
  // protection at the HTTP boundary).
  return new ViolationLoggingValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
}
