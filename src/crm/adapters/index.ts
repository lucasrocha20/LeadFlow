import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import type { CrmAdapter } from '../types.js';
import { dryRunCrmAdapter } from './dryRun.js';
import { hubspotAdapter } from './hubspot.js';

export function createCrmAdapter(
  config: Pick<Config, 'CRM_PROVIDER' | 'HUBSPOT_ACCESS_TOKEN'>,
  log: Logger,
): CrmAdapter {
  return config.CRM_PROVIDER === 'hubspot'
    ? hubspotAdapter({ accessToken: config.HUBSPOT_ACCESS_TOKEN! })
    : dryRunCrmAdapter(log);
}
