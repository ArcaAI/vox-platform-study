/**
 * TASK-932 §3.7 — the 22 ArcaAI department running-note shapes, and the workflow nodes that name them.
 *
 * The defect this closes is the one TASK-891 §2 traced live: a clinician watches four SOAP
 * sections being written and signs an eleven-heading department note. TASK-891 seeded the
 * VISIT-TYPE axis (two platform shapes) and left the DEPARTMENT axis to a later ticket; this is
 * that axis, and it is the half the owner's five-department journey actually exercises.
 *
 * Three things are asserted rather than assumed:
 *
 *  1. one shape per (department, visit type), all ArcaAI-owned, with the platform shape's
 *     sections inherited VERBATIM — a department may add headings, never quietly rewrite one;
 *  2. every department workflow's two realtime summary nodes NAME the matching slug, and the
 *     names resolve to a seeded row (a slug nothing carries falls open to the platform SOAP
 *     shape, which is the silent wrong-shape note again, one layer further in);
 *  3. the D-21 posture survives the splice: nothing is `required`, because under `strict: true` a
 *     required section forbids the decoder from representing "not discussed", so it invents.
 */
import { describe, expect, it } from 'vitest';

import { SEED_CUSTOMER_TENANT_IDS } from '../00-constants';
import * as CORPUS from '../07b-arcaai-clinical-content-v3';
import { ARCAAI_ALL_CLINICAL_DEPARTMENTS } from '../04-department';
import {
  ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES,
  ARCAAI_DEPARTMENT_VISIT_TYPES,
  DOCUMENT_TEMPLATE_LIBRARY,
  NEW_VISIT_NOTE_SHAPE,
  NEW_VISIT_NOTE_SLUG,
  REALTIME_NOTE_PROTOCOL,
  REVISIT_NOTE_SHAPE,
  REVISIT_NOTE_SLUG,
  arcaaiDocumentTemplateSlug,
  seedArcaaiDepartmentDocumentTemplates,
} from '../27-document-template-library';
import { ARCAAI_DOCUMENT_TEMPLATE_SLUGS, ARCAAI_WORKFLOW_TARGETS, VISIT_TYPES, arcaaiWorkflowSlug } from '../29-arcaai-agents-and-workflows';

const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;
const DEPARTMENTS = ARCAAI_ALL_CLINICAL_DEPARTMENTS;

const bySlug = new Map(ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES.map((entry) => [entry.slug, entry]));

/** Slug → the v3 corpus body whose headings that shape must reproduce. */
const PROMPT_BODIES: Readonly<Record<string, string>> = {
  'arcaai-gen-soap-new-visit': CORPUS.MEDICINE_NEW_REFERRAL_CONTENT_V3,
  'arcaai-gen-soap-revisit': CORPUS.MEDICINE_FOLLOWUP_CONTENT_V3,
  'arcaai-surg-soap-new-visit': CORPUS.SURGERY_NEW_REFERRAL_CONTENT_V3,
  'arcaai-surg-soap-revisit': CORPUS.SURGERY_FOLLOWUP_CONTENT_V3,
  'arcaai-rheum-soap-new-visit': CORPUS.RHEUMATOLOGY_NEW_REFERRAL_CONTENT_V3,
  'arcaai-rheum-soap-revisit': CORPUS.RHEUMATOLOGY_FOLLOWUP_CONTENT_V3,
  'arcaai-neur-soap-new-visit': CORPUS.NEUROLOGY_NEW_REFERRAL_CONTENT_V3,
  'arcaai-neur-soap-revisit': CORPUS.NEUROLOGY_FOLLOWUP_CONTENT_V3,
  'arcaai-orth-soap-new-visit': CORPUS.ORTHOPEDICS_NEW_REFERRAL_CONTENT_V3,
  'arcaai-orth-soap-revisit': CORPUS.ORTHOPEDICS_REVIEW_CONTENT_V3,
  'arcaai-heme-soap-new-visit': CORPUS.HEMATOLOGY_NEW_REFERRAL_CONTENT_V3,
  'arcaai-heme-soap-revisit': CORPUS.HEMATOLOGY_REVISIT_CONTENT_V3,
  'arcaai-bren-soap-new-visit': CORPUS.BREAST_ENDOCRINE_NEW_REFERRAL_CONTENT_V3,
  'arcaai-bren-soap-revisit': CORPUS.BREAST_ENDOCRINE_FOLLOWUP_CONTENT_V3,
  'arcaai-derm-soap-new-visit': CORPUS.DERMATOLOGY_NEW_REFERRAL_CONTENT_V3,
  'arcaai-derm-soap-revisit': CORPUS.DERMATOLOGY_FOLLOWUP_CONTENT_V3,
  'arcaai-diet-soap-new-visit': CORPUS.DIETETICS_NEW_REFERRAL_CONTENT_V3,
  'arcaai-diet-soap-revisit': CORPUS.DIETETICS_FOLLOWUP_CONTENT_V3,
  'arcaai-neph-soap-new-visit': CORPUS.NEPHROLOGY_NEW_REFERRAL_CONTENT_V3,
  'arcaai-neph-soap-revisit': CORPUS.NEPHROLOGY_FOLLOWUP_CONTENT_V3,
  'arcaai-sonc-soap-new-visit': CORPUS.SURGICAL_ONCOLOGY_NEW_REFERRAL_CONTENT_V3,
  'arcaai-sonc-soap-revisit': CORPUS.SURGICAL_ONCOLOGY_FOLLOWUP_CONTENT_V3,
};

