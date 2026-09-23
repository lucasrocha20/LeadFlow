import { UnrecoverableError, type Job } from 'bullmq';
import { asJson, isUniqueViolation, type Db } from '../db.js';
import { enrollLead } from '../followup/enrollment.js';
import type { LeadTier } from '../generated/prisma/client.js';
import type { FollowUpStepJob, JobQueue, SendMessageJob } from '../queue.js';
import type { MessageAdapters } from './adapters/index.js';
import { PermanentSendError } from './adapters/types.js';
import { channelAddress, ineligibleReason } from './eligibility.js';
import { leadTemplateVars } from './templates.js';

export type SendOutcome =
  | {
      status: 'sent';
      eventId: string;
      externalId: string;
      provider: string;
      /** Set when this first contact enrolled the lead in a follow-up sequence. */
      enrolled?: FollowUpStepJob;
    }
  | { status: 'skipped'; reason: string }
  | { status: 'duplicate' };

export type SendMessage = (
  job: SendMessageJob,
  attempt: { final: boolean },
) => Promise<SendOutcome>;

/**
 * Handles `message.send`: re-checks eligibility (things may have changed while the job waited
 * out quiet hours), renders and sends the template, and records `message_sent` (or
 * `rep_notified`). A failure is recorded as `message_failed` once it's permanent or on the
 * last attempt, then rethrown so BullMQ retries or gives up. The first successful first
 * contact moves the lead to `contacted` and enrolls it in its tier's follow-up sequence.
 */
export function createSendMessage({
  db,
  adapters,
  queue,
  followUpSequences = {},
  unsubscribeUrl,
  now = () => new Date(),
}: {
  db: Db;
  adapters: MessageAdapters;
  queue: Pick<JobQueue, 'enqueueFollowUpStep'>;
  /** Sequence name per tier, from the contact config. */
  followUpSequences?: Partial<Record<LeadTier, string>>;
  /** Builds the lead's `{{unsubscribeUrl}}`; unset when unsubscribe links aren't configured. */
  unsubscribeUrl?: (leadId: string) => string;
  now?: () => Date;
}): SendMessage {
  async function recordFailure(job: SendMessageJob, err: unknown) {
    try {
      await db.leadEvent.create({
        data: {
          leadId: job.leadId,
          type: 'message_failed',
          channel: job.channel,
          dedupeKey: `${job.dedupeKey}:failed`,
          payload: asJson({
            kind: job.kind,
            template: job.template,
            error: err instanceof Error ? err.message : String(err),
            permanent: err instanceof PermanentSendError,
          }),
        },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }

  return async function sendMessage(job, attempt) {
    const already = await db.leadEvent.findUnique({ where: { dedupeKey: job.dedupeKey } });
    if (already) return { status: 'duplicate' };

    const lead = await db.lead.findUnique({ where: { id: job.leadId } });
    if (!lead) return { status: 'skipped', reason: 'lead not found' };

    let to: string | null | undefined = job.to;
    if (job.kind !== 'rep_alert') {
      const reason = ineligibleReason(lead, job.channel);
      if (reason) return { status: 'skipped', reason };
      to = channelAddress(lead, job.channel);
    }
    if (job.kind === 'follow_up') {
      const enrollment = job.enrollmentId
        ? await db.enrollment.findUnique({ where: { id: job.enrollmentId } })
        : null;
      if (enrollment?.status !== 'active') {
        return { status: 'skipped', reason: `enrollment is ${enrollment?.status ?? 'missing'}` };
      }
    }

    const vars = { ...leadTemplateVars(lead), ...job.vars };
    // Rep alerts go to our own team: never hand them the lead's unsubscribe link.
    if (unsubscribeUrl && job.kind !== 'rep_alert')
      vars['unsubscribeUrl'] = unsubscribeUrl(lead.id);

    let sent: { externalId: string; provider: string };
    try {
      const adapter = adapters[job.channel];
      if (!adapter) throw new PermanentSendError(`No provider for ${job.channel}`);
      if (!to) throw new PermanentSendError('No recipient');
      const template = await db.template.findUnique({ where: { name: job.template } });
      if (!template) throw new PermanentSendError(`Template "${job.template}" not found`);
      if (template.channel !== job.channel) {
        throw new PermanentSendError(
          `Template "${job.template}" is for ${template.channel}, not ${job.channel}`,
        );
      }
      const { externalId } = await adapter.send({
        to,
        template,
        vars,
        idempotencyKey: job.dedupeKey,
      });
      sent = { externalId, provider: adapter.provider };
    } catch (err) {
      if (err instanceof PermanentSendError || attempt.final) await recordFailure(job, err);
      throw err;
    }

    let result: { eventId: string; enrolled: FollowUpStepJob | null };
    try {
      result = await db.$transaction(async (tx) => {
        let enrolled: FollowUpStepJob | null = null;
        if (job.kind === 'first_contact') {
          // Only one transaction can make this transition, so the lead is enrolled once.
          const { count } = await tx.lead.updateMany({
            where: { id: lead.id, status: 'qualified' },
            data: { status: 'contacted' },
          });
          if (count === 1) enrolled = await enrollLead(tx, lead, followUpSequences, now());
        }
        const event = await tx.leadEvent.create({
          data: {
            leadId: lead.id,
            type: job.kind === 'rep_alert' ? 'rep_notified' : 'message_sent',
            channel: job.channel,
            dedupeKey: job.dedupeKey,
            payload: asJson({
              kind: job.kind,
              template: job.template,
              to,
              ...sent,
              ...(job.enrollmentId && { enrollmentId: job.enrollmentId }),
            }),
          },
        });
        return { eventId: event.id, enrolled };
      });
    } catch (err) {
      // Another run of the same message recorded it first.
      if (isUniqueViolation(err)) return { status: 'duplicate' };
      throw err;
    }

    // If this fails, the enrollment's nextRunAt is saved and the reconcile sweep queues it.
    if (result.enrolled) await queue.enqueueFollowUpStep(result.enrolled);
    return {
      status: 'sent',
      eventId: result.eventId,
      ...sent,
      ...(result.enrolled && { enrolled: result.enrolled }),
    };
  };
}

/** Runs a `message.send` job: permanent failures skip BullMQ's remaining attempts. */
export async function runSendMessageJob(
  sendMessage: SendMessage,
  job: Pick<Job<SendMessageJob>, 'data' | 'attemptsMade' | 'opts'>,
): Promise<SendOutcome> {
  // attemptsMade counts the attempts that already failed.
  const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  try {
    return await sendMessage(job.data, { final });
  } catch (err) {
    if (err instanceof PermanentSendError) throw new UnrecoverableError(err.message);
    throw err;
  }
}
