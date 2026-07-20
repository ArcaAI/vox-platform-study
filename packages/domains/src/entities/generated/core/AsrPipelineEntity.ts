/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IAsrPipelineEntity extends IBaseTaggedEntity {
  name: string;
  slug: string;
  description?: string | null;
  configYaml: string;
  // TASK-328 A6 — frozen-schema `isDefault` column. Optional on the
  // interface so the factory (create path) can omit it (DB default = false).
  isDefault?: boolean;
  // TASK-531 — template lineage. `sourceTemplateSlug` records which SYSTEM
  // template this row descends from (null = not template-derived);
  // `templateLocked` marks a pristine template copy, which the application
  // layer treats as read-only for content edits + delete. Optional on the
  // interface for the same reason as `isDefault` (DB defaults cover creates).
  sourceTemplateSlug?: string | null;
  templateLocked?: boolean;
  TranscriptionJobs?: Entities.TranscriptionJobEntity[] | null;
}

export class AsrPipelineEntity extends BaseTaggedEntity {
  private _name: IAsrPipelineEntity['name'];
  private _slug: IAsrPipelineEntity['slug'];
  private _description?: IAsrPipelineEntity['description'];
  private _configYaml: IAsrPipelineEntity['configYaml'];
  private _isDefault: boolean;
  private _sourceTemplateSlug?: IAsrPipelineEntity['sourceTemplateSlug'];
  private _templateLocked: boolean;
  private _TranscriptionJobs?: IAsrPipelineEntity['TranscriptionJobs'];

  constructor(init: IAsrPipelineEntity) {
    super(init);
    this._name = init.name;
    this._slug = init.slug;
    this._description = init.description;
    this._configYaml = init.configYaml;
    this._isDefault = init.isDefault ?? false;
    this._sourceTemplateSlug = init.sourceTemplateSlug ?? null;
    this._templateLocked = init.templateLocked ?? false;
    this._TranscriptionJobs = init.TranscriptionJobs;
  }

  get name(): IAsrPipelineEntity['name'] {
    return this._name;
  }

  set name(value: IAsrPipelineEntity['name']) {
    this.setProperty('name', value);
  }

  get slug(): IAsrPipelineEntity['slug'] {
    return this._slug;
  }

  set slug(value: IAsrPipelineEntity['slug']) {
    this.setProperty('slug', value);
  }

  get description(): IAsrPipelineEntity['description'] {
    return this._description;
  }

  set description(value: IAsrPipelineEntity['description']) {
    this.setProperty('description', value);
  }

  get configYaml(): IAsrPipelineEntity['configYaml'] {
    return this._configYaml;
  }

  set configYaml(value: IAsrPipelineEntity['configYaml']) {
    this.setProperty('configYaml', value);
  }

  get isDefault(): boolean {
    return this._isDefault;
  }

  set isDefault(value: boolean) {
    this.setProperty('isDefault', value);
  }

  get sourceTemplateSlug(): IAsrPipelineEntity['sourceTemplateSlug'] {
    return this._sourceTemplateSlug;
  }

  set sourceTemplateSlug(value: IAsrPipelineEntity['sourceTemplateSlug']) {
    this.setProperty('sourceTemplateSlug', value);
  }

  get templateLocked(): boolean {
    return this._templateLocked;
  }

  set templateLocked(value: boolean) {
    this.setProperty('templateLocked', value);
  }

  get TranscriptionJobs(): IAsrPipelineEntity['TranscriptionJobs'] {
    return this._TranscriptionJobs;
  }

  set TranscriptionJobs(value: IAsrPipelineEntity['TranscriptionJobs']) {
    this.setProperty('TranscriptionJobs', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Check if pipeline is active (enabled status)
   */
  get isActive(): boolean {
    return this.isEnabled;
  }

  /**
   * Get the number of jobs associated with this pipeline
   */
  get jobCount(): number {
    return this._TranscriptionJobs?.length ?? 0;
  }

  /**
   * Extract model slugs from the YAML config.
   * Returns an array of model slugs referenced in the pipeline config.
   *
   * Expected YAML structure:
   * models:
   *   asr: "whisper-large-v3"
   *   vad: "silero-vad-v4"
   *   denoise: "deepfilternet-v3"
   */
  public getModelSlugs(): string[] {
    const slugs: string[] = [];

    // Simple regex-based extraction for model slugs
    // Matches patterns like: asr: "model-slug" or asr: 'model-slug'
    const modelPattern = /^\s*(asr|vad|denoise):\s*["']([^"']+)["']/gm;
    let match;

    while ((match = modelPattern.exec(this._configYaml)) !== null) {
      if (match[2]) {
        slugs.push(match[2]);
      }
    }

    return slugs;
  }

  /**
   * Get the ASR model slug from config
   */
  public getAsrModelSlug(): string | null {
    const asrPattern = /^\s*asr:\s*["']([^"']+)["']/m;
    const match = this._configYaml.match(asrPattern);
    return match ? match[1] : null;
  }

  /**
   * Get the VAD model slug from config (optional)
   */
  public getVadModelSlug(): string | null {
    const vadPattern = /^\s*vad:\s*["']([^"']+)["']/m;
    const match = this._configYaml.match(vadPattern);
    return match ? match[1] : null;
  }

  /**
   * Get the denoise model slug from config (optional)
   */
  public getDenoiseModelSlug(): string | null {
    const denoisePattern = /^\s*denoise:\s*["']([^"']+)["']/m;
    const match = this._configYaml.match(denoisePattern);
    return match ? match[1] : null;
  }

  public override validate(): void {
    super.validate();
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Pipeline name is required');
    }
    if (!this._slug || this._slug.trim().length === 0) {
      throw new BusinessException('Pipeline slug is required');
    }
    if (!this._configYaml || this._configYaml.trim().length === 0) {
      throw new BusinessException('Pipeline config YAML is required');
    }
    // Validate slug format (lowercase, alphanumeric, hyphens only)
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(this._slug)) {
      throw new BusinessException('Pipeline slug must be lowercase alphanumeric with hyphens (e.g., "whisper-large-v3")');
    }
  }
}
