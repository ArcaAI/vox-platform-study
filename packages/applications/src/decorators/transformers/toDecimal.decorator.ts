import { Transform } from 'class-transformer';
import { Decimal } from 'decimal.js';

/**
 * A custom transformer that converts a plain object value to a Decimal (decimal.js) instance.
 * It uses the class-transformer's Transform decorator.
 */
export function ToDecimal() {
  return Transform(({ value }) => {
    if (value instanceof Decimal) {
      return value.toNumber();
    }
    return value;
  });
}
