/* eslint-disable @typescript-eslint/no-explicit-any */
import { convertEntityValue } from '../utils';

/**
 * Converts the instance of a class to a plain object.
 * This method iterates over the properties of the instance,
 * removes leading underscores from property names,
 * applies a conversion function to each property's value,
 * and returns a new object with the modified property names and values.
 * The returned object is immutable.
 */
export function toObject(target: any): object {
    // Create an empty object to store the properties
    const obj: Record<string, any> = {};

    // Iterate over each property key of the current instance
    Object.keys(target).forEach((key) => {
        let actualKey = key;

        // Check if the key starts with an underscore
        if (key.startsWith('_')) {
            // Remove the underscore prefix from the key
            actualKey = key.substring(1);
        }

        // Get the value of the property using the (possibly modified) key
        const value = (target as any)[key];

        // Assign the (possibly modified) key-value pair to the new object
        obj[actualKey] = convertEntityValue(value);
    });

    // Freeze the object to make it immutable and return it
    return Object.freeze(obj);
}
