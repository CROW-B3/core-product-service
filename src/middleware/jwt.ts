import type { Context, Next } from 'hono';
import type { Environment } from '../types';
import { verify } from 'hono/jwt';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    jwtPayload: Record<string, unknown>;
    isSystem: boolean;
  }
}

const verifySystemToken = async (
  context: Context<{ Bindings: Environment }>,
  token: string,
  secret: string,
  next: Next
) => {
  try {
    const payload = await verify(token, secret, 'HS256');
    if (payload.type !== 'system') {
      return context.json({ error: 'System token required' }, 401);
    }
    context.set('jwtPayload', payload as Record<string, unknown>);
    context.set('isSystem', true);
    return next();
  } catch {
    return context.json({ error: 'Invalid system token' }, 401);
  }
};

const verifyUserToken = async (
  context: Context<{ Bindings: Environment }>,
  token: string,
  authServiceUrl: string,
  next: Next
) => {
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) {
      return context.json({ error: 'Invalid token' }, 401);
    }

    const jwksUrl = `${authServiceUrl}/api/v1/auth/jwks`;
    const jwksResponse = await fetch(jwksUrl);
    if (!jwksResponse.ok) {
      return context.json({ error: 'Unable to fetch JWKS' }, 401);
    }

    const jwks = await jwksResponse.json<{ keys: JsonWebKey[] }>();
    const headerJson = JSON.parse(atob(headerB64));
    const kid = headerJson.kid;

    const key = jwks.keys.find(
      (k: JsonWebKey) =>
        !kid || (k as JsonWebKey & { kid?: string }).kid === kid
    );
    if (!key) {
      return context.json({ error: 'No matching key found' }, 401);
    }

    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const encoder = new TextEncoder();
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const sig = Uint8Array.from(
      atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      sig,
      data
    );
    if (!valid) {
      return context.json({ error: 'Invalid token' }, 401);
    }

    const payload = JSON.parse(atob(payloadB64));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return context.json({ error: 'Token expired' }, 401);
    }

    context.set('jwtPayload', payload as Record<string, unknown>);
    context.set('userId', payload.sub as string);
    context.set('isSystem', false);
    return next();
  } catch {
    return context.json({ error: 'Invalid token' }, 401);
  }
};

export const createJWTMiddleware = (env: Environment) => {
  return async (c: Context<{ Bindings: Environment }>, next: Next) => {
    const systemHeader = c.req.header('X-System-Token');
    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.substring(7);

    if (systemHeader) {
      return verifySystemToken(c, token, env.BETTER_AUTH_SECRET, next);
    }

    return verifyUserToken(c, token, env.AUTH_SERVICE_URL, next);
  };
};
