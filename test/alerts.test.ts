import { describe, expect, it, vi } from 'vitest';
import {
  alertsFrom,
  notifyAlerts,
  webhookSender,
  type Alert,
  type AlertInputs,
  type AlertStore,
} from '../src/admin/alerts.js';
import type { QueueStats } from '../src/queue.js';

const thresholds = { queueBacklog: 100, queueWaitMinutes: 15, sendFailures: 5, windowMinutes: 15 };
const MINUTE = 60_000;

const queue = (overrides: Partial<QueueStats> = {}): QueueStats => ({
  name: 'message.send',
  waiting: 0,
  active: 1,
  delayed: 0,
  failed: 0,
  oldestWaitingMs: 0,
  ...overrides,
});

const inputs = (overrides: Partial<AlertInputs> = {}): AlertInputs => ({
  queues: [],
  sendFailures: [],
  crmDeadLetters: { count: 0, lastError: null },
  ...overrides,
});

describe('alertsFrom', () => {
  it('is quiet when everything is under the thresholds', () => {
    expect(
      alertsFrom(
        inputs({
          queues: [queue({ waiting: 99, oldestWaitingMs: 14 * MINUTE })],
          sendFailures: [{ channel: 'email', count: 4, lastError: 'x' }],
        }),
        thresholds,
      ),
    ).toEqual([]);
  });

  it('flags a queue with too many waiting jobs', () => {
    const [alert] = alertsFrom(inputs({ queues: [queue({ waiting: 100 })] }), thresholds);
    expect(alert).toMatchObject({ key: 'queue-backlog:message.send', severity: 'warning' });
  });

  it('flags a queue whose oldest job waited too long, as critical when nothing runs', () => {
    const [alert] = alertsFrom(
      inputs({ queues: [queue({ waiting: 3, active: 0, oldestWaitingMs: 15 * MINUTE })] }),
      thresholds,
    );
    expect(alert).toMatchObject({ key: 'queue-backlog:message.send', severity: 'critical' });
    expect(alert!.message).toContain('is the worker running?');
  });

  it('flags send failures per channel', () => {
    const alerts = alertsFrom(
      inputs({
        sendFailures: [
          { channel: 'whatsapp', count: 5, lastError: 'token expired' },
          { channel: 'email', count: 1, lastError: 'bounce' },
        ],
      }),
      thresholds,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ key: 'send-failures:whatsapp', severity: 'critical' });
    expect(alerts[0]!.message).toContain('token expired');
  });

  it('flags any dead-lettered CRM sync', () => {
    const [alert] = alertsFrom(
      inputs({ crmDeadLetters: { count: 2, lastError: 'HubSpot 400' } }),
      thresholds,
    );
    expect(alert).toMatchObject({ key: 'crm-dead-letters', severity: 'warning' });
    expect(alert!.message).toContain('2 lead(s)');
  });
});

/** In-memory AlertStore with a controllable clock. */
function memoryStore() {
  let now = 0;
  const cooldowns = new Map<string, number>();
  const firing = new Set<string>();
  const store: AlertStore = {
    async claim(key, cooldownMs) {
      if ((cooldowns.get(key) ?? -Infinity) > now) return false;
      cooldowns.set(key, now + cooldownMs);
      return true;
    },
    async release(key) {
      cooldowns.delete(key);
    },
    firing: async () => [...firing],
    async markFiring(key) {
      firing.add(key);
    },
    async resolve(key) {
      cooldowns.delete(key);
      return firing.delete(key);
    },
  };
  return { store, advance: (ms: number) => (now += ms) };
}

const log = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });
const alert: Alert = { key: 'crm-dead-letters', severity: 'warning', message: '2 parked' };

describe('notifyAlerts', () => {
  it('notifies once per cooldown, then once when resolved', async () => {
    const { store, advance } = memoryStore();
    const send = vi.fn(async () => {});
    const opts = { store, send, cooldownMs: 60 * MINUTE, log: log() };

    expect(await notifyAlerts({ ...opts, alerts: [alert] })).toEqual({
      notified: ['crm-dead-letters'],
      resolved: [],
    });
    expect(send).toHaveBeenLastCalledWith('🟠 LeadFlow: 2 parked');

    advance(30 * MINUTE);
    expect((await notifyAlerts({ ...opts, alerts: [alert] })).notified).toEqual([]);

    advance(31 * MINUTE);
    expect((await notifyAlerts({ ...opts, alerts: [alert] })).notified).toEqual([
      'crm-dead-letters',
    ]);

    expect(await notifyAlerts({ ...opts, alerts: [] })).toEqual({
      notified: [],
      resolved: ['crm-dead-letters'],
    });
    expect(send).toHaveBeenLastCalledWith('✅ LeadFlow: resolved: crm-dead-letters');
    expect((await notifyAlerts({ ...opts, alerts: [] })).resolved).toEqual([]);

    // Firing again after resolution notifies right away.
    expect((await notifyAlerts({ ...opts, alerts: [alert] })).notified).toEqual([
      'crm-dead-letters',
    ]);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('retries on the next check when posting fails', async () => {
    const { store } = memoryStore();
    const send = vi.fn<(text: string) => Promise<void>>();
    send.mockRejectedValueOnce(new Error('503')).mockResolvedValue();
    const l = log();
    const opts = { store, send, cooldownMs: 60 * MINUTE, log: l };

    expect((await notifyAlerts({ ...opts, alerts: [alert] })).notified).toEqual([]);
    expect(l.error).toHaveBeenCalledWith(expect.anything(), 'alert notification failed');
    expect((await notifyAlerts({ ...opts, alerts: [alert] })).notified).toEqual([
      'crm-dead-letters',
    ]);
  });

  it('only logs when no sender is configured', async () => {
    const { store } = memoryStore();
    const l = log();
    await notifyAlerts({
      alerts: [{ ...alert, severity: 'critical' }],
      store,
      cooldownMs: MINUTE,
      log: l,
    });
    expect(l.error).toHaveBeenCalledWith(
      { alert: 'crm-dead-letters', details: undefined },
      'ALERT: 2 parked',
    );
  });
});

describe('webhookSender', () => {
  it('posts Slack-compatible JSON and fails on an error status', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('ok'));
    await webhookSender('https://hooks.example.com/x', fetchFn)('hello');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://hooks.example.com/x');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ text: 'hello' }) });

    fetchFn.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await expect(webhookSender('https://hooks.example.com/x', fetchFn)('x')).rejects.toThrow('500');
  });
});
