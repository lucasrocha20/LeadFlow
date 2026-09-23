import { describe, expect, it } from 'vitest';
import { loadCrmConfig, parseCrmConfig } from '../src/crm/config.js';

describe('CRM config', () => {
  const defaults = loadCrmConfig('config/crm.json');

  it('loads config/crm.json with a stage for every status', () => {
    expect(Object.keys(defaults.stages).sort()).toEqual([
      'contacted',
      'converted',
      'disqualified',
      'do_not_contact',
      'engaged',
      'new',
      'qualified',
      'unresponsive',
    ]);
    expect(defaults.stages.engaged).toEqual({
      hs_lead_status: 'CONNECTED',
      lifecyclestage: 'salesqualifiedlead',
    });
    expect(defaults.inbound).toEqual([
      { property: 'lifecyclestage', value: 'customer', status: 'converted' },
    ]);
  });

  it('rejects a missing stage, an unknown status or an unknown tier', () => {
    const { new: _omit, ...stages } = defaults.stages;
    expect(() => parseCrmConfig({ ...defaults, stages })).toThrow(/new/);
    expect(() =>
      parseCrmConfig({ ...defaults, inbound: [{ property: 'p', value: 'v', status: 'won' }] }),
    ).toThrow(/Invalid CRM config/);
    expect(() => parseCrmConfig({ ...defaults, owners: { vip: '1' } })).toThrow(
      /Invalid CRM config/,
    );
  });
});
