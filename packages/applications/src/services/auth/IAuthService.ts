import { OAuthUserResponse } from './dto';
import { CreateOAuthUserRequest } from '../user/user/dto';

/**
 * Authentication tracking data
 */
export interface AuthenticationTrackingData {
  ip: string;
  userAgent: string;
  endpoint: string;
  method: string;
}

/**
 * User validation response
 */
export interface UserValidationResponse {
  id: string;
  email: string;
  isActive: boolean;
  departmentId?: string;
  lastLoginAt?: Date;
}

/**
 * IAuthService is an interface that defines the authentication service methods.
 * It provides a contract for implementing authentication-related functionalities.
 */
export interface IAuthService {
  /**
   * Retrieves an existing OpenID Connect (OIDC) user or creates a new one
   * based on the provided request.
   *
   * @param request - The request object containing the necessary data to create or retrieve the OIDC user.
   * @returns A promise that resolves to an OAuthUserResponse object, which contains the user's information.
   */
  getOrCreateOidcUser(request: CreateOAuthUserRequest): Promise<OAuthUserResponse>;

  /**
   * Check if a JWT token has been revoked
   * @param tokenId - The JWT token ID (jti claim)
   * @returns Promise<boolean> - true if token is revoked, false otherwise
   */
  isTokenRevoked(tokenId: string): Promise<boolean>;

  /**
   * Validate a user by ID and return user information
   * @param userId - The user ID to validate
   * @returns Promise<UserValidationResponse | null> - User data if valid, null otherwise
   */
  validateUser(userId: string): Promise<UserValidationResponse | null>;

  /**
   * Track successful authentication for audit purposes
   * @param userId - The authenticated user ID
   * @param trackingData - Additional tracking information
   * @returns Promise<void>
   */
  trackAuthentication(userId: string, trackingData: AuthenticationTrackingData): Promise<void>;
}

/**
 * A unique symbol used to identify the IAuthService interface in dependency injection.
 */
export const IAuthService = Symbol('IAuthService');
