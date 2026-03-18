/* eslint-disable @typescript-eslint/no-explicit-any */
import { convertEntityValue } from '../utils';

/**
 * Converts the instance of a class to a plain object.
 * This method iterates over the properties of the instance,
 * applies a conversion function to each property's value,
 * and returns a new object with the same property names and values.
 * The returned object is immutable.
 */
export function toRawObject(target: any): object {
    // Create an empty object to store the properties
    const obj: Record<string, any> = {};

    // Iterate over each property key of the current instance
    Object.keys(target).forEach((key) => {
        // Get the value of the property using the key
        const value = (target as any)[key];

        // Assign the key-value pair to the new object
        obj[key] = convertEntityValue(value);
    });

    // Freeze the object to make it immutable and return it
    return Object.freeze(obj);
}
