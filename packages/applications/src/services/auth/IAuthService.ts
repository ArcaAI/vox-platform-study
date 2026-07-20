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
 * IAuthService is an interface that defines the authentication service methods.
 * It provides a contract for implementing authentication-related functionalities.
 *
 * TASK-541 — `isTokenRevoked()`, `validateUser()` and the `UserValidationResponse`
 * shape were REMOVED here. Both methods existed solely for the `gateway-jwt`
 * strategy retired in this ticket (A2), leaving them with zero callers, and both
 * were actively misleading:
 *
 *  - `isTokenRevoked` was a façade over the real authority. Revocation is owned by
 *    `IJwtRevocationService` (Redis-backed, consulted by `JwtStrategy` under
 *    `UnifiedAuthGuard`); inject that directly rather than reintroducing a second
 *    way to ask the same question — the exact drift A2 set out to end.
 *  - `validateUser` reported `isActive: !user.isDeleted`, and `isDeleted` only means
 *    `resourceStatus === DELETED`. A DISABLED or SUSPENDED user therefore came back
 *    as ACTIVE — the same class of silent lie as the old `isTokenRevoked` stub. Any
 *    future caller needing liveness must read `resourceStatus` (and the per-user
 *    not-before stamp), not resurrect this.
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
