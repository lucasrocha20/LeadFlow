import { describe, expect, it } from 'vitest';
import {
  loadContactConfig,
  parseContactConfig,
  referencedTemplates,
} from '../src/contact/config.js';

const valid = {
  quietHours: {
    start: '21:00',
    end: '08:00',
    channels: ['whatsapp'],
    defaultTimezone: 'America/Sao_Paulo',
  },
  tiers: {
    hot: {
      messages: [{ channel: 'whatsapp', template: 'wa' }],
      repAlertTemplate: 'alert',
    },
    warm: { messages: [{ channel: 'email', template: 'mail' }] },
    cold: { messages: [] },
  },
};

describe('contact config', () => {
  it('loads the default config/contact.json', () => {
    const config = loadContactConfig('config/contact.json');
    expect(config.tiers.hot.messages.map((m) => m.channel)).toEqual(['whatsapp', 'email']);
    expect(config.tiers.cold.messages.map((m) => m.channel)).toEqual(['email']);
    expect(config.tiers.hot.repAlertTemplate).toBeDefined();
  });

  it('lists every referenced template with its channel', () => {
    expect([...referencedTemplates(parseContactConfig(valid))]).toEqual([
      ['wa', 'whatsapp'],
      ['alert', 'email'],
      ['mail', 'email'],
    ]);
  });

  it.each([
    ['a bad time', { ...valid, quietHours: { ...valid.quietHours, start: '9pm' } }, /HH:MM/],
    [
      'an empty quiet window',
      { ...valid, quietHours: { ...valid.quietHours, end: '21:00' } },
      /must differ/,
    ],
    [
      'an unknown time zone',
      { ...valid, quietHours: { ...valid.quietHours, defaultTimezone: 'Mars/Base' } },
      /time zone/,
    ],
    [
      'a missing tier',
      { ...valid, tiers: { hot: valid.tiers.hot, warm: valid.tiers.warm } },
      /cold/,
    ],
    [
      'two messages on one channel',
      {
        ...valid,
        tiers: {
          ...valid.tiers,
          cold: {
            messages: [
              { channel: 'email', template: 'a' },
              { channel: 'email', template: 'b' },
            ],
          },
        },
      },
      /one message per channel/,
    ],
    [
      'an unknown channel',
      {
        ...valid,
        tiers: { ...valid.tiers, cold: { messages: [{ channel: 'fax', template: 'a' }] } },
      },
      /Invalid contact config/,
    ],
  ])('rejects %s', (_name, data, message) => {
    expect(() => parseContactConfig(data)).toThrow(message);
  });
});
