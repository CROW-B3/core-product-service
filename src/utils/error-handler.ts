import { tryCatch } from '@d3avarja/try-catch';
import type { Context } from 'hono';
import type pino from 'pino';

export type ServiceError = {
  statusCode: number;
  code: string;
  message: string;
};

export type ErrorResponse = {
  error: {
    code: string;
    message: string;
    timestamp: string;
  };
};

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
    return typeof message === 'string' ? message : 'An unexpected error occurred';
  }

  if (typeof error === 'string') return error;

  return 'An unexpected error occurred';
}

;

const logErrorToConsole = (logger: pino.Logger, error: unknown, context?: string): void => {
  const errorMessage = getErrorMessageFromError(error);
  const errorCode = getErrorCodeFromError(error);

  if (context) {
    logger.error({ error, code: errorCode, context }, errorMessage);
  } else {
    logger.error({ error, code: errorCode }, errorMessage);
  }
};

export const handleErrorResponse = (c: Context, error: unknown, logger: pino.Logger) => {
  const statusCode = getStatusCodeFromError(error);
  const code = getErrorCodeFromError(error);
  const message = getErrorMessageFromError(error);

  logErrorToConsole(logger, error);

  return c.json(createErrorResponse(code, message), statusCode);
};

export const createServiceError = (statusCode: number, code: string, message: string): ServiceError => ({
  statusCode,
  code,
  message,
});

export const wrapAsyncHandler = <T>(
  handler: () => Promise<T>
): Promise<[T, null] | [null, Error]> => {
  return tryCatch(handler);
};
