import { Injectable, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IAuthService, AuthenticationTrackingData, UserValidationResponse } from './IAuthService';
import { IUserService, CreateOAuthUserRequest } from '../user/user/';
import { InternalServerErrorException } from '@arcaai/exceptions';
import { EventTypes } from '@arcaai/domains';
import { OAuthUserResponse } from './dto';
import { AuthDtoMapper } from './auth.dto.mapper';

/**
 * AuthService is responsible for handling authentication-related operations,
 * including fetching or creating users based on OAuth requests.
 */
@Injectable()
export class AuthService implements IAuthService {
  constructor(
    @Inject(IUserService) private readonly userService: IUserService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Retrieves an existing user by their external ID or creates a new user
   * if none exists. Emits an event upon successful authentication.
   *
   * @param request - The request object containing the external ID and user data.
   * @returns A promise that resolves to an OAuthUserResponse object.
   * @throws InternalServerErrorException if user creation fails.
   */
  public async getOrCreateOidcUser(request: CreateOAuthUserRequest): Promise<OAuthUserResponse> {
    // Attempt to fetch the user by their external ID
    let user = await this.userService.fetchByExternalId(request.externalId).catch(() => null);

    // If the user does not exist, create a new user
    if (!user) {
      user = await this.userService.createExternalUser({
        ...request,
      });
    }

    // If user creation fails, throw an error
    if (!user) {
      throw new InternalServerErrorException('Failed to create user');
    }

    // Emit an event indicating the user has been authenticated
    // Always emit with explicit userId field for consistent audit log contract
    this.eventEmitter.emit(EventTypes.UserAuthenticated, {
      userId: user.id,
      method: 'oidc',
    });

    // Return the user response mapped to the appropriate DTO
    return AuthDtoMapper.ToResponse(user);
  }

  /**
   * Check if a JWT token has been revoked
   * @param tokenId - The JWT token ID (jti claim)
   * @returns Promise<boolean> - true if token is revoked, false otherwise
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async isTokenRevoked(tokenId: string): Promise<boolean> {
    // TODO: Implement token revocation checking
    // This could check against a Redis blacklist or database table
    // For now, return false (no tokens are revoked)
    return false;
  }

  /**
   * Validate a user by ID and return user information
   * @param userId - The user ID to validate
   * @returns Promise<UserValidationResponse | null> - User data if valid, null otherwise
   */
  public async validateUser(userId: string): Promise<UserValidationResponse | null> {
    try {
      const user = await this.userService.fetchById(userId);
      if (!user) {
        return null;
      }

      return {
        id: user.id,
        email: user.UserProfile?.email || '',
        isActive: !user.isDeleted,
        departmentId: undefined,
        lastLoginAt: user.lastLoginAt,
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return null;
    }
  }

  /**
   * Track successful authentication for audit purposes
   * @param userId - The authenticated user ID
   * @param trackingData - Additional tracking information
   * @returns Promise<void>
   */
  public async trackAuthentication(userId: string, trackingData: AuthenticationTrackingData): Promise<void> {
    // Emit event for audit logging
    this.eventEmitter.emit(EventTypes.UserAuthenticated, {
      userId,
      timestamp: new Date(),
      ...trackingData,
    });

    // TODO: Implement additional tracking logic
    // This could store authentication events in audit log database
    // For HIPAA compliance, we need to track all access to medical data
  }
}
