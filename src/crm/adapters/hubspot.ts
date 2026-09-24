import { createRateLimiter } from '../rateLimiter.js';
import {
  CrmNotFoundError,
  CrmPermanentError,
  CrmRateLimitError,
  type CrmAdapter,
  type CrmContact,
} from '../types.js';

const API = 'https://api.hubapi.com';
// HubSpot's predefined note → contact association.
const NOTE_TO_CONTACT = 202;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function contactProperties(contact: CrmContact): Record<string, string> {
  const properties: Record<string, string | null> = {
    email: contact.email,
    phone: contact.phone,
    firstname: contact.firstName,
    lastname: contact.lastName,
    company: contact.company,
  };
  // Only send what we know, so we never blank a field a rep filled in.
  return Object.fromEntries(
    Object.entries(properties).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

/**
 * HubSpot CRM v3 with a private app token. Contacts are matched by the stored id, then by
 * email; stages are contact properties (`hs_lead_status`, `lifecyclestage`); activities are
 * notes on the contact. Calls are throttled below the private-app limit (100 per 10s).
 */
export function hubspotAdapter(opts: {
  accessToken: string;
  fetch?: typeof fetch;
  /** Max requests per 10 seconds from this process. */
  requestsPer10s?: number;
}): CrmAdapter {
  const doFetch = opts.fetch ?? fetch;
  const acquire = createRateLimiter(opts.requestsPer10s ?? 90, 10_000);

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    await acquire();
    const res = await doFetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.accessToken}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

    const detail = `hubspot ${method} ${path} responded ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new CrmRateLimitError(
        detail,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 10_000,
      );
    }
    if (res.status === 404) throw new CrmNotFoundError(detail);
    if (res.status >= 500) throw new Error(detail);
    throw new CrmPermanentError(detail);
  }

  const patchContact = (crmId: string, properties: Record<string, string>) =>
    call('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(crmId)}`, { properties });

  return {
    provider: 'hubspot',

    async upsertContact(contact, crmId) {
      const properties = contactProperties(contact);
      if (crmId) {
        await patchContact(crmId, properties);
        return crmId;
      }
      if (contact.email) {
        const { results } = await call<{ results: { id: string }[] }>(
          'POST',
          '/crm/v3/objects/contacts/batch/upsert',
          { inputs: [{ idProperty: 'email', id: contact.email, properties }] },
        );
        const id = results[0]?.id;
        if (!id) throw new Error('hubspot upsert returned no contact id');
        return id;
      }
      // Phone-only lead: HubSpot can't upsert by phone, so create it.
      const { id } = await call<{ id: string }>('POST', '/crm/v3/objects/contacts', { properties });
      return id;
    },

    async updateStage(crmId, stage) {
      if (Object.keys(stage).length > 0) await patchContact(crmId, stage);
    },

    async assignOwner(crmId, ownerId) {
      await patchContact(crmId, { hubspot_owner_id: ownerId });
    },

    async deleteContact(crmId) {
      // GDPR delete: permanent, unlike DELETE /contacts/{id} which only archives.
      try {
        await call('POST', '/crm/v3/objects/contacts/gdpr-delete', { objectId: crmId });
      } catch (err) {
        if (!(err instanceof CrmNotFoundError)) throw err;
      }
    },

    async logActivity(crmId, activity) {
      const body = activity.body
        ? `<strong>${escapeHtml(activity.title)}</strong><br>${escapeHtml(activity.body).replaceAll('\n', '<br>')}`
        : `<strong>${escapeHtml(activity.title)}</strong>`;
      await call('POST', '/crm/v3/objects/notes', {
        properties: { hs_timestamp: activity.occurredAt.toISOString(), hs_note_body: body },
        associations: [
          {
            to: { id: crmId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }],
          },
        ],
      });
    },
  };
}
