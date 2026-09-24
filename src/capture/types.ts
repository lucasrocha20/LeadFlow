export interface Utm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

/** A form submission normalized into LeadFlow's shape, independent of the provider. */
export interface LeadInput {
  /** Provider-side id of the submission. Together with the source it is the dedupe key. */
  externalId: string;
  firstName: string | null;
  lastName: string | null;
  /** Trimmed and lowercased; null when missing or invalid. */
  email: string | null;
  /** E.164; null when missing or unparseable. */
  phone: string | null;
  company: string | null;
  /** IANA time zone, e.g. "America/Sao_Paulo". */
  timezone: string | null;
  utm: Utm | null;
  /** Remaining answers keyed by field name. */
  fields: Record<string, unknown>;
  consentEmail: boolean;
  consentMessaging: boolean;
  /** Proof of the consent given (text shown, form/response ids, time…), stored in the ledger. */
  consentEvidence?: Record<string, unknown>;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export interface FormAdapter {
  /** Stored as `Lead.source` and used in the dedupe key. */
  source: string;
  /** Checks the request's signature or shared secret. */
  verify(req: WebhookRequest): boolean;
  /** Maps the parsed JSON body to a LeadInput. Throws a ZodError when the payload is malformed. */
  normalize(payload: unknown): LeadInput;
}
