import pino from 'pino';
import type { Environment } from '../types';

const createProductionTransport = () => ({
  target: 'pino/file',
  options: { destination: 1 },
});

const createDevelopmentTransport = () => ({
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'HH:MM:ss',
    ignore: 'pid,hostname',
  },
});

function getLogLevel(env: Environment): pino.Level {
  const environment = env.ENVIRONMENT || 'prod';

  if (environment === 'local') return 'debug';
  if (environment === 'dev') return 'info';

  return 'warn';
}

function getTransport(env: Environment): pino.TransportSingleOptions {
  const environment = env.ENVIRONMENT || 'prod';
  const isDevelopment = environment === 'local' || environment === 'dev';

  return isDevelopment ? createDevelopmentTransport() : createProductionTransport();
}

export function createLogger(env: Environment): pino.Logger {
  return pino({
    level: getLogLevel(env),
    transport: getTransport(env),
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
