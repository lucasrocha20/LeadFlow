import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const validEnv = {
  DATABASE_URL: 'postgresql://leadflow:leadflow@localhost:5432/leadflow',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({ NODE_ENV: 'development', PORT: 3000, LOG_LEVEL: 'info' });
  });

  it('coerces PORT to a number', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ REDIS_URL: validEnv.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });
});
