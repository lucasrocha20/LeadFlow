/** Contact data pushed to the CRM. Null fields are left untouched there. */
export interface CrmContact {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
}

/** One entry on the contact's timeline (a note in HubSpot). */
export interface CrmActivity {
  title: string;
  body: string;
  occurredAt: Date;
}

/** One implementation per CRM (the plan's `CrmAdapter`). */
export interface CrmAdapter {
  provider: string;
  /** Creates or updates the contact; returns its CRM id. Pass `crmId` once known. */
  upsertContact(contact: CrmContact, crmId: string | null): Promise<string>;
  /** Sets the CRM fields that represent the lead's stage (from `config/crm.json`). */
  updateStage(crmId: string, stage: Record<string, string>): Promise<void>;
  logActivity(crmId: string, activity: CrmActivity): Promise<void>;
  assignOwner(crmId: string, ownerId: string): Promise<void>;
  /** Permanently deletes the contact (data-subject erasure). Already gone counts as done. */
  deleteContact(crmId: string): Promise<void>;
}

/** Retrying won't help (validation error, missing scope…): the sync is dead-lettered. */
export class CrmPermanentError extends Error {
  override name = 'CrmPermanentError';
}

/** The CRM's rate limit was hit; wait `retryAfterMs` before calling it again. */
export class CrmRateLimitError extends Error {
  override name = 'CrmRateLimitError';
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/** The contact behind a stored `crmId` no longer exists (deleted or merged in the CRM). */
export class CrmNotFoundError extends Error {
  override name = 'CrmNotFoundError';
}
