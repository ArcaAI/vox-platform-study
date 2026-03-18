export interface ScopeDefinition {
    description: string;
    category: string;
}

export const API_KEY_SCOPE_REGISTRY: Record<string, ScopeDefinition> = {
    // STT Service
    'stt:transcription:read':  { description: 'Read transcription results', category: 'STT' },
    'stt:transcription:write': { description: 'Create and stream transcriptions', category: 'STT' },
    'stt:stream:write':        { description: 'Stream audio for real-time transcription', category: 'STT' },
    'stt:model:read':          { description: 'View available STT models', category: 'STT' },

    // Consultation
    'consultation:session:read':  { description: 'Read consultation sessions', category: 'Consultation' },
    'consultation:session:write': { description: 'Create and manage consultation sessions', category: 'Consultation' },
    'consultation:report:read':   { description: 'Read consultation reports/summaries', category: 'Consultation' },
    'consultation:report:write':  { description: 'Generate consultation reports', category: 'Consultation' },

    // User (Self)
    'user:profile:read':       { description: 'Read own user profile', category: 'User' },
    'user:preferences:read':   { description: 'Read own preferences', category: 'User' },
    'user:preferences:write':  { description: 'Update own preferences', category: 'User' },

    // Media
    'media:file:read':   { description: 'Read/download media files', category: 'Media' },
    'media:file:write':  { description: 'Upload media files', category: 'Media' },

    // Admin
    'admin:user:read':    { description: 'Read user information', category: 'Admin' },
    'admin:user:write':   { description: 'Manage users', category: 'Admin' },
    'admin:apikey:read':  { description: 'Read API keys', category: 'Admin' },
    'admin:apikey:write': { description: 'Manage API keys', category: 'Admin' },
    'admin:tenant:read':  { description: 'Read tenant configuration', category: 'Admin' },
    'admin:tenant:write': { description: 'Manage tenant settings', category: 'Admin' },
    'admin:audit:read':   { description: 'Read audit logs', category: 'Admin' },
    'admin:role:read':    { description: 'Read roles and policies', category: 'Admin' },
    'admin:role:write':   { description: 'Manage roles and policies', category: 'Admin' },

    // Webhooks
    'webhook:event:read':  { description: 'Read webhook events', category: 'Webhook' },
    'webhook:event:write': { description: 'Manage webhook subscriptions', category: 'Webhook' },

    // Wildcards
    'stt:*':            { description: 'Full STT service access', category: 'Wildcard' },
    'consultation:*':   { description: 'Full consultation access', category: 'Wildcard' },
    'user:*':           { description: 'Full user self-service access', category: 'Wildcard' },
    'media:*':          { description: 'Full media access', category: 'Wildcard' },
    'admin:*':          { description: 'Full admin access', category: 'Wildcard' },
    'webhook:*':        { description: 'Full webhook access', category: 'Wildcard' },
    '*':                { description: 'Unrestricted access (superadmin only)', category: 'Wildcard' },
};

export function isValidScope(scope: string): boolean {
    return scope in API_KEY_SCOPE_REGISTRY;
}

export function getAvailableScopes(): Array<{ scope: string } & ScopeDefinition> {
    return Object.entries(API_KEY_SCOPE_REGISTRY).map(([scope, def]) => ({
        scope,
        ...def,
    }));
}

export function getScopesByCategory(): Record<string, Array<{ scope: string; description: string }>> {
    const result: Record<string, Array<{ scope: string; description: string }>> = {};
    for (const [scope, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
        if (!result[def.category]) result[def.category] = [];
        result[def.category].push({ scope, description: def.description });
    }
    return result;
}
