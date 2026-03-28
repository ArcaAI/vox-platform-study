/* eslint-disable @typescript-eslint/no-require-imports */
import jwt = require('jsonwebtoken');

export function authenticateJwt(token: string, secretKey?: string) {
  try {
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    const jwtSecret = secretKey || process.env['JWT_SECRET_KEY'] || 'secret';
    const decoded = jwt.verify(token, jwtSecret);
    return decoded;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (error) {
    throw new Error('Not Authorized');
  }
}