/**
 * The headings of one corpus body — an INDEPENDENT reader, deliberately not the seed's.
 *
 * The seed walks the block line by line and carries state; this matches the whole block at once
 * with one multiline regex. Two readers that disagree mean one of them is wrong, which is the
 * only way this test can catch a parser bug rather than inherit it.
 */
function headingsOf(body: string): string[] {
  const start = body.indexOf('END SOURCE-OF-TRUTH PROTOCOL');
  let block = start === -1 ? body : body.slice(start);
  const stop = block.indexOf('BEFORE YOU EMIT');
  if (stop !== -1) block = block.slice(0, stop);

  // Column-0 lines only: `**Title**`, `1. **Title**`, `1. Title`.
  // A PLAIN heading must carry its number: unnumbered prose at column 0 (the marker line, the
  // "produce a structured clinical summary..." sentence) is not a heading. Bold may go either way.
  return [...block.matchAll(/^(?:(?:\d+\.[ \t]*)?\*\*(?<bold>[^*\n]+?)\*\*|\d+\.[ \t]+(?<plain>[^*\n]+?))[ \t]*:?$/gm)]
    .map((match) => (match.groups?.bold ?? match.groups?.plain ?? '').trim())
    .filter((title) => title.length > 0);
}


/** The node config of one workflow target's node. */
function nodeConfig(workflowSlug: string, nodeId: string): Record<string, unknown> {
  const target = ARCAAI_WORKFLOW_TARGETS.find((candidate) => candidate.slug === workflowSlug)!;
  return (target.graph.nodes.find((node) => node.id === nodeId)?.config ?? {}) as Record<string, unknown>;
}

