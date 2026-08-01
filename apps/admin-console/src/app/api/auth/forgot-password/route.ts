import { clientUserAgentHeader, gatewayErrorMessage, gatewayUrl } from '@/server/gateway';

interface ForgotPasswordRequestBody {
  email?: string;
}

const GENERIC_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';

/**
 * BFF forgot-password: forwards the self-service reset request to the
 * gateway. Pre-auth, same posture as /api/auth/login — no session exists yet.
 * The gateway always answers 202 with a generic anti-enumeration message;
 * this route passes that straight through rather than inventing its own copy.
 */
export async function POST(request: Request): Promise<Response> {
  let body: ForgotPasswordRequestBody;
  try {
    body = (await request.json()) as ForgotPasswordRequestBody;
  } catch {
    return Response.json({ message: 'Invalid request body' }, { status: 400 });
  }
  if (!body.email) {
    return Response.json({ message: 'Email is required' }, { status: 400 });
  }

  const gatewayResponse = await fetch(gatewayUrl('auth/forgot-password'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...clientUserAgentHeader(request) },
    body: JSON.stringify({ email: body.email }),
    cache: 'no-store',
    redirect: 'manual',
  });

  if (!gatewayResponse.ok) {
    const message = await gatewayErrorMessage(gatewayResponse, 'Could not send reset link');
    return Response.json({ message }, { status: gatewayResponse.status });
  }

  const data = (await gatewayResponse.json().catch(() => ({}))) as { message?: string };
  return Response.json({ message: data.message ?? GENERIC_MESSAGE });
}
