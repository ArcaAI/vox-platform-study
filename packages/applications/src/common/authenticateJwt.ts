/* eslint-disable @typescript-eslint/no-require-imports */
import jwt = require('jsonwebtoken');

export function authenticateJwt(token: string, secretKey?: string) {
    try {
        const jwtSecret = secretKey || process.env['JWT_SECRET_KEY'] || 'secret';
        const decoded = jwt.verify(token, jwtSecret);
        return decoded;
    } catch (error) {
        throw new Error('Not Authorized');
    }
}
