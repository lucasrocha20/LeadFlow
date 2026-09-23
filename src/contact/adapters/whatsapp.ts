import { templateParameters } from '../templates.js';
import { PermanentSendError, throwForResponse, type MessagingAdapter } from './types.js';

const GRAPH_API = 'https://graph.facebook.com/v23.0';

/**
 * WhatsApp Cloud API. Always sends an approved template message, which is required to start
 * a conversation: `template.name` and `template.locale` must match the template in Meta, and
 * the variables in `template.body` fill its body parameters in order of appearance.
 */
export function whatsappAdapter(opts: {
  accessToken: string;
  phoneNumberId: string;
  fetch?: typeof fetch;
}): MessagingAdapter {
  const doFetch = opts.fetch ?? fetch;
  return {
    provider: 'whatsapp',
    async send({ to, template, vars }) {
      if (!template.locale) {
        throw new PermanentSendError(`WhatsApp template "${template.name}" has no locale`);
      }
      const parameters = templateParameters(template.body, vars).map((text) => ({
        type: 'text',
        text,
      }));
      const res = await doFetch(`${GRAPH_API}/${opts.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: template.name,
            language: { code: template.locale },
            components: parameters.length > 0 ? [{ type: 'body', parameters }] : [],
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) await throwForResponse('whatsapp', res);
      const data = (await res.json()) as { messages?: { id: string }[] };
      const externalId = data.messages?.[0]?.id;
      if (!externalId) throw new Error('whatsapp response had no message id');
      return { externalId };
    },
  };
}
