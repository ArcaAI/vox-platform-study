// This file is auto-generated. Be careful to edit manually
export * from './dto';
export * from './auth.dto.mapper';
export * from './IAuthService';
export * from './auth.service.module';
export * from './auth.service';
export * from './createJwt';
export * from './jwt.strategy';
export * from './jwt-revocation.service';
export * from './jwt-revocation.module';
export * from './refresh-token.service';
export * from './oidc.strategy';
export * from './session.serializer';
export * from './registration';

// The `gateway-jwt` passport strategy, its guard, and the
// gateway-only decorators were RETIRED here. They were wired to zero routes:
// `UnifiedAuthGuard` is the single mandated enforcement point, and
// keeping a second strategy meant keeping it security-equivalent by hand.
