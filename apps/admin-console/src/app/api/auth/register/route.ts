import { clientUserAgentHeader, gatewayErrorMessage, gatewayUrl } from '@/server/gateway';

interface RegisterRequestBody {
  email?: string;
  password?: string;
  tenantName?: string;
  displayName?: string;
}

/**
 * BFF register: pure passthrough to the gateway — no session is
 * minted here (the account is unverified until `/register/verify`). 404s
 * whenever the gateway's `REGISTRATION_SELF_SIGNUP_ENABLED` flag is off.
 */
export async function POST(request: Request): Promise<Response> {
  let body: RegisterRequestBody;
  try {
    body = (await request.json()) as RegisterRequestBody;
  } catch {
    return Response.json({ message: 'Invalid request body' }, { status: 400 });
  }
  if (!body.email || !body.password || !body.tenantName) {
    return Response.json({ message: 'Email, password and tenant name are required' }, { status: 400 });
  }

  const gatewayResponse = await fetch(gatewayUrl('auth/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...clientUserAgentHeader(request) },
    body: JSON.stringify({
      email: body.email,
      password: body.password,
      tenantName: body.tenantName,
      ...(body.displayName ? { displayName: body.displayName } : {}),
    }),
    cache: 'no-store',
    redirect: 'manual',
  });

  if (!gatewayResponse.ok) {
    const message = await gatewayErrorMessage(gatewayResponse, 'Registration failed');
    return Response.json({ message }, { status: gatewayResponse.status });
  }

  const data = await gatewayResponse.json();
  return Response.json(data, { status: gatewayResponse.status });
}
