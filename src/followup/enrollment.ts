import { asJson, type Db } from '../db.js';
import type { EnrollmentStatus, Lead, LeadTier, Prisma } from '../generated/prisma/client.js';
import type { FollowUpStepJob } from '../queue.js';

type Tx = Prisma.TransactionClient;

const MINUTE = 60_000;

export const followUpKey = (enrollmentId: string, step: number) =>
  `follow-up:${enrollmentId}:${step}`;

/**
 * Enrolls the lead in the follow-up sequence configured for its tier and returns the first
 * step's job, or null when there's none (or it's inactive or empty). Call it in the
 * transaction that records the first contact, so a lead is enrolled exactly once.
 */
export async function enrollLead(
  tx: Tx,
  lead: Pick<Lead, 'id' | 'tier'>,
  sequences: Partial<Record<LeadTier, string>>,
  now: Date,
): Promise<FollowUpStepJob | null> {
  const name = lead.tier ? sequences[lead.tier] : undefined;
  if (!name) return null;
  const sequence = await tx.sequence.findUnique({
    where: { name },
    include: { steps: { orderBy: { order: 'asc' }, take: 1 } },
  });
  const first = sequence?.steps[0];
  if (!sequence?.active || !first) return null;

  const nextRunAt = new Date(now.getTime() + first.offsetMinutes * MINUTE);
  const enrollment = await tx.enrollment.create({
    data: {
      leadId: lead.id,
      sequenceId: sequence.id,
      currentStep: first.order,
      nextRunAt,
      createdAt: now,
    },
  });
  await tx.leadEvent.create({
    data: {
      leadId: lead.id,
      type: 'enrolled',
      payload: asJson({ enrollmentId: enrollment.id, sequence: sequence.name }),
    },
  });
  return { enrollmentId: enrollment.id, step: first.order, runAt: nextRunAt.getTime() };
}

/** Stops every active or paused enrollment of the lead, recording why. */
export async function stopEnrollments(tx: Tx, leadId: string, reason: string) {
  // Paused ones too: a lead who replies or opts out while paused must not be resumed.
  const active = await tx.enrollment.findMany({
    where: { leadId, status: { in: ['active', 'paused'] } },
    include: { sequence: { select: { name: true } } },
  });
  for (const enrollment of active) {
    await tx.enrollment.update({
      where: { id: enrollment.id },
      data: { status: 'stopped', nextRunAt: null },
    });
    await tx.leadEvent.create({
      data: {
        leadId,
        type: 'sequence_stopped',
        payload: asJson({
          enrollmentId: enrollment.id,
          sequence: enrollment.sequence.name,
          reason,
        }),
      },
    });
  }
  return active.length;
}

/**
 * Re-enqueues the step job of every active enrollment due within `horizonMs`. The database is
 * the source of truth for the schedule; this rebuilds Redis after a restart or data loss.
 * Job ids are deterministic, so jobs that still exist are left alone.
 */
export async function reconcileEnrollments(
  db: Db,
  enqueue: (job: FollowUpStepJob) => Promise<void>,
  { now = new Date(), horizonMs }: { now?: Date; horizonMs: number },
): Promise<number> {
  const due = await db.enrollment.findMany({
    where: { status: 'active', nextRunAt: { lte: new Date(now.getTime() + horizonMs) } },
    select: { id: true, currentStep: true, nextRunAt: true },
  });
  for (const enrollment of due) {
    await enqueue({
      enrollmentId: enrollment.id,
      step: enrollment.currentStep,
      runAt: enrollment.nextRunAt!.getTime(),
    });
  }
  return due.length;
}

export type PauseOutcome =
  | { status: 'paused' | 'resumed'; enrollmentId: string; leadId: string }
  | { status: 'not_found' }
  | { status: 'conflict'; current: EnrollmentStatus };

/**
 * Pauses an active enrollment: step jobs that fire meanwhile skip it, and follow-up messages
 * already queued are dropped at send time. Replies and opt-outs still stop it.
 */
export async function pauseEnrollment(
  db: Db,
  enrollmentId: string,
  reason?: string,
): Promise<PauseOutcome> {
  return db.$transaction(async (tx) => {
    const enrollment = await lockEnrollment(tx, enrollmentId);
    if (!enrollment) return { status: 'not_found' };
    if (enrollment.status !== 'active') return { status: 'conflict', current: enrollment.status };
    await tx.enrollment.update({ where: { id: enrollmentId }, data: { status: 'paused' } });
    await tx.leadEvent.create({
      data: {
        leadId: enrollment.leadId,
        type: 'sequence_paused',
        payload: asJson({ enrollmentId, sequence: enrollment.sequence.name, reason }),
      },
    });
    return { status: 'paused', enrollmentId, leadId: enrollment.leadId };
  });
}

/**
 * Resumes a paused enrollment and returns the step job to enqueue. The step that was due is
 * rescheduled for now (never earlier than planned), and later steps keep their gaps.
 */
export async function resumeEnrollment(
  db: Db,
  enrollmentId: string,
  now = new Date(),
): Promise<PauseOutcome & { job?: FollowUpStepJob }> {
  return db.$transaction(async (tx) => {
    const enrollment = await lockEnrollment(tx, enrollmentId);
    if (!enrollment) return { status: 'not_found' };
    if (enrollment.status !== 'paused') return { status: 'conflict', current: enrollment.status };
    // A step job that fired while paused was consumed; a new runAt gives the job a new id.
    // One still pending keeps its (future) runAt and id, so enqueueing it again is a no-op.
    const nextRunAt = new Date(Math.max(enrollment.nextRunAt?.getTime() ?? 0, now.getTime()));
    await tx.enrollment.update({
      where: { id: enrollmentId },
      data: { status: 'active', nextRunAt },
    });
    await tx.leadEvent.create({
      data: {
        leadId: enrollment.leadId,
        type: 'sequence_resumed',
        payload: asJson({ enrollmentId, sequence: enrollment.sequence.name }),
      },
    });
    return {
      status: 'resumed',
      enrollmentId,
      leadId: enrollment.leadId,
      job: { enrollmentId, step: enrollment.currentStep, runAt: nextRunAt.getTime() },
    };
  });
}

async function lockEnrollment(tx: Tx, enrollmentId: string) {
  await tx.$executeRaw`SELECT 1 FROM "Enrollment" WHERE id = ${enrollmentId} FOR UPDATE`;
  return tx.enrollment.findUnique({
    where: { id: enrollmentId },
    include: { sequence: { select: { name: true } } },
  });
}
