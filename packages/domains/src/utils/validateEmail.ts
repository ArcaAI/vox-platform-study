// Regular expression pattern to validate an email address
const emailPattern =
    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z0-9](?!.*--)[a-zA-Z0-9-]*[a-zA-Z0-9])+\.)+[a-zA-Z]{2,63})$/;

/**
 * Validates whether the provided string is a properly formatted email address.
 *
 * This function uses a regular expression pattern to match a variety of
 * valid email formats, ensuring that the input string adheres to
 * standard email address rules.
 *
 * @param {string} email - The email address to validate.
 * @returns {boolean} - True if the email address is valid, otherwise false.
 *
 * @example
 * // Example usage:
 * const validEmail = validateEmail("test@example.com");
 * console.log("Is 'test@example.com' a valid email?", validEmail); // Output: true
 *
 * const invalidEmail = validateEmail("invalid-email");
 * console.log("Is 'invalid-email' a valid email?", invalidEmail); // Output: false
 */
export function validateEmail(email: string): boolean {
    return emailPattern.test(email);
}
