import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

export type SuppressionReason = 'erasure_request' | 'opted_out';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Hashes of a person's normalized addresses (lowercased email, E.164 phone), so the
 * suppression list and the erasure log can match people without keeping their data.
 */
export function addressHashes(contact: { email?: string | null; phone?: string | null }) {
  return [
    contact.email && hash(`email:${contact.email}`),
    contact.phone && hash(`phone:${contact.phone}`),
  ].filter((h): h is string => Boolean(h));
}

export async function suppress(tx: Tx, hashes: string[], reason: SuppressionReason) {
  if (hashes.length === 0) return 0;
  const { count } = await tx.suppression.createMany({
    data: hashes.map((h) => ({ hash: h, reason })),
    skipDuplicates: true,
  });
  return count;
}

export async function isSuppressed(
  tx: Tx,
  contact: { email?: string | null; phone?: string | null },
): Promise<boolean> {
  const hashes = addressHashes(contact);
  if (hashes.length === 0) return false;
  return (await tx.suppression.count({ where: { hash: { in: hashes } } })) > 0;
}
