import jwt from 'jsonwebtoken';
import { config } from 'dotenv';
import { resolve } from 'path';
import ms from 'ms';
import { DevUser, getDevUser, getDefaultUser, getAvailableUsernames } from './users';

// Load environment variables from .env file in workspace root
const workspaceRoot = resolve(process.cwd(), '../..');
config({ path: resolve(workspaceRoot, '.env') });

/**
 * JWT Payload structure matching the API's expected format
 */
export interface JwtPayload {
  sub: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  tenantId: string | null;
  roles: string[];
  isServiceAccount: boolean;
  iat: number;
  exp?: number;
}

export interface GenerateTokenOptions {
  username: string;
  expires: string;
  print?: boolean;
  /** Override tenant ID (useful for testing tenant-specific access) */
  tenantId?: string;
  /** Override roles (useful for testing specific role combinations) */
  roles?: string[];
}

export interface TokenResult {
  token: string;
  payload: JwtPayload;
}

/**
 * Validate JWT secret meets minimum security requirements
 */
function validateJwtSecret(secret: string): void {
  if (secret.length < 32) {
    console.warn('\x1b[33m⚠ Warning: JWT_SECRET_KEY is less than 32 characters. ' + 'Consider using a stronger secret for better security.\x1b[0m');
  }
}

/**
 * Generate a development JWT token for testing
 *
 * @param options - Token generation options
 * @returns Token and decoded payload
 * @throws Error if JWT_SECRET_KEY is not set or user not found
 *
 * @example
 * ```typescript
 * const { token, payload } = await generateDevToken({
 *   username: 'super_admin',
 *   expires: '24h',
 * });
 * ```
 */
export async function generateDevToken(options: GenerateTokenOptions): Promise<TokenResult> {
  const { username, expires, tenantId, roles } = options;

  // Get JWT secret from environment variable
  const jwtSecret = process.env.JWT_SECRET_KEY;
  if (!jwtSecret) {
    throw new Error(
      'JWT_SECRET_KEY not found in environment variables.\n' + 'Please ensure your .env file in the workspace root contains JWT_SECRET_KEY.',
    );
  }

  validateJwtSecret(jwtSecret);

  // Get user from predefined list
  const user: DevUser | undefined = getDevUser(username);

  if (!user) {
    const available = getAvailableUsernames().join(', ');
    throw new Error(
      `User "${username}" not found.\n` + `Available users: ${available}\n\n` + 'To add more users, update packages/tools/src/gen-dev-token/users.ts',
    );
  }

  // Apply overrides if provided
  const effectiveUser: DevUser = {
    ...user,
    tenantId: tenantId !== undefined ? tenantId : user.tenantId,
    roles: roles !== undefined ? roles : user.roles,
  };

  // Create token payload
  const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
    sub: effectiveUser.id,
    username: effectiveUser.username,
    email: effectiveUser.email,
    firstName: effectiveUser.firstName,
    lastName: effectiveUser.lastName,
    tenantId: effectiveUser.tenantId,
    roles: effectiveUser.roles,
    isServiceAccount: effectiveUser.isServiceAccount,
  };

  // Sign the token
  const token = jwt.sign(payload, jwtSecret, { expiresIn: expires as ms.StringValue });

  // Decode the token to get the full payload with timestamps
  const decoded = jwt.decode(token) as JwtPayload;

  return {
    token,
    payload: decoded,
  };
}

// Re-export user utilities for CLI
export { getAvailableUsernames, getDevUser, getDefaultUser };
