import { asJson, type Db } from '../db.js';
import type { Channel } from '../generated/prisma/client.js';
import type { ContactConfig } from '../contact/config.js';
import { CONTACTABLE_STATUSES } from '../contact/eligibility.js';
import { quietHoursDelayMs } from '../contact/quietHours.js';
import type { FollowUpStepJob, JobQueue, SendMessageJob } from '../queue.js';
import { followUpKey, stopEnrollments } from './enrollment.js';

const MINUTE = 60_000;
/** A job may fire slightly early (clock skew); more than this means it's for an old schedule. */
const EARLY_TOLERANCE_MS = 60_000;

export type StepOutcome =
  | { status: 'queued'; step: number; channel: Channel; next: FollowUpStepJob }
  | { status: 'completed' }
  | { status: 'stopped'; reason: string }
  | { status: 'skipped'; reason: string };

export type RunFollowUpStep = (job: FollowUpStepJob) => Promise<StepOutcome>;

interface Scheduled {
  message: SendMessageJob;
  timezone: string | null;
  next: FollowUpStepJob;
}

/**
 * Handles `followup.step`: queues the step's message and schedules the next step, or, past the
 * last step, completes the enrollment and marks a still-silent lead `unresponsive`. Messages
 * go through `message.send`, which re-checks consent and status when it actually sends.
 */
export function createRunFollowUpStep({
  db,
  queue,
  quietHours,
  now = () => new Date(),
}: {
  db: Db;
  queue: JobQueue;
  quietHours: ContactConfig['quietHours'];
  now?: () => Date;
}): RunFollowUpStep {
  async function schedule({ message, timezone, next }: Scheduled) {
    const delayMs = quietHours.channels.includes(message.channel)
      ? quietHoursDelayMs(now(), timezone ?? quietHours.defaultTimezone, quietHours)
      : 0;
    await queue.enqueueSendMessage(message, { delayMs });
    await queue.enqueueFollowUpStep(next);
  }

  return async function runFollowUpStep(job) {
    const at = now();
    const result = await db.$transaction(
      async (tx): Promise<StepOutcome | { status: 'scheduled'; scheduled: Scheduled }> => {
        await tx.$executeRaw`SELECT 1 FROM "Enrollment" WHERE id = ${job.enrollmentId} FOR UPDATE`;
        const enrollment = await tx.enrollment.findUnique({
          where: { id: job.enrollmentId },
          include: {
            lead: true,
            sequence: {
              include: { steps: { orderBy: { order: 'asc' }, include: { template: true } } },
            },
          },
        });
        if (!enrollment) return { status: 'skipped', reason: 'enrollment not found' };
        if (enrollment.status !== 'active') {
          return { status: 'skipped', reason: `enrollment is ${enrollment.status}` };
        }

        const { lead, sequence } = enrollment;
        const steps = sequence.steps;
        const messageFor = (order: number): SendMessageJob | null => {
          const step = steps.find((s) => s.order === order);
          if (!step) return null;
          return {
            leadId: lead.id,
            kind: 'follow_up',
            channel: step.channel,
            template: step.template.name,
            dedupeKey: followUpKey(enrollment.id, step.order),
            enrollmentId: enrollment.id,
          };
        };
        const current: FollowUpStepJob = {
          enrollmentId: enrollment.id,
          step: enrollment.currentStep,
          runAt: enrollment.nextRunAt?.getTime() ?? at.getTime(),
        };

        // Already advanced past this step: a retry after a failed enqueue. Queue again; the
        // job ids and the message's dedupe key make this a no-op if it already went out.
        if (enrollment.currentStep > job.step) {
          const message = messageFor(job.step);
          if (!message) return { status: 'skipped', reason: 'stale job' };
          return {
            status: 'scheduled',
            scheduled: { message, timezone: lead.timezone, next: current },
          };
        }
        if (enrollment.currentStep !== job.step) return { status: 'skipped', reason: 'stale job' };
        if (
          enrollment.nextRunAt &&
          enrollment.nextRunAt.getTime() > at.getTime() + EARLY_TOLERANCE_MS
        ) {
          return { status: 'skipped', reason: 'not due yet' };
        }

        // Replied, opted out, converted…: nothing more to send.
        if (!CONTACTABLE_STATUSES.includes(lead.status)) {
          const reason = `lead is ${lead.status}`;
          await stopEnrollments(tx, lead.id, reason);
          return { status: 'stopped', reason };
        }

        const step = steps.find((s) => s.order === job.step);
        if (!step) {
          await tx.enrollment.update({
            where: { id: enrollment.id },
            data: { status: 'completed', nextRunAt: null },
          });
          await tx.lead.updateMany({
            where: { id: lead.id, status: 'contacted' },
            data: { status: 'unresponsive' },
          });
          await tx.leadEvent.create({
            data: {
              leadId: lead.id,
              type: 'sequence_completed',
              payload: asJson({ enrollmentId: enrollment.id, sequence: sequence.name }),
            },
          });
          return { status: 'completed' };
        }

        // Next step (or, after the last one, the completion check). Offsets count from
        // enrollment, but after downtime keep at least the planned gap instead of bursting.
        const next = steps.find((s) => s.order > step.order);
        const enrolledAt = enrollment.createdAt.getTime();
        const gapMinutes = next
          ? next.offsetMinutes - step.offsetMinutes
          : sequence.finalWaitMinutes;
        const nextRunAt = new Date(
          Math.max(
            enrolledAt + (step.offsetMinutes + gapMinutes) * MINUTE,
            at.getTime() + gapMinutes * MINUTE,
          ),
        );
        const nextStep = next?.order ?? step.order + 1;
        await tx.enrollment.update({
          where: { id: enrollment.id },
          data: { currentStep: nextStep, nextRunAt },
        });

        return {
          status: 'scheduled',
          scheduled: {
            message: messageFor(step.order)!,
            timezone: lead.timezone,
            next: { enrollmentId: enrollment.id, step: nextStep, runAt: nextRunAt.getTime() },
          },
        };
      },
    );

    if (result.status !== 'scheduled') return result;
    await schedule(result.scheduled);
    const { message, next } = result.scheduled;
    return { status: 'queued', step: job.step, channel: message.channel, next };
  };
}
