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

  it('inherits the platform shape verbatim and only ADDS to it — order, titles, forms and instructions unchanged', () => {
    for (const department of DEPARTMENTS) {
      for (const visit of ARCAAI_DEPARTMENT_VISIT_TYPES) {
        const base = visit === 'new-visit' ? NEW_VISIT_NOTE_SHAPE : REVISIT_NOTE_SHAPE;
        const shape = bySlug.get(arcaaiDocumentTemplateSlug(department.code.toLowerCase(), visit))!.shape;

        // Every inherited section survives, byte-identical, and in the base's relative order.
        const keys = shape.sections.map((section) => section.key);
        const inheritedOrder = keys.filter((key) => base.sections.some((section) => section.key === key));
        expect(inheritedOrder).toEqual(base.sections.map((section) => section.key));
        for (const section of base.sections) {
          expect(shape.sections.find((candidate) => candidate.key === section.key)).toEqual(section);
        }

        // The protocol is the platform's, not a per-department rewrite.
        expect(shape.globalInstruction).toBe(REALTIME_NOTE_PROTOCOL);
        expect(shape.schemaVersion).toBe('1.0');
        // No duplicate keys — `spliceSections` throws on one, so reaching here means none.
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });

  it('the department axis is REAL — the ten non-General shapes each add at least one heading, and General adds none', () => {
    for (const department of DEPARTMENTS) {
      const slugPart = department.code.toLowerCase();
      const added = ARCAAI_DEPARTMENT_VISIT_TYPES.map((visit) => {
        const base = visit === 'new-visit' ? NEW_VISIT_NOTE_SHAPE : REVISIT_NOTE_SHAPE;
        const shape = bySlug.get(arcaaiDocumentTemplateSlug(slugPart, visit))!.shape;
        return shape.sections.length - base.sections.length;
      });
      if (department.code === 'GEN') {
        // The platform shapes WERE ported from the General Medicine corpus; splicing anything in
        // would be authoring, not reuse.
        expect(added).toEqual([0, 0]);
      } else {
        expect(added.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
      }
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
