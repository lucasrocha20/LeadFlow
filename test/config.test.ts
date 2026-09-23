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

  it('defaults messaging and email to dry-run', () => {
    expect(loadConfig(validEnv)).toMatchObject({
      MESSAGING_PROVIDER: 'dry-run',
      EMAIL_PROVIDER: 'dry-run',
    });
  });

  it("requires a provider's credentials only when it is selected", () => {
    expect(() =>
      loadConfig({ ...validEnv, EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.co' }),
    ).toThrow(/RESEND_API_KEY/);
    expect(() =>
      loadConfig({ ...validEnv, MESSAGING_PROVIDER: 'whatsapp', WHATSAPP_ACCESS_TOKEN: 't' }),
    ).toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
    expect(loadConfig({ ...validEnv, RESEND_API_KEY: '' }).RESEND_API_KEY).toBeUndefined();
  });

  it('rejects an unimplemented provider', () => {
    expect(() => loadConfig({ ...validEnv, MESSAGING_PROVIDER: 'twilio' })).toThrow(
      /MESSAGING_PROVIDER/,
    );
  });
});
