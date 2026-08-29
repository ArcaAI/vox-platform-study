/**
 * `VisitTypeService` — the tenant → SYSTEM cascade, seen from a call site.
 *
 * The cascade itself belongs to `TenantSettingsService` and is pinned by its
 * own suite; what is pinned HERE is the contract the ruling actually made:
 * a tenant with no opinion inherits the two shipped defaults, a tenant that
 * defines its own gets its own, and the customer tenant `50000000-…` is a
 * tenant like any other — never a fallback tier for anybody else.
 */
import { describe, expect, it } from 'vitest';
import { TenantSettingsService } from '../../../settings-registry/tenant-settings.service';
import { CONSULTATION_VISIT_TYPES_KEY, type VisitTypeDefinition } from '../visit-type.catalogue';
import { VisitTypeService } from '../visit-type.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
/** "Global" — a CUSTOMER tenant (the platform-admin playground), NOT a config tier. */
const GLOBAL_CUSTOMER_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const ACME = 'aaaaaaaa-0000-0000-0000-00000000000a';

const TELEHEALTH: VisitTypeDefinition[] = [
  { key: 'telehealth-revisit', label: 'Telehealth revisit', aliases: ['tele-followup'], promptSlot: 'revisit' },
  { key: 'walk-in', label: 'Walk-in', aliases: [], promptSlot: 'new-patient' },
];

/** The same fake AppSettings cache shape the settings-registry suites use. */
function settings(platform: unknown, perTenant: Record<string, unknown> = {}): TenantSettingsService {
  return new TenantSettingsService({
    getValueFromCache: (key: string) => (key === CONSULTATION_VISIT_TYPES_KEY ? (platform ?? null) : null),
    getTenantValueFromCache: (tenantId: string, key: string) => (key === CONSULTATION_VISIT_TYPES_KEY ? (perTenant[tenantId] ?? null) : null),
  } as never);
}

describe('the cascade', () => {
  it('inherits the two shipped defaults when nobody has an opinion', () => {
    const service = new VisitTypeService(settings(null));
    expect(service.catalogue(ACME).map((v) => v.key)).toEqual(['new-visit', 'revisit']);
  });

  it('inherits the SYSTEM row when the platform has an opinion and the tenant does not', () => {
    const service = new VisitTypeService(settings(TELEHEALTH));
    expect(service.catalogue(ACME).map((v) => v.key)).toEqual(['telehealth-revisit', 'walk-in']);
  });

  it('serves the TENANT’s own catalogue over the platform’s', () => {
    const own: VisitTypeDefinition[] = [
      { key: 'clinic-visit', label: 'Clinic visit', aliases: [], promptSlot: 'new-patient' },
      { key: 'clinic-review', label: 'Clinic review', aliases: [], promptSlot: 'revisit' },
    ];
    const service = new VisitTypeService(settings(TELEHEALTH, { [ACME]: own }));
    expect(service.catalogue(ACME).map((v) => v.key)).toEqual(['clinic-visit', 'clinic-review']);
    // …and no other tenant is affected by it.
    expect(service.catalogue('bbbbbbbb-0000-0000-0000-00000000000b').map((v) => v.key)).toEqual(['telehealth-revisit', 'walk-in']);
  });

  it('never lets the "Global" CUSTOMER tenant become anyone else’s fallback', () => {
    const globalPlayground: VisitTypeDefinition[] = [
      { key: 'playground-visit', label: 'Playground visit', aliases: [], promptSlot: 'new-patient' },
      { key: 'playground-review', label: 'Playground review', aliases: [], promptSlot: 'revisit' },
    ];
    const service = new VisitTypeService(settings(null, { [GLOBAL_CUSTOMER_TENANT_ID]: globalPlayground }));
    // The playground tenant sees its own trial catalogue…
    expect(service.catalogue(GLOBAL_CUSTOMER_TENANT_ID).map((v) => v.key)).toEqual(['playground-visit', 'playground-review']);
    // …and every other tenant, and the tenant-less lane, still see the SYSTEM tier.
    expect(service.catalogue(ACME).map((v) => v.key)).toEqual(['new-visit', 'revisit']);
    expect(service.catalogue(null).map((v) => v.key)).toEqual(['new-visit', 'revisit']);
    expect(service.catalogue(SYSTEM_TENANT_ID).map((v) => v.key)).toEqual(['new-visit', 'revisit']);
  });

  it('discards a MALFORMED stored catalogue rather than letting it take out prompt resolution', () => {
    const service = new VisitTypeService(settings([{ key: 'only-new', label: 'Only new', aliases: [], promptSlot: 'new-patient' }]));
    expect(service.catalogue(ACME).map((v) => v.key)).toEqual(['new-visit', 'revisit']);
  });

  it('degrades to the shipped default when the settings lane is not wired at all', () => {
    const service = new VisitTypeService();
    expect(service.catalogue(ACME).map((v) => v.key)).toEqual(['new-visit', 'revisit']);
  });
});

describe('what the call sites ask it', () => {
  it('resolves a consultation’s visit type from the tenant’s own vocabulary', () => {
    const service = new VisitTypeService(settings(null, { [ACME]: TELEHEALTH }));
    expect(service.forConsultation(ACME, { isFollowUp: true }).label).toBe('Telehealth revisit');
    expect(service.forConsultation(ACME, { isFollowUp: false }).label).toBe('Walk-in');
    expect(service.forConsultation(ACME, { recorded: 'tele-followup', isFollowUp: false }).key).toBe('telehealth-revisit');
  });

  it('maps a tenant-defined visit type onto the Department prompt column it declares', () => {
    const service = new VisitTypeService(settings(null, { [ACME]: TELEHEALTH }));
    expect(service.promptSlot(ACME, 'telehealth-revisit')).toBe('revisit');
    expect(service.promptSlot(ACME, 'walk-in')).toBe('new-patient');
    // Phase selectors are not visit types; they carry no visit-type opinion.
    expect(service.promptSlot(ACME, 'pre-summary')).toBe('new-patient');
    expect(service.promptSlot(ACME, 'live')).toBe('new-patient');
  });

  it('answers the membership question a route needs to accept or refuse a value', () => {
    const service = new VisitTypeService(settings(null));
    expect(service.match(ACME, 'new_visit')?.key).toBe('new-visit');
    expect(service.match(ACME, 'nonsense')).toBeNull();
  });
});
