/**
 * Converts a JavaScript Date object to a Unix timestamp.
 *
 * @param date - A JavaScript Date object representing a specific point in time.
 * @returns The Unix timestamp as a number, representing seconds since January 1, 1970.
 * @throws Will throw an error if the provided value is not a valid Date object.
 */
export function convertDateToUnixTimestamp(date: Date): number {
    // Ensure the provided input is a valid Date object
    if (!(date instanceof Date) || isNaN(date.getTime())) {
        throw new Error('Invalid Date object provided.');
    }

    // Convert the date to milliseconds since epoch, then to seconds
    return Math.floor(date.getTime() / 1000);
}
