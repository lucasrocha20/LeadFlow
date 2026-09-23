import { asJson, type Db } from '../db.js';
import type { Lead, Prisma } from '../generated/prisma/client.js';
import { stopEnrollments } from '../followup/enrollment.js';

type Tx = Prisma.TransactionClient;

// "Stop!", "stop", "PARAR." and "Descadastrar" all become "STOP", "PARAR", "DESCADASTRAR".
function normalizeKeyword(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/**
 * True when the reply's first non-empty line, or its subject, is exactly an opt-out keyword.
 * Exact matches only: "please stop by our booth" is not an opt-out.
 */
export function isOptOut(
  message: { text: string; subject?: string },
  keywords: readonly string[],
): boolean {
  const wanted = new Set(keywords.map(normalizeKeyword));
  const firstLine = message.text.split('\n').find((line) => line.trim()) ?? '';
  return [firstLine, message.subject ?? ''].some((text) => wanted.has(normalizeKeyword(text)));
}

/**
 * Marks the lead `do_not_contact`, records `opted_out` and stops its sequences. Pending
 * messages are dropped when they re-check the status at send time. Idempotent.
 */
export async function optOutInTx(
  tx: Tx,
  lead: Pick<Lead, 'id' | 'status'>,
  source: 'reply' | 'unsubscribe_link',
): Promise<boolean> {
  if (lead.status === 'do_not_contact') return false;
  await tx.lead.update({ where: { id: lead.id }, data: { status: 'do_not_contact' } });
  await tx.leadEvent.create({
    data: {
      leadId: lead.id,
      type: 'opted_out',
      payload: asJson({ source, previousStatus: lead.status }),
    },
  });
  await stopEnrollments(tx, lead.id, 'opted_out');
  return true;
}

/** Opts a lead out by id (unsubscribe link). Returns false when unknown or already opted out. */
export function createOptOut(db: Db) {
  return async function optOut(leadId: string): Promise<boolean> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Lead" WHERE id = ${leadId} FOR UPDATE`;
      const lead = await tx.lead.findUnique({ where: { id: leadId } });
      if (!lead) return false;
      return optOutInTx(tx, lead, 'unsubscribe_link');
    });
  };
}
