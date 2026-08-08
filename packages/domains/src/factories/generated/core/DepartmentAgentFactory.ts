/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { DepartmentAgentEntity, IDepartmentAgentEntity } from '../../../entities';
import { DepartmentAgentDnaPolicy } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateDepartmentAgentProps extends BaseEntityFactoryCreateProps {
  tenantId: IDepartmentAgentEntity['tenantId'];
  departmentId: IDepartmentAgentEntity['departmentId'];
  name: IDepartmentAgentEntity['name'];
  slug: IDepartmentAgentEntity['slug'];
  description?: IDepartmentAgentEntity['description'];
  promptTemplateId: IDepartmentAgentEntity['promptTemplateId'];
  pinnedVersionNumber?: IDepartmentAgentEntity['pinnedVersionNumber'];
  dnaStylePolicy?: IDepartmentAgentEntity['dnaStylePolicy'];
  harnessOverrides?: IDepartmentAgentEntity['harnessOverrides'];
  goldenSetId?: IDepartmentAgentEntity['goldenSetId'];
  // TASK-635 RF-4 — capability-keyed bindings + live-loop config. All optional;
  // omitted ⇒ null ⇒ the legacy behavior for that capability.
  newPatientTemplateId?: IDepartmentAgentEntity['newPatientTemplateId'];
  revisitTemplateId?: IDepartmentAgentEntity['revisitTemplateId'];
  preSummaryTemplateId?: IDepartmentAgentEntity['preSummaryTemplateId'];
  livePromptTemplateId?: IDepartmentAgentEntity['livePromptTemplateId'];
  toolConfig?: IDepartmentAgentEntity['toolConfig'];
  llmOverrides?: IDepartmentAgentEntity['llmOverrides'];
  tags?: IDepartmentAgentEntity['tags'];
  // Template lineage — set only by the paths that produce template copies
  // (TASK-548). Omitted everywhere else, so a hand-created agent is unlocked
  // with no provenance (the DB defaults). `isDefault` stays out of this props
  // bag on purpose — the default is flipped only via `setDefaultForDepartment`.
  sourceAgentTemplateSlug?: IDepartmentAgentEntity['sourceAgentTemplateSlug'];
  templateLocked?: IDepartmentAgentEntity['templateLocked'];
  // Template-copy lineage extras (TASK-548): provisioning/resync stamp
  // `{ sourceTemplateVersionNumber }` here so the resync sweep can prove a
  // locked clone pristine against the exact source version it was cloned from.
  metaData?: IDepartmentAgentEntity['metaData'];

  createdAt?: IDepartmentAgentEntity['createdAt'];
  updatedAt?: IDepartmentAgentEntity['updatedAt'];
  createdBy?: IDepartmentAgentEntity['createdBy'];
  updatedBy?: IDepartmentAgentEntity['updatedBy'];
}

export class DepartmentAgentFactory {
  static CreateDepartmentAgent(props: CreateDepartmentAgentProps): DepartmentAgentEntity {
    const id = generateId();
    const now = new Date();

    return new DepartmentAgentEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      departmentId: props.departmentId,
      name: props.name,
      slug: props.slug,
      description: props.description ?? null,
      promptTemplateId: props.promptTemplateId,
      pinnedVersionNumber: props.pinnedVersionNumber ?? null,
      dnaStylePolicy: props.dnaStylePolicy ?? DepartmentAgentDnaPolicy.INHERIT,
      harnessOverrides: props.harnessOverrides ?? null,
      goldenSetId: props.goldenSetId ?? null,
      newPatientTemplateId: props.newPatientTemplateId ?? null,
      revisitTemplateId: props.revisitTemplateId ?? null,
      preSummaryTemplateId: props.preSummaryTemplateId ?? null,
      livePromptTemplateId: props.livePromptTemplateId ?? null,
      toolConfig: props.toolConfig ?? null,
      llmOverrides: props.llmOverrides ?? null,
      tags: props.tags ?? [],
      sourceAgentTemplateSlug: props.sourceAgentTemplateSlug ?? null,
      templateLocked: props.templateLocked ?? false,
      metaData: props.metaData ?? null,
    });
  }

  /**
   * Generate a URL-friendly slug from a name (mirrors AsrPipelineFactory).
   */
  static GenerateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
