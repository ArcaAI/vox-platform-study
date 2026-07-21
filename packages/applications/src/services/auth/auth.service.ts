import { Injectable, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IAuthService, AuthenticationTrackingData } from './IAuthService';
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
   * Track successful authentication for audit purposes.
   *
   * Emission IS the persistence trigger: `AuditLogService`
   * (`@OnEvent(EventTypes.UserAuthenticated)`) writes the HIPAA LOGIN audit
   * row synchronously — envelope-encrypted, via the sanctioned unscoped
   * client, because login runs before CLS tenant context exists. That handler
   * is the persistence authority; do not add a second write here.
   *
   * The FAILED-attempt trail is carried separately by
   * `EventTypes.UserAuthenticationFailed`.
   *
   * @param userId - The authenticated user ID
   * @param trackingData - Additional tracking information
   * @returns Promise<void>
   */
  public async trackAuthentication(userId: string, trackingData: AuthenticationTrackingData): Promise<void> {
    this.eventEmitter.emit(EventTypes.UserAuthenticated, {
      userId,
      timestamp: new Date(),
      ...trackingData,
    });
  }
}
