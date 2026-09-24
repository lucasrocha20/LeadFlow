import type { FastifyPluginAsync, FastifyReply } from 'fastify';

export interface UnsubscribeDeps {
  verify(leadId: string, token: string): boolean;
  optOut(leadId: string): Promise<unknown>;
}

function page(reply: FastifyReply, status: number, title: string, body: string) {
  return (
    reply
      .code(status)
      .type('text/html; charset=utf-8')
      // The URL carries the lead's token: never leak it in a Referer, cache it, or frame the page.
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      )
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(
        `<!doctype html><html><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<title>${title}</title></head>` +
          `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem">` +
          `<h1>${title}</h1>${body}</body></html>`,
      )
  );
}

/**
 * GET shows a confirmation button and POST unsubscribes, so link scanners that prefetch URLs
 * don't opt people out. POST also serves one-click unsubscribe (RFC 8058) from mail clients.
 */
export const unsubscribeRoutes: FastifyPluginAsync<{ unsubscribe: UnsubscribeDeps }> = async (
  app,
  { unsubscribe },
) => {
  // Form posts and one-click requests send a body we don't need.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, _body, done) => done(null, undefined),
  );

  function valid(query: unknown): string | null {
    const { lead, token } = query as { lead?: string; token?: string };
    return lead && token && unsubscribe.verify(lead, token) ? lead : null;
  }

  const invalid = (reply: FastifyReply) =>
    page(reply, 400, 'Invalid link', '<p>This unsubscribe link is invalid or incomplete.</p>');

  app.get('/unsubscribe', async (request, reply) => {
    if (!valid(request.query)) return invalid(reply);
    return page(
      reply,
      200,
      'Unsubscribe',
      '<p>Stop receiving messages from us on every channel?</p>' +
        '<form method="post"><button type="submit">Unsubscribe</button></form>',
    );
  });

  app.post('/unsubscribe', async (request, reply) => {
    const leadId = valid(request.query);
    if (!leadId) return invalid(reply);
    await unsubscribe.optOut(leadId);
    request.log.info({ leadId }, 'lead unsubscribed');
    return page(reply, 200, 'Unsubscribed', "<p>You won't receive any more messages from us.</p>");
  });
};
