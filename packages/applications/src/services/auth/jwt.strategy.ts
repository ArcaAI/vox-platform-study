import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ClsService } from 'nestjs-cls';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { IActiveUserContext } from '../../interfaces';
import { IAppSettingsService } from '../baseServices/_meta/appSettings';
import { UserSession } from './dto';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
    constructor(
        @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
        private readonly clsService: ClsService<IActiveUserContext>,
    ) {
        // JWT secret is now managed exclusively via AppSettingsService (database-stored settings)
        const jwtSecret = appSettingsService.getValueWithDefault(
            'JWT_SECRET_KEY',
            'default-jwt-secret-key-change-in-production'
        );

        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: jwtSecret,
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async validate(payload: any): Promise<UserSession> {
        const userSession = new UserSession({
            id: payload.id,
            firstName: payload.firstName,
            lastName: payload.lastName,
            email: payload.email,
            phone: payload.phone,
            token: payload.token,
            tenantId: payload.tenantId,
            tenantCode: payload.tenantCode,
            roles: payload.roles || [],
            permissions: payload.permissions || [],
        });

        this.clsService.set('user', userSession);
        return userSession;
    }
}
