import { registerDecorator, ValidationOptions, ValidationArguments } from 'class-validator';
import { Decimal } from 'decimal.js';

/**
 * A custom validator that checks if a value is a valid Decimal (decimal.js) instance.
 * It uses the class-validator's registerDecorator function.
 */
export function IsDecimal(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isDecimal',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        validate(value: any) {
          if (value instanceof Decimal) {
            return true;
          }
          try {
            new Decimal(value);
            return true;
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (error) {
            return false;
          }
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid decimal`;
        },
      },
    });
  };
}
