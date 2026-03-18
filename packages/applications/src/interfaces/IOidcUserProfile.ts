export interface IOidcUserProfile {
    sub: string;
    name: string;
    email: string;
    email_verified: boolean;
    given_name: string;
    preferred_username: string;
    nickname: string;
    groups: string[];
    // tenantId: string | null;
}
