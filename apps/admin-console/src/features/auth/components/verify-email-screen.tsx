'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { IconAlertCircle, IconCircleCheck } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

interface VerifyEmailScreenProps {
  /** The `?token=` query param — undefined when the link was malformed. */
  token: string | undefined;
}

type Result = { tenantKey: string } | { error: string };

/** Consumes the emailed verification link, auto-submitting on mount. */
export function VerifyEmailScreen({ token }: VerifyEmailScreenProps) {
  const [result, setResult] = useState<Result | null>(null);
  const submitted = useRef(false);

  useEffect(() => {
    if (!token || submitted.current) return;
    submitted.current = true;

    (async () => {
      try {
        const response = await fetch('/api/auth/register/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = (await response.json()) as { tenantKey?: string; message?: string };
        if (!response.ok) {
          setResult({ error: data.message ?? 'Verification failed' });
          return;
        }
        setResult({ tenantKey: data.tenantKey as string });
      } catch {
        setResult({ error: 'Could not reach the server. Please try again.' });
      }
    })();
  }, [token]);

  if (!token) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Verification link incomplete</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <IconAlertCircle />
            <AlertTitle>Missing verification token</AlertTitle>
            <AlertDescription>Please use the link from your verification email.</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!result) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Verifying your email…</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </CardContent>
      </Card>
    );
  }

  if ('error' in result) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Verification failed</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <IconAlertCircle />
            <AlertTitle>{result.error}</AlertTitle>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>You&apos;re all set</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert>
          <IconCircleCheck />
          <AlertTitle>Email verified</AlertTitle>
          <AlertDescription>
            Your account and tenant <span className="font-mono">{result.tenantKey}</span> are ready.
          </AlertDescription>
        </Alert>
        <Button asChild>
          <Link href="/login">Sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
