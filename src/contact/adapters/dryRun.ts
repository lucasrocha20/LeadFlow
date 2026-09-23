import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { renderTemplate } from '../templates.js';
import type { MessageAdapter } from './types.js';

/** Development adapter: renders the message and logs it instead of sending it. */
export function dryRunAdapter(log: Pick<Logger, 'info'>): MessageAdapter {
  return {
    provider: 'dry-run',
    async send({ to, template, vars }) {
      const externalId = `dry-run-${randomUUID()}`;
      log.info(
        {
          externalId,
          channel: template.channel,
          to,
          template: template.name,
          subject: template.subject ? renderTemplate(template.subject, vars) : undefined,
          body: renderTemplate(template.body, vars),
        },
        'dry-run message',
      );
      return { externalId };
    },
  };
}
