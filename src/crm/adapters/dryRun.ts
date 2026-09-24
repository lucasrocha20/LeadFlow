import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { CrmAdapter } from '../types.js';

/** Development adapter: logs every CRM call instead of making it. */
export function dryRunCrmAdapter(log: Pick<Logger, 'info'>): CrmAdapter {
  return {
    provider: 'dry-run',
    async upsertContact(contact, crmId) {
      const id = crmId ?? `dry-run-${randomUUID()}`;
      log.info({ crmId: id, created: !crmId, contact }, 'dry-run crm: upsert contact');
      return id;
    },
    async updateStage(crmId, stage) {
      log.info({ crmId, stage }, 'dry-run crm: update stage');
    },
    async assignOwner(crmId, ownerId) {
      log.info({ crmId, ownerId }, 'dry-run crm: assign owner');
    },
    async deleteContact(crmId) {
      log.info({ crmId }, 'dry-run crm: delete contact');
    },
    async logActivity(crmId, activity) {
      log.info({ crmId, ...activity }, 'dry-run crm: log activity');
    },
  };
}
