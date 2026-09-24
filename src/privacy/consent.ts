import { asJson } from '../db.js';
import type { ConsentPurpose, Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

const PURPOSES: ConsentPurpose[] = ['email', 'messaging'];

/** Records a grant for each purpose the submission consented to (every submission counts). */
export async function recordConsentGrants(
  tx: Tx,
  leadId: string,
  consent: { email: boolean; messaging: boolean },
  source: string,
  evidence: Record<string, unknown> | undefined,
): Promise<number> {
  const granted = PURPOSES.filter((purpose) => consent[purpose]);
  if (granted.length === 0) return 0;
  await tx.consentRecord.createMany({
    data: granted.map((purpose) => ({
      leadId,
      purpose,
      granted: true,
      source,
      evidence: evidence ? asJson(evidence) : undefined,
    })),
  });
  return granted.length;
}

/** Withdraws consent for every purpose: records it and clears the lead's consent flags. */
export async function withdrawConsent(
  tx: Tx,
  leadId: string,
  source: string,
  evidence?: Record<string, unknown>,
) {
  await tx.lead.update({
    where: { id: leadId },
    data: { consentEmail: false, consentMessaging: false },
  });
  await tx.consentRecord.createMany({
    data: PURPOSES.map((purpose) => ({
      leadId,
      purpose,
      granted: false,
      source,
      evidence: evidence ? asJson(evidence) : undefined,
    })),
  });
}
