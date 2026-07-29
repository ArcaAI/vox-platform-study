import { clientUserAgentHeader, gatewayErrorMessage, gatewayUrl } from '@/server/gateway';

interface ResetPasswordRequestBody {
  token?: string;
  newPassword?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: ResetPasswordRequestBody;
  try {
    body = (await request.json()) as ResetPasswordRequestBody;
  } catch {
    return Response.json({ message: 'Invalid request body' }, { status: 400 });
  }
  if (!body.token || !body.newPassword) {
    return Response.json({ message: 'Token and new password are required' }, { status: 400 });
  }

  const gatewayResponse = await fetch(gatewayUrl('users/password-reset/complete'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...clientUserAgentHeader(request) },
    body: JSON.stringify({ token: body.token, newPassword: body.newPassword }),
    cache: 'no-store',
    redirect: 'manual',
  });

  if (!gatewayResponse.ok) {
    const message = await gatewayErrorMessage(gatewayResponse, 'Password reset failed');
    return Response.json({ message }, { status: gatewayResponse.status });
  }

  const data = await gatewayResponse.json();
  return Response.json(data, { status: gatewayResponse.status });
}
