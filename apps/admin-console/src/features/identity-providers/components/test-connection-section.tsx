'use client';

import { IconCircleCheck, IconCircleX, IconPlugConnected } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { publicEnv } from '@/config/public-env';
import { useTestConnection } from '../api/hooks';
import type { TenantIdpConfig } from '../api/types';

/**
 * OIDC discovery + client-construction probe (D7 — never a full browser
 * login) plus the redirect URI every tenant admin must register with their
 * IdP as the OAuth callback. Redirect URI is a PLATFORM-WIDE constant
 * (state distinguishes tenant/provider) — computed client-side from the
 * public gateway origin, not fetched.
 */
export function TestConnectionSection({ provider }: { provider: TenantIdpConfig }) {
  const testConnection = useTestConnection();
  const redirectUri = `${publicEnv.apiHost}/api/v1/auth/sso/callback`;

  function handleTest() {
    testConnection.mutate(provider.id, {
      onSuccess: (result) => {
        if (result.ok) {
          toast.success('Connection verified — provider is now ENABLED');
        } else {
          toast.error(result.error ?? 'Connection test failed');
        }
      },
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not test the connection.'),
    });
  }

  const result = testConnection.data;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
        Connection
        <span aria-hidden className="text-muted-foreground font-mono text-xs font-normal">
          POST :id/test
        </span>
      </h3>
      <div className="flex flex-col gap-2">
        <Label htmlFor="idp-redirect-uri">Redirect URI — register this with your IdP</Label>
        <div className="flex gap-2">
          <Input id="idp-redirect-uri" value={redirectUri} readOnly className="font-mono text-xs" />
          <CopyButton value={redirectUri} label="Copy redirect URI" />
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" className="self-start" disabled={testConnection.isPending} onClick={handleTest}>
        {testConnection.isPending ? <Spinner /> : <IconPlugConnected aria-hidden />}
        Test connection
      </Button>
      {result ? (
        <p className="flex items-center gap-1.5 text-xs">
          {result.ok ? (
            <>
              <IconCircleCheck aria-hidden className="text-success size-4" />
              <span>Verified — status {result.providerStatus}</span>
            </>
          ) : (
            <>
              <IconCircleX aria-hidden className="text-destructive size-4" />
              <span className="text-destructive">{result.error ?? 'Connection test failed'}</span>
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}
