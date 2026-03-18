import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { SKIP_AUTH_KEY } from '@arcaai/applications';

@Injectable()
export class OidcAuthGuard extends AuthGuard('oidc') {
    private readonly logger = new Logger(OidcAuthGuard.name);

    constructor(private reflector: Reflector) {
        super();
    }

    canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest();
        const method = request?.method;
        const path = request?.url;

        const isPublic = this.reflector.getAllAndOverride<boolean>(
            SKIP_AUTH_KEY,
            [context.getHandler(), context.getClass()]
        );
        if (isPublic) {
            this.logger.debug({
                message: 'Auth skipped',
                reason: 'public_route',
                method,
                path,
            });
            return true;
        }
        return super.canActivate(context);
    }
}
