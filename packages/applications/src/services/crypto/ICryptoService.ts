export interface ICryptoService {
    /**
     * Hashes a password using a secure hashing algorithm
     * @param password - The plain text password to hash
     * @returns Promise containing the hashed password
     */
    hash(password: string): Promise<string>;

    /**
     * Verifies a password against its hash
     * @param password - The plain text password to verify
     * @param hash - The hash to verify against
     * @returns Promise containing boolean indicating if password matches
     */
    verify(password: string, hash: string): Promise<boolean>;

    /**
     * Encrypts data using a symmetric encryption algorithm
     * @param data - The data to encrypt
     * @param key - The encryption key
     * @returns Promise containing the encrypted data
     */
    encrypt(data: string, key: string): Promise<string>;

    /**
     * Decrypts data using a symmetric encryption algorithm
     * @param encryptedData - The data to decrypt
     * @param key - The decryption key
     * @returns Promise containing the decrypted data
     */
    decrypt(encryptedData: string, key: string): Promise<string>;
}

export const ICryptoService = Symbol('ICryptoService');
