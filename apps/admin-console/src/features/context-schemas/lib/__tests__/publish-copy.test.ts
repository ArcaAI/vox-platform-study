/**
 * The publish confirmation leads with the EFFECT, so the sentence an admin reads
 * is derived from the impact — not hand-written per case at the call site. These
 * tests pin the three variants and, more importantly, the rule that decides
 * between them: only ACTIVE consumers that would REFUSE gate the publish.
 */

import { describe, expect, it } from 'vitest';
import type { ContextSchemaUsagesResponse, ContextSchemaWorkflowUsage } from '../../api/types';
import { publishCopy } from '../publish-copy';

function workflow(overrides: Partial<ContextSchemaWorkflowUsage> = {}): ContextSchemaWorkflowUsage {
  return {
    definitionId: 'wd-1',
    slug: 'cardiology-intake',
    name: 'Cardiology intake',
    versionNumber: 3,
    status: 'PUBLISHED',
    isActive: true,
    binding: 'latest',
    boundVersion: null,
    verdict: 'accepts',
    problems: [],
    ...overrides,
  };
}

function impact(workflows: ContextSchemaWorkflowUsage[]): ContextSchemaUsagesResponse {
  return { schemaId: 's-1', againstVersion: 4, workflows, agents: [] };
}

describe('publishCopy', () => {
  it('leads with what the change adds when every consumer accepts', () => {
    const copy = publishCopy({
      nextVersion: 4,
      currentVersion: 3,
      additions: ['referral'],
      breakingChanges: null,
      impact: impact([workflow(), workflow({ definitionId: 'wd-2' })]),
    });

    expect(copy.variant).toBe('all-accept');
    expect(copy.title).toBe('Publish version 4?');
    expect(copy.description).toContain('This adds one new kind, `referral`.');
    expect(copy.description).toContain('apps built on version 3 keep working');
    expect(copy.description).toContain('2 workflows follow the latest version and will accept it.');
    expect(copy.description).toContain('None will refuse it.');
    expect(copy.acknowledgement).toBeNull();
    expect(copy.confirmLabel).toBe('Publish');
    expect(copy.destructive).toBe(false);
  });

  it('agrees the verb with a single following consumer', () => {
    const copy = publishCopy({ nextVersion: 4, currentVersion: 3, additions: ['referral'], breakingChanges: null, impact: impact([workflow()]) });

    expect(copy.description).toContain('1 workflow follows the latest version and will accept it.');
  });

  it('names the refusing consumers and gates the publish behind an acknowledgement', () => {
    const copy = publishCopy({
      nextVersion: 4,
      currentVersion: 3,
      additions: ['referral'],
      breakingChanges: null,
      impact: impact([
        workflow(),
        workflow({
          definitionId: 'wd-2',
          slug: 'ortho',
          name: 'Ortho intake',
          binding: 'pinned',
          boundVersion: 2,
          verdict: 'refuses',
          problems: ['/referral: not declared in the bound version v2'],
        }),
        workflow({
          definitionId: 'wd-3',
          slug: 'derm',
          name: 'Derm intake',
          binding: 'pinned',
          boundVersion: 1,
          verdict: 'refuses',
          problems: ['/referral: not declared in the bound version v1'],
        }),
      ]),
    });

    expect(copy.variant).toBe('some-refuse');
    expect(copy.description).toContain('2 workflows will refuse it');
    expect(copy.refusing.map((row) => row.name)).toEqual(['Ortho intake', 'Derm intake']);
    expect(copy.acknowledgement).toBe('I understand these 2 workflows will refuse new consultations until they are republished.');
    expect(copy.destructive).toBe(false);
  });

  it('ignores an INACTIVE refusing consumer for the gate but still lists it', () => {
    const copy = publishCopy({
      nextVersion: 4,
      currentVersion: 3,
      additions: ['referral'],
      breakingChanges: null,
      impact: impact([
        workflow({
          isActive: false,
          binding: 'pinned',
          boundVersion: 2,
          verdict: 'refuses',
          problems: ['/referral: not declared in the bound version v2'],
        }),
      ]),
    });

    expect(copy.variant).toBe('all-accept');
    expect(copy.acknowledgement).toBeNull();
  });

  it('treats a breaking change as its own variant, destructive and separately acknowledged', () => {
    const copy = publishCopy({
      nextVersion: 4,
      currentVersion: 3,
      additions: [],
      breakingChanges: ['Removes the kind `vitals`'],
      impact: impact([workflow()]),
    });

    expect(copy.variant).toBe('breaking');
    expect(copy.title).toBe('This change breaks apps already using version 3');
    expect(copy.breakingChanges).toEqual(['Removes the kind `vitals`']);
    expect(copy.acknowledgement).toBe('I understand existing integrations will stop working until they are updated.');
    expect(copy.confirmLabel).toBe('Publish anyway');
    expect(copy.destructive).toBe(true);
  });

  it('states the additions in plain language for one, several, and none', () => {
    const base = { nextVersion: 2, currentVersion: 1, breakingChanges: null, impact: impact([]) };

    expect(publishCopy({ ...base, additions: ['referral'] }).description).toContain('This adds one new kind, `referral`.');
    expect(publishCopy({ ...base, additions: ['referral', 'vitals'] }).description).toContain('This adds 2 new kinds: `referral`, `vitals`.');
    expect(publishCopy({ ...base, additions: [] }).description).toContain('This adds no new kinds.');
  });

  it('says nothing about consumers it has not read', () => {
    const copy = publishCopy({ nextVersion: 2, currentVersion: 1, additions: ['referral'], breakingChanges: null, impact: null });

    expect(copy.variant).toBe('all-accept');
    expect(copy.description).not.toContain('follow the latest version');
    expect(copy.description).toContain('The list of workflows and agents that use this schema could not be read');
  });

  it('counts agents alongside workflows', () => {
    const copy = publishCopy({
      nextVersion: 4,
      currentVersion: 3,
      additions: ['referral'],
      breakingChanges: null,
      impact: {
        schemaId: 's-1',
        againstVersion: 4,
        workflows: [workflow()],
        agents: [
          {
            agentId: 'a-1',
            slug: 'intake-note',
            name: 'Intake note',
            versionNumber: 2,
            status: 'PUBLISHED',
            isActive: true,
            binding: 'pinned',
            boundVersion: 2,
            verdict: 'refuses',
            problems: ['/referral: not declared in the bound version v2'],
          },
        ],
      },
    });

    expect(copy.variant).toBe('some-refuse');
    expect(copy.acknowledgement).toBe('I understand this 1 agent will refuse new consultations until it is republished.');
  });
});