describe('TASK-932 §3.7 — ArcaAI department note shapes', () => {
  it('11 departments x 2 visit types = 22 shapes, ids and slugs unique', () => {
    expect(DEPARTMENTS).toHaveLength(11);
    expect(ARCAAI_DEPARTMENT_VISIT_TYPES).toEqual(['new-visit', 'revisit']);
    expect(ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES).toHaveLength(DEPARTMENTS.length * ARCAAI_DEPARTMENT_VISIT_TYPES.length);
    expect(new Set(ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES.map((entry) => entry.id)).size).toBe(22);
    expect(new Set(ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES.map((entry) => entry.slug)).size).toBe(22);
    for (const department of DEPARTMENTS) {
      for (const visit of ARCAAI_DEPARTMENT_VISIT_TYPES) {
        expect(bySlug.has(arcaaiDocumentTemplateSlug(department.code.toLowerCase(), visit))).toBe(true);
      }
    }
  });

  it('never collides with the SYSTEM reference pair — the platform axis and the department axis are different rows', () => {
    const platformSlugs = new Set(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => entry.slug));
    expect([...platformSlugs].sort()).toEqual([NEW_VISIT_NOTE_SLUG, REVISIT_NOTE_SLUG].sort());
    for (const entry of ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES) expect(platformSlugs.has(entry.slug)).toBe(false);
    const platformIds = new Set(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => entry.id));
    for (const entry of ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES) expect(platformIds.has(entry.id)).toBe(false);
  });

  it('IS its department prompt: title-for-title, position-for-position, all 22', () => {
    // The assertion this file exists for. Parsed here by a SECOND, independent reader of the
    // corpus (one regex over the whole heading block, where the seed walks line by line), so a
    // bug in the seed's parser cannot satisfy this test by also being present in it.
    for (const department of DEPARTMENTS) {
      for (const visit of ARCAAI_DEPARTMENT_VISIT_TYPES) {
        const slug = arcaaiDocumentTemplateSlug(department.code.toLowerCase(), visit);
        const shape = bySlug.get(slug)!.shape;
        const body = PROMPT_BODIES[slug];
        expect(body, `${slug}: no corpus body mapped`).toBeTruthy();
        const expected = headingsOf(body!);

        expect(expected.length, `${slug}: the corpus body must yield headings`).toBeGreaterThan(1);
        expect(shape.sections.map((section) => section.title), slug).toEqual(expected);
      }
    }
  });

  it('carries the prompt`s own guidance as each section`s instruction — nothing authored', () => {
    // Every instruction must be a subsequence of the lines the prompt writes under that heading.
    // This is what stops a future editor "improving" a section's wording: the text belongs to
    // the clinical corpus, and the only sanctioned way to change it is to change the prompt.
    for (const entry of ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES) {
      const body = PROMPT_BODIES[entry.slug];
      expect(body, `${entry.slug}: no corpus body mapped`).toBeTruthy();
      for (const section of entry.shape.sections) {
        expect(section.instruction, `${entry.slug}/${section.key}`).toBeTruthy();
        for (const line of section.instruction!.split('\n')) {
          expect(body!, `${entry.slug}/${section.key}: "${line.slice(0, 60)}" is not in the prompt`).toContain(line);
        }
      }
    }
  });

  it('keeps the platform protocol and the platform key for any heading the platform also declares', () => {
    const inheritedKeyByTitle = new Map(
      [...NEW_VISIT_NOTE_SHAPE.sections, ...REVISIT_NOTE_SHAPE.sections].map((section) => [section.title.toLowerCase(), section.key]),
    );
    for (const entry of ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES) {
      expect(entry.shape.globalInstruction, entry.slug).toBe(REALTIME_NOTE_PROTOCOL);
      expect(entry.shape.schemaVersion).toBe('1.0');

      const keys = entry.shape.sections.map((section) => section.key);
      expect(new Set(keys).size, `${entry.slug}: duplicate section key`).toBe(keys.length);
      for (const key of keys) expect(key, `${entry.slug}: ${key}`).toMatch(/^[a-z0-9_]{2,48}$/);

      for (const section of entry.shape.sections) {
        const inherited = inheritedKeyByTitle.get(section.title.toLowerCase());
        if (inherited) expect(section.key, `${entry.slug}: "${section.title}"`).toBe(inherited);
      }
    }
  });

  it('General Medicine`s shapes are the platform pair`s section list — the platform shapes were ported from that body', () => {
    // The one department whose headings the platform axis already carries. If this drifts, either
    // the corpus body or the platform shape moved, and the two are supposed to be the same list.
    expect(bySlug.get('arcaai-gen-soap-new-visit')!.shape.sections.map((s) => s.title)).toEqual(
      NEW_VISIT_NOTE_SHAPE.sections.map((s) => s.title),
    );
    expect(bySlug.get('arcaai-gen-soap-revisit')!.shape.sections.map((s) => s.title)).toEqual(
      REVISIT_NOTE_SHAPE.sections.map((s) => s.title),
    );
  });

  it('the department axis is REAL — the ten non-General shapes differ from the platform pair', () => {
    for (const department of DEPARTMENTS) {
      const differs = ARCAAI_DEPARTMENT_VISIT_TYPES.map((visit) => {
        const base = visit === 'new-visit' ? NEW_VISIT_NOTE_SHAPE : REVISIT_NOTE_SHAPE;
        const shape = bySlug.get(arcaaiDocumentTemplateSlug(department.code.toLowerCase(), visit))!.shape;
        const titles = shape.sections.map((section) => section.title);
        return JSON.stringify(titles) !== JSON.stringify(base.sections.map((section) => section.title));
      });
      if (department.code === 'GEN') expect(differs).toEqual([false, false]);
      else expect(differs.some(Boolean), `${department.code} must carry its own heading list`).toBe(true);
    }
  });

  it('keeps the D-21 posture: not one section is `required`, in any of the 22', () => {
    for (const entry of ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES) {
      for (const section of entry.shape.sections) expect(section.required).not.toBe(true);
      // …which the compiled artifact must agree with: every key present, every value nullable.
      const compiled = entry.compiled as { sectionKeys: string[]; responseFormat: { json_schema: { required: string[]; properties: Record<string, { type: unknown }> } } };
      expect(compiled.responseFormat.json_schema.required).toEqual(compiled.sectionKeys);
      for (const key of compiled.sectionKeys) expect(compiled.responseFormat.json_schema.properties[key]!.type).toEqual(['string', 'null']);
    }
  });

  it('every department workflow`s two realtime summary nodes NAME the matching slug, and every named slug is seeded', () => {
    expect(ARCAAI_DOCUMENT_TEMPLATE_SLUGS).toHaveLength(22);
    for (const department of DEPARTMENTS) {
      const slugPart = department.code.toLowerCase();
      const workflowSlug = arcaaiWorkflowSlug({ slugPart } as never);
      expect(nodeConfig(workflowSlug, 'n_summary_new').documentTemplateSlug).toBe(arcaaiDocumentTemplateSlug(slugPart, 'new-visit'));
      expect(nodeConfig(workflowSlug, 'n_summary_revisit').documentTemplateSlug).toBe(arcaaiDocumentTemplateSlug(slugPart, 'revisit'));
    }
    // Every slug a node names exists as a row — a slug nothing carries falls open to the platform
    // SOAP shape, which is exactly the silent wrong-shape note this axis exists to close.
    for (const target of ARCAAI_WORKFLOW_TARGETS) {
      for (const node of target.graph.nodes) {
        const slug = (node.config as { documentTemplateSlug?: unknown }).documentTemplateSlug;
        if (typeof slug === 'string') expect(bySlug.has(slug), `${target.slug}/${node.id} names an unseeded shape ${slug}`).toBe(true);
      }
    }
    // …and NOT on the warm start or the capture node: only the running-note nodes shape a document.
    for (const target of ARCAAI_WORKFLOW_TARGETS) {
      for (const nodeId of ['n_presummary', 'n_asr', 'n_ner', 'n_finalize']) {
        expect(nodeConfig(target.slug, nodeId).documentTemplateSlug).toBeUndefined();
      }
    }
    expect(VISIT_TYPES).toEqual(['new-visit', 'revisit']);
  });

  it('writes 22 rows and 22 v1 snapshots to the ArcaAI tenant, upsert-by-id', async () => {
    const templates: Array<Record<string, unknown>> = [];
    const versions: Array<Record<string, unknown>> = [];
    const client = {
      documentTemplate: { upsert: async ({ create }: { create: Record<string, unknown> }) => templates.push(create) },
      documentTemplateVersion: { upsert: async ({ create }: { create: Record<string, unknown> }) => versions.push(create) },
    };

    const written = await seedArcaaiDepartmentDocumentTemplates(client as never, ARCAAI);

    expect(written).toBe(22);
    expect(templates).toHaveLength(22);
    expect(versions).toHaveLength(22);
    for (const row of templates) {
      expect(row).toMatchObject({ tenantId: ARCAAI, status: 'PUBLISHED', pinnedVersionNumber: 1, isDefault: false, sourceTemplateSlug: null });
    }
    // `isDefault: false` on all 22 is load-bearing: `resolveForGeneration(tenantId)` with no slug
    // reads the tenant DEFAULT, and a department shape answering for every department is the wrong
    // note for ten of the eleven.
    expect(templates.filter((row) => row.isDefault === true)).toEqual([]);
    for (const row of versions) expect(row).toMatchObject({ tenantId: ARCAAI, versionNumber: 1 });
  });
});
