import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import type { QueueMonitor, QueueStats } from '../queue.js';

export interface Alert {
  /** Stable identity, e.g. "queue-backlog:message.send"; used for cooldown and resolution. */
  key: string;
  severity: 'warning' | 'critical';
  message: string;
  details?: Record<string, unknown>;
}

export interface AlertThresholds {
  queueBacklog: number;
  queueWaitMinutes: number;
  sendFailures: number;
  windowMinutes: number;
}

export interface AlertInputs {
  queues: QueueStats[];
  /** `message_failed` events within the window, per channel. */
  sendFailures: { channel: string; count: number; lastError: string }[];
  crmDeadLetters: { count: number; lastError: string | null };
}

const MINUTE = 60_000;

/** Which alerts fire for these readings. Pure, so thresholds are easy to test. */
export function alertsFrom(inputs: AlertInputs, t: AlertThresholds): Alert[] {
  const alerts: Alert[] = [];

  for (const q of inputs.queues) {
    const waitMinutes = Math.floor(q.oldestWaitingMs / MINUTE);
    if (q.waiting >= t.queueBacklog || waitMinutes >= t.queueWaitMinutes) {
      alerts.push({
        key: `queue-backlog:${q.name}`,
        // Nothing is being processed at all: the worker is probably down.
        severity: q.active === 0 ? 'critical' : 'warning',
        message:
          `Queue ${q.name} is backed up: ${q.waiting} waiting, oldest for ${waitMinutes} min` +
          (q.active === 0 ? ' and none being processed (is the worker running?)' : ''),
        details: { ...q },
      });
    }
  }

  for (const f of inputs.sendFailures) {
    if (f.count >= t.sendFailures) {
      alerts.push({
        key: `send-failures:${f.channel}`,
        severity: 'critical',
        message:
          `${f.count} ${f.channel} messages failed in the last ${t.windowMinutes} min. ` +
          `Latest error: ${f.lastError}`,
        details: { ...f },
      });
    }
  }

  const dead = inputs.crmDeadLetters;
  if (dead.count > 0) {
    alerts.push({
      key: 'crm-dead-letters',
      severity: 'warning',
      message:
        `${dead.count} lead(s) failed to sync to the CRM and are parked. ` +
        `Latest error: ${dead.lastError ?? 'unknown'}. Fix the cause, then requeue them.`,
      details: { ...dead },
    });
  }
  return alerts;
}

/** Reads the current state and returns the alerts that are firing. */
export async function evaluateAlerts({
  db,
  monitor,
  thresholds,
  now = new Date(),
}: {
  db: Db;
  monitor: Pick<QueueMonitor, 'stats'>;
  thresholds: AlertThresholds;
  now?: Date;
}): Promise<Alert[]> {
  const since = new Date(now.getTime() - thresholds.windowMinutes * MINUTE);
  const [queues, sendFailures, [dead]] = await Promise.all([
    monitor.stats(),
    db.$queryRaw<AlertInputs['sendFailures']>`
      SELECT channel::text AS channel, count(*)::int AS count,
        (array_agg(payload->>'error' ORDER BY "createdAt" DESC))[1] AS "lastError"
      FROM "LeadEvent"
      WHERE type = 'message_failed' AND "createdAt" >= ${since} AND channel IS NOT NULL
      GROUP BY channel`,
    db.$queryRaw<{ count: number; lastError: string | null }[]>`
      SELECT count(*)::int AS count,
        (array_agg("crmSyncError" ORDER BY "crmSyncFailedAt" DESC))[1] AS "lastError"
      FROM "Lead" WHERE "crmSyncFailedAt" IS NOT NULL`,
  ]);
  return alertsFrom(
    { queues, sendFailures, crmDeadLetters: dead ?? { count: 0, lastError: null } },
    thresholds,
  );
}

/** Shared alert state, so several workers (or a restart) don't repeat notifications. */
export interface AlertStore {
  /** True if the alert may be sent now (not sent within `cooldownMs`). */
  claim(key: string, cooldownMs: number): Promise<boolean>;
  /** Undoes a claim whose notification failed, so the next check retries it. */
  release(key: string): Promise<void>;
  /** Alerts notified as firing and not resolved yet. */
  firing(): Promise<string[]>;
  markFiring(key: string): Promise<void>;
  /** True for exactly one caller once the alert clears. */
  resolve(key: string): Promise<boolean>;
}

export function redisAlertStore(redis: Redis, prefix = 'leadflow:alerts'): AlertStore {
  return {
    async claim(key, cooldownMs) {
      return (await redis.set(`${prefix}:cooldown:${key}`, '1', 'PX', cooldownMs, 'NX')) === 'OK';
    },
    async release(key) {
      await redis.del(`${prefix}:cooldown:${key}`);
    },
    firing: () => redis.smembers(`${prefix}:firing`),
    async markFiring(key) {
      await redis.sadd(`${prefix}:firing`, key);
    },
    async resolve(key) {
      const removed = (await redis.srem(`${prefix}:firing`, key)) === 1;
      if (removed) await redis.del(`${prefix}:cooldown:${key}`);
      return removed;
    },
  };
}

export type SendAlert = (text: string) => Promise<void>;

/** Posts to a Slack-compatible incoming webhook. */
export function webhookSender(url: string, fetchFn: typeof fetch = fetch): SendAlert {
  return async (text) => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Alert webhook responded ${res.status}`);
  };
}

/**
 * Notifies new (or still-firing, once per cooldown) alerts and resolutions. Everything is
 * logged; `send` also posts it when configured. A failed post is retried on the next check.
 */
export async function notifyAlerts({
  alerts,
  store,
  send,
  cooldownMs,
  log,
}: {
  alerts: Alert[];
  store: AlertStore;
  send?: SendAlert;
  cooldownMs: number;
  log: Pick<Logger, 'error' | 'warn' | 'info'>;
}): Promise<{ notified: string[]; resolved: string[] }> {
  const notified: string[] = [];
  const resolved: string[] = [];

  for (const alert of alerts) {
    if (!(await store.claim(alert.key, cooldownMs))) continue;
    const level = alert.severity === 'critical' ? 'error' : 'warn';
    log[level]({ alert: alert.key, details: alert.details }, `ALERT: ${alert.message}`);
    try {
      await send?.(`${alert.severity === 'critical' ? '🔴' : '🟠'} LeadFlow: ${alert.message}`);
      await store.markFiring(alert.key);
      notified.push(alert.key);
    } catch (err) {
      log.error({ err, alert: alert.key }, 'alert notification failed');
      await store.release(alert.key);
    }
  }

  const current = new Set(alerts.map((a) => a.key));
  for (const key of await store.firing()) {
    if (current.has(key) || !(await store.resolve(key))) continue;
    log.info({ alert: key }, 'alert resolved');
    try {
      await send?.(`✅ LeadFlow: resolved: ${key}`);
    } catch (err) {
      log.error({ err, alert: key }, 'alert notification failed');
    }
    resolved.push(key);
  }
  return { notified, resolved };
}
