import { describe, expect, it } from 'vitest';
import { isOptOut } from '../src/inbound/optOut.js';
import { unsubscribeUrl, verifyUnsubscribeToken } from '../src/inbound/unsubscribe.js';

const keywords = ['STOP', 'UNSUBSCRIBE', 'PARAR', 'DESCADASTRAR'];

describe('isOptOut', () => {
  it.each(['STOP', 'stop', ' Stop! ', 'stop.', 'Parar', 'descadastrar', 'dESCADASTRÁR'])(
    'treats %j as an opt-out',
    (text) => {
      expect(isOptOut({ text }, keywords)).toBe(true);
    },
  );

  it.each(['please stop by our booth', 'stopping', 'Can we talk?', '', 'STOP IT NOW'])(
    'does not treat %j as an opt-out',
    (text) => {
      expect(isOptOut({ text }, keywords)).toBe(false);
    },
  );

  it('checks the first non-empty line, ignoring quoted history below', () => {
    expect(isOptOut({ text: '\n\nUnsubscribe\n\n> On Monday, Sales wrote: ...' }, keywords)).toBe(
      true,
    );
    expect(isOptOut({ text: 'Sounds good\n> Reply STOP to opt out' }, keywords)).toBe(false);
  });

  it('checks the email subject too', () => {
    expect(isOptOut({ text: '', subject: 'unsubscribe' }, keywords)).toBe(true);
    expect(isOptOut({ text: 'hi', subject: 'Re: Following up' }, keywords)).toBe(false);
  });
});

describe('unsubscribe tokens', () => {
  it('builds a link whose token only verifies for that lead and secret', () => {
    const url = new URL(unsubscribeUrl('https://leads.example.com', 'secret', 'lead-1'));
    expect(url.origin + url.pathname).toBe('https://leads.example.com/unsubscribe');
    const token = url.searchParams.get('token')!;
    expect(url.searchParams.get('lead')).toBe('lead-1');
    expect(verifyUnsubscribeToken('secret', 'lead-1', token)).toBe(true);
    expect(verifyUnsubscribeToken('secret', 'lead-2', token)).toBe(false);
    expect(verifyUnsubscribeToken('other', 'lead-1', token)).toBe(false);
  });
});
