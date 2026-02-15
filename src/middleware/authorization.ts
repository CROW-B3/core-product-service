import type { Context, Next } from 'hono';

export const requireOwnership = (resourceIdParam: string = 'id') => {
  return async (c: Context, next: Next) => {
    const jwtPayload = c.get('jwtPayload');
    const resourceId = c.req.param(resourceIdParam);

    // System JWTs bypass ownership checks
    if (c.get('isSystem')) return next();

    // Verify user owns the resource
    if (jwtPayload?.sub !== resourceId && !jwtPayload?.organizationId) {
      return c.json({ error: 'Forbidden', message: 'Access denied' }, 403);
    }

    return next();
  };
};

export const requireOrganization = () => {
  return async (c: Context, next: Next) => {
    const jwtPayload = c.get('jwtPayload');
    const organizationId =
      c.req.param('organizationId') || c.req.query('organizationId');

    if (c.get('isSystem')) return next();

    if (jwtPayload?.organizationId !== organizationId) {
      return c.json(
        { error: 'Forbidden', message: 'Access denied to this organization' },
        403
      );
    }

    return next();
  };
};
