// Regular expression pattern to validate a Vietnamese phone number
// The pattern allows for formats like:
// - Mobile: 03XX XXX XXX, 05X XXX XXXX, 07X XXX XXXX, 08X XXX XXXX, 09X XXX XXXX
// - Landline: 02XX XXX XXX (Hanoi), 028X XXX XXX (Ho Chi Minh City), 0XXX XXX XXX (other areas)
// - International format: +84 followed by the number without the leading 0
//
// Vietnamese mobile prefixes: 03, 05, 07, 08, 09
// Vietnamese landline prefix: 02
// Total digits after prefix: 8-9 digits
const vietnamesePhonePattern = /^(\+84|0)(2[0-9]{8,9}|[35789][0-9]{8})$/;

/**
 * Validates whether the provided string is a properly formatted Vietnamese phone number.
 *
 * This function uses a regular expression pattern to match various
 * formats of Vietnamese phone numbers, including mobile and landline.
 *
 * The valid formats include:
 * - Mobile: `03XX XXX XXX`, `05X XXX XXXX`, `07X XXX XXXX`, `08X XXX XXXX`, `09X XXX XXXX`
 * - Landline: `02XX XXX XXX` (Hanoi), `028X XXX XXX` (Ho Chi Minh City), `0XXX XXX XXX` (other areas)
 * - International format: `+84XXXXXXXXX` or `+84XXXXXXXXXX`
 *
 * @param {string} phoneNumber - The phone number to validate.
 * @returns {boolean} - True if the phone number is valid, otherwise false.
 *
 * @example
 * // Example usage:
 * const validMobile = validateVietnamesePhoneNumber("0912 345 678");
 * console.log("Is '0912 345 678' a valid Vietnamese phone number?", validMobile); // Output: true
 *
 * const validLandline = validateVietnamesePhoneNumber("028 3823 5789");
 * console.log("Is '028 3823 5789' a valid Vietnamese phone number?", validLandline); // Output: true
 *
 * const validInternationalMobile = validateVietnamesePhoneNumber("+84912 345 678");
 * console.log("Is '+84912 345 678' a valid Vietnamese phone number?", validInternationalMobile); // Output: true
 *
 * const invalidNumber = validateVietnamesePhoneNumber("123 456");
 * console.log("Is '123 456' a valid Vietnamese phone number?", invalidNumber); // Output: false
 */
export function validateVietnamesePhoneNumber(phoneNumber: string): boolean {
    // Remove any spaces to ensure a consistent validation pattern
    const normalizedPhoneNumber = phoneNumber.replace(/\s+/g, '');

    return vietnamesePhonePattern.test(normalizedPhoneNumber);
}
