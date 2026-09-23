import type { Config } from '../../config.js';
import type { FormAdapter } from '../types.js';
import { typeformAdapter } from './typeform.js';
import { websiteFormAdapter } from './website.js';

type AdapterConfig = Pick<
  Config,
  'DEFAULT_PHONE_COUNTRY' | 'FORM_WEBHOOK_SECRET' | 'TYPEFORM_WEBHOOK_SECRET'
>;

/** Form adapters keyed by the `:provider` URL segment. Providers without a secret stay disabled. */
export function createFormAdapters(config: AdapterConfig): Record<string, FormAdapter> {
  const defaultCountry = config.DEFAULT_PHONE_COUNTRY;
  const adapters: Record<string, FormAdapter> = {};
  if (config.FORM_WEBHOOK_SECRET) {
    adapters['website'] = websiteFormAdapter({
      secret: config.FORM_WEBHOOK_SECRET,
      defaultCountry,
    });
  }
  if (config.TYPEFORM_WEBHOOK_SECRET) {
    adapters['typeform'] = typeformAdapter({
      secret: config.TYPEFORM_WEBHOOK_SECRET,
      defaultCountry,
    });
  }
  return adapters;
}
