import { Decimal } from 'decimal.js';
import { ClassTransformOptions, instanceToPlain } from 'class-transformer';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function customInstanceToPlain(
    instance: any,
    options?: ClassTransformOptions,
): Record<string, any> {
    const transformDecimalToString = (obj: any) => {
        for (const key in obj) {
            if (obj[key] instanceof Decimal) {
                obj[key] = obj[key].toString();
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                transformDecimalToString(obj[key]);
            }
        }
    };

    transformDecimalToString(instance);
    return instanceToPlain(instance, options);
}
