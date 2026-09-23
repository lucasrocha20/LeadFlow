import type { LoggerOptions } from 'pino';
import type { Config } from './config.js';

export type LoggerConfig = Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>;

/** Pino options shared by the API (through Fastify) and the worker. `false` disables logging. */
export function loggerOptions(config: LoggerConfig): LoggerOptions | false {
  if (config.NODE_ENV === 'test') return false;
  if (config.NODE_ENV === 'development') {
    return { level: config.LOG_LEVEL, transport: { target: 'pino-pretty' } };
  }
  return { level: config.LOG_LEVEL };
}
