import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type pino from 'pino';

export interface ServiceError {
  statusCode: number;
  code: string;
  message: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    timestamp: string;
  };
}

const createErrorResponse = (code: string, message: string): ErrorResponse => ({
  error: {
    code,
    message,
    timestamp: new Date().toISOString(),
  },
});

const getStatusCodeFromError = (error: unknown): number => {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = (error as ServiceError).statusCode;
    return typeof statusCode === 'number' ? statusCode : 500;
  }

  return 500;
};

const getErrorCodeFromError = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as ServiceError).code;
    return typeof code === 'string' ? code : 'INTERNAL_ERROR';
  }

  return 'INTERNAL_ERROR';
};

const getErrorMessageFromError = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as ServiceError).message;
    return typeof message === 'string'
      ? message
      : 'An unexpected error occurred';
  }

  if (typeof error === 'string') return error;

  return 'An unexpected error occurred';
};

const logErrorToConsole = (
  logger: pino.Logger,
  error: unknown,
  context?: string
): void => {
  const errorMessage = getErrorMessageFromError(error);
  const errorCode = getErrorCodeFromError(error);

  if (context) {
    logger.error({ error, code: errorCode, context }, errorMessage);
  } else {
    logger.error({ error, code: errorCode }, errorMessage);
  }
};

const isZodValidationError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { name?: string }).name === 'ZodError';

const isMalformedJsonError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as { name?: string; message?: string };
  if (name === 'SyntaxError') return true;
  if (typeof message !== 'string') return false;
  return (
    message.includes('Malformed JSON') ||
    message.includes('Unexpected end of JSON') ||
    message.includes('Unexpected token')
  );
};

export const handleErrorResponse = (
  c: Context,
  error: unknown,
  logger: pino.Logger
) => {
  logErrorToConsole(logger, error);

  if (isZodValidationError(error)) {
    return c.json(
      createErrorResponse('VALIDATION_ERROR', 'Invalid request parameters'),
      400 as ContentfulStatusCode
    );
  }

  if (isMalformedJsonError(error)) {
    return c.json(
      createErrorResponse('BAD_REQUEST', 'Invalid request body'),
      400 as ContentfulStatusCode
    );
  }

  const statusCode = getStatusCodeFromError(error);
  const code = getErrorCodeFromError(error);
  const message = getErrorMessageFromError(error);

  return c.json(
    createErrorResponse(code, message),
    statusCode as ContentfulStatusCode
  );
};

export const createServiceError = (
  statusCode: number,
  code: string,
  message: string
): ServiceError => ({
  statusCode,
  code,
  message,
});

export const wrapAsyncHandler = async <T>(
  handler: () => Promise<T>
): Promise<[T, null] | [null, Error]> => {
  try {
    const result = await handler();
    return [result, null];
  } catch (error) {
    return [null, error instanceof Error ? error : new Error(String(error))];
  }
};
