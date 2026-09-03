/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';

export interface IAiModelEntity extends IBaseTaggedEntity {
  name: string;
  slug: string;
  description?: string | null;
  category: Enums.ModelCategory;
  taskType: Enums.ModelTaskType;
  modelType: Enums.ModelType;
  source: Enums.AiModelSource;
  sourceUri: string;
  sourceRevision?: string | null;
  format: Enums.AiModelFormat;
  // Machine-actionable registry identity: canonical runtime
  // provider (`ollama` | `lm-studio` | `azure` | `bedrock` | `built-in` |
  // `sarvam`) and model architecture family (`gemma4`, `whisper`, ...).
  provider?: string | null;
  architecture?: string | null;
  // ── TASK-860 registry identity (Hugging Face taxonomy + bucket) ────────
  /** Serving library — the Hub's `library_name` facet; loader selection. */
  libraryName: string;
  /** Workload that executes the row (`stt` | `nlp` | `tts` | `lmstudio` | `text` | …). */
  servedBy: string;
  deploymentKind: Enums.AiDeploymentKind;
  /** Vendor wire id for CLOUD rows (and the engine-host id for LM Studio rows). */
  wireModelId?: string | null;
  license?: string | null;
  gated: boolean;
  baseModel?: string | null;
  languages: string[];
  /** Hub commit sha the weights were fetched at. */
  hfRevision?: string | null;
  /** Key prefix under `s3://hope-models` the weights were published to. */
  bucketPrefix?: string | null;
  /** The single file a single-file loader opens inside `bucketPrefix`. */
  primaryObject?: string | null;
  /** sha256 of the published `manifest.json`, verified by the inventory job. */
  manifestDigest?: string | null;
  /** MEASURED presence of the weights in the bucket — never an admin opinion. */
  availability: Enums.AiModelAvailability;
  availabilityCheckedAt?: Date | null;
  availabilityDetail?: JsonValue | null;
  /** Super-admin "platform default for task" election. */
  isPlatformDefaultFor: Enums.AiTaskKind[];
  memorySizeMb?: number | null;
  computeType?: string | null;
  /** @deprecated TASK-860 — removed in R3. Replaced by `availability`. */
  downloadStatus: Enums.AiModelDownloadStatus;
  /** @deprecated TASK-860 — removed in R3. DERIVED from `bucketPrefix` by the service; never typed by an operator. */
  localPath?: string | null;
  /** @deprecated TASK-860 — removed in R3. Replaced by `availabilityCheckedAt`. */
  downloadedAt?: Date | null;
  /** @deprecated TASK-860 — removed in R3. Replaced by the manifest's `totalBytes`. */
  fileSizeMb?: number | null;
  checksum?: string | null;
}

/** What the publish processor writes back onto a row once its weights land in the bucket. */
export interface AiModelPublishRecord {
  bucketPrefix: string;
  primaryObject?: string | null;
  manifestDigest: string;
  /** Derived by the caller: `/mnt/models-bucket/` + `bucketPrefix` [+ `primaryObject`]. */
  localPath: string;
  fileSizeMb?: number;
  checksum?: string;
  hfRevision?: string | null;
  userId?: string;
}

export class AiModelEntity extends BaseTaggedEntity {
  private _name: IAiModelEntity['name'];
  private _slug: IAiModelEntity['slug'];
  private _description?: IAiModelEntity['description'];
  private _category: IAiModelEntity['category'];
  private _taskType: IAiModelEntity['taskType'];
  private _modelType: IAiModelEntity['modelType'];
  private _source: IAiModelEntity['source'];
  private _sourceUri: IAiModelEntity['sourceUri'];
  private _sourceRevision?: IAiModelEntity['sourceRevision'];
  private _format: IAiModelEntity['format'];
  private _provider?: IAiModelEntity['provider'];
  private _architecture?: IAiModelEntity['architecture'];
  // `IBaseEntity.metaData` was declared but never wired on
  // `BaseEntity` (pre-existing gap affecting every entity); implemented
  // locally so registry extras (TTS `metaData.voices`, Azure deployment
  // names) survive the DB → entity round-trip. Mirrors
  // `PasswordResetTokenEntity`'s local wiring.
  private _metaData?: IAiModelEntity['metaData'];
  private _libraryName: IAiModelEntity['libraryName'];
  private _servedBy: IAiModelEntity['servedBy'];
  private _deploymentKind: IAiModelEntity['deploymentKind'];
  private _wireModelId?: IAiModelEntity['wireModelId'];
  private _license?: IAiModelEntity['license'];
  private _gated: IAiModelEntity['gated'];
  private _baseModel?: IAiModelEntity['baseModel'];
  private _languages: IAiModelEntity['languages'];
  private _hfRevision?: IAiModelEntity['hfRevision'];
  private _bucketPrefix?: IAiModelEntity['bucketPrefix'];
  private _primaryObject?: IAiModelEntity['primaryObject'];
  private _manifestDigest?: IAiModelEntity['manifestDigest'];
  private _availability: IAiModelEntity['availability'];
  private _availabilityCheckedAt?: IAiModelEntity['availabilityCheckedAt'];
  private _availabilityDetail?: IAiModelEntity['availabilityDetail'];
  private _isPlatformDefaultFor: IAiModelEntity['isPlatformDefaultFor'];
  private _memorySizeMb?: IAiModelEntity['memorySizeMb'];
  private _computeType?: IAiModelEntity['computeType'];
  private _downloadStatus: IAiModelEntity['downloadStatus'];
  private _localPath?: IAiModelEntity['localPath'];
  private _downloadedAt?: IAiModelEntity['downloadedAt'];
  private _fileSizeMb?: IAiModelEntity['fileSizeMb'];
  private _checksum?: IAiModelEntity['checksum'];

  constructor(init: IAiModelEntity) {
    super(init);
    this._name = init.name;
    this._slug = init.slug;
    this._description = init.description;
    this._category = init.category;
    this._taskType = init.taskType;
    this._modelType = init.modelType;
    this._source = init.source;
    this._sourceUri = init.sourceUri;
    this._sourceRevision = init.sourceRevision;
    this._format = init.format;
    this._provider = init.provider;
    this._architecture = init.architecture;
    this._metaData = init.metaData;
    this._libraryName = init.libraryName;
    this._servedBy = init.servedBy;
    this._deploymentKind = init.deploymentKind;
    this._wireModelId = init.wireModelId;
    this._license = init.license;
    this._gated = init.gated ?? false;
    this._baseModel = init.baseModel;
    this._languages = init.languages ?? [];
    this._hfRevision = init.hfRevision;
    this._bucketPrefix = init.bucketPrefix;
    this._primaryObject = init.primaryObject;
    this._manifestDigest = init.manifestDigest;
    this._availability = init.availability ?? Enums.AiModelAvailability.UNKNOWN;
    this._availabilityCheckedAt = init.availabilityCheckedAt;
    this._availabilityDetail = init.availabilityDetail;
    this._isPlatformDefaultFor = init.isPlatformDefaultFor ?? [];
    this._memorySizeMb = init.memorySizeMb;
    this._computeType = init.computeType;
    this._downloadStatus = init.downloadStatus;
    this._localPath = init.localPath;
    this._downloadedAt = init.downloadedAt;
    this._fileSizeMb = init.fileSizeMb;
    this._checksum = init.checksum;
  }

  // Getters and Setters
  get name(): IAiModelEntity['name'] {
    return this._name;
  }

  set name(value: IAiModelEntity['name']) {
    this.setProperty('name', value);
  }

  get slug(): IAiModelEntity['slug'] {
    return this._slug;
  }

  set slug(value: IAiModelEntity['slug']) {
    this.setProperty('slug', value);
  }

  get description(): IAiModelEntity['description'] {
    return this._description;
  }

  set description(value: IAiModelEntity['description']) {
    this.setProperty('description', value);
  }

  get category(): IAiModelEntity['category'] {
    return this._category;
  }

  set category(value: IAiModelEntity['category']) {
    this.setProperty('category', value);
  }

  get taskType(): IAiModelEntity['taskType'] {
    return this._taskType;
  }

  set taskType(value: IAiModelEntity['taskType']) {
    this.setProperty('taskType', value);
  }

  get modelType(): IAiModelEntity['modelType'] {
    return this._modelType;
  }

  set modelType(value: IAiModelEntity['modelType']) {
    this.setProperty('modelType', value);
  }

  get source(): IAiModelEntity['source'] {
    return this._source;
  }

  set source(value: IAiModelEntity['source']) {
    this.setProperty('source', value);
  }

  get sourceUri(): IAiModelEntity['sourceUri'] {
    return this._sourceUri;
  }

  set sourceUri(value: IAiModelEntity['sourceUri']) {
    this.setProperty('sourceUri', value);
  }

  get sourceRevision(): IAiModelEntity['sourceRevision'] {
    return this._sourceRevision;
  }

  set sourceRevision(value: IAiModelEntity['sourceRevision']) {
    this.setProperty('sourceRevision', value);
  }

  get format(): IAiModelEntity['format'] {
    return this._format;
  }

  set format(value: IAiModelEntity['format']) {
    this.setProperty('format', value);
  }

  get provider(): IAiModelEntity['provider'] {
    return this._provider;
  }

  set provider(value: IAiModelEntity['provider']) {
    this.setProperty('provider', value);
  }

  get architecture(): IAiModelEntity['architecture'] {
    return this._architecture;
  }

  set architecture(value: IAiModelEntity['architecture']) {
    this.setProperty('architecture', value);
  }

  get metaData(): IAiModelEntity['metaData'] {
    return this._metaData;
  }

  set metaData(value: IAiModelEntity['metaData']) {
    this.setProperty('metaData', value);
  }

  get libraryName(): IAiModelEntity['libraryName'] {
    return this._libraryName;
  }

  set libraryName(value: IAiModelEntity['libraryName']) {
    this.setProperty('libraryName', value);
  }

  get servedBy(): IAiModelEntity['servedBy'] {
    return this._servedBy;
  }

  set servedBy(value: IAiModelEntity['servedBy']) {
    this.setProperty('servedBy', value);
  }

  get deploymentKind(): IAiModelEntity['deploymentKind'] {
    return this._deploymentKind;
  }

  set deploymentKind(value: IAiModelEntity['deploymentKind']) {
    this.setProperty('deploymentKind', value);
  }

  get wireModelId(): IAiModelEntity['wireModelId'] {
    return this._wireModelId;
  }

  set wireModelId(value: IAiModelEntity['wireModelId']) {
    this.setProperty('wireModelId', value);
  }

  get license(): IAiModelEntity['license'] {
    return this._license;
  }

  set license(value: IAiModelEntity['license']) {
    this.setProperty('license', value);
  }

  get gated(): IAiModelEntity['gated'] {
    return this._gated;
  }

  set gated(value: IAiModelEntity['gated']) {
    this.setProperty('gated', value);
  }

  get baseModel(): IAiModelEntity['baseModel'] {
    return this._baseModel;
  }

  set baseModel(value: IAiModelEntity['baseModel']) {
    this.setProperty('baseModel', value);
  }

  get languages(): IAiModelEntity['languages'] {
    return this._languages;
  }

  set languages(value: IAiModelEntity['languages']) {
    this.setProperty('languages', value);
  }

  get hfRevision(): IAiModelEntity['hfRevision'] {
    return this._hfRevision;
  }

  set hfRevision(value: IAiModelEntity['hfRevision']) {
    this.setProperty('hfRevision', value);
  }

  get bucketPrefix(): IAiModelEntity['bucketPrefix'] {
    return this._bucketPrefix;
  }

  set bucketPrefix(value: IAiModelEntity['bucketPrefix']) {
    this.setProperty('bucketPrefix', value);
  }

  get primaryObject(): IAiModelEntity['primaryObject'] {
    return this._primaryObject;
  }

  set primaryObject(value: IAiModelEntity['primaryObject']) {
    this.setProperty('primaryObject', value);
  }

  get manifestDigest(): IAiModelEntity['manifestDigest'] {
    return this._manifestDigest;
  }

  set manifestDigest(value: IAiModelEntity['manifestDigest']) {
    this.setProperty('manifestDigest', value);
  }

  get availability(): IAiModelEntity['availability'] {
    return this._availability;
  }

  set availability(value: IAiModelEntity['availability']) {
    this.setProperty('availability', value);
  }

  get availabilityCheckedAt(): IAiModelEntity['availabilityCheckedAt'] {
    return this._availabilityCheckedAt;
  }

  set availabilityCheckedAt(value: IAiModelEntity['availabilityCheckedAt']) {
    this.setProperty('availabilityCheckedAt', value);
  }

  get availabilityDetail(): IAiModelEntity['availabilityDetail'] {
    return this._availabilityDetail;
  }

  set availabilityDetail(value: IAiModelEntity['availabilityDetail']) {
    this.setProperty('availabilityDetail', value);
  }

  get isPlatformDefaultFor(): IAiModelEntity['isPlatformDefaultFor'] {
    return this._isPlatformDefaultFor;
  }

  set isPlatformDefaultFor(value: IAiModelEntity['isPlatformDefaultFor']) {
    this.setProperty('isPlatformDefaultFor', value);
  }

  get memorySizeMb(): IAiModelEntity['memorySizeMb'] {
    return this._memorySizeMb;
  }

  set memorySizeMb(value: IAiModelEntity['memorySizeMb']) {
    this.setProperty('memorySizeMb', value);
  }

  get computeType(): IAiModelEntity['computeType'] {
    return this._computeType;
  }

  set computeType(value: IAiModelEntity['computeType']) {
    this.setProperty('computeType', value);
  }

  get downloadStatus(): IAiModelEntity['downloadStatus'] {
    return this._downloadStatus;
  }

  set downloadStatus(value: IAiModelEntity['downloadStatus']) {
    this.setProperty('downloadStatus', value);
  }

  get localPath(): IAiModelEntity['localPath'] {
    return this._localPath;
  }

  set localPath(value: IAiModelEntity['localPath']) {
    this.setProperty('localPath', value);
  }

  get downloadedAt(): IAiModelEntity['downloadedAt'] {
    return this._downloadedAt;
  }

  set downloadedAt(value: IAiModelEntity['downloadedAt']) {
    this.setProperty('downloadedAt', value);
  }

  get fileSizeMb(): IAiModelEntity['fileSizeMb'] {
    return this._fileSizeMb;
  }

  set fileSizeMb(value: IAiModelEntity['fileSizeMb']) {
    this.setProperty('fileSizeMb', value);
  }

  get checksum(): IAiModelEntity['checksum'] {
    return this._checksum;
  }

  set checksum(value: IAiModelEntity['checksum']) {
    this.setProperty('checksum', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Check if the model has been downloaded
   */
  get isDownloaded(): boolean {
    return this._downloadStatus === Enums.AiModelDownloadStatus.DOWNLOADED;
  }

  /**
   * Check if the model is currently downloading
   */
  get isDownloading(): boolean {
    return this._downloadStatus === Enums.AiModelDownloadStatus.DOWNLOADING;
  }

  /**
   * Check if the model download failed
   */
  get isDownloadFailed(): boolean {
    return this._downloadStatus === Enums.AiModelDownloadStatus.DOWNLOAD_FAILED;
  }

  /**
   * Check if the model has not been downloaded yet
   */
  get isNotDownloaded(): boolean {
    return this._downloadStatus === Enums.AiModelDownloadStatus.NOT_DOWNLOADED;
  }

  /**
   * Check if this is an ASR (Automatic Speech Recognition) model
   */
  get isASR(): boolean {
    return this._taskType === Enums.ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION;
  }

  /**
   * Check if this is a VAD (Voice Activity Detection) model
   */
  get isVAD(): boolean {
    return this._taskType === Enums.ModelTaskType.VOICE_ACTIVITY_DETECTION;
  }

  /**
   * Check if this is a TTS (Text-to-Speech) model
   */
  get isTTS(): boolean {
    return this._taskType === Enums.ModelTaskType.TEXT_TO_SPEECH;
  }

  /**
   * Check if this is an audio model
   */
  get isAudioModel(): boolean {
    return this._category === Enums.ModelCategory.AUDIO;
  }

  /**
   * Check if model is from HuggingFace
   */
  get isHuggingFace(): boolean {
    return this._source === Enums.AiModelSource.HUGGINGFACE;
  }

  /**
   * Check if model is from MLFlow
   */
  get isMLFlow(): boolean {
    return this._source === Enums.AiModelSource.MLFLOW;
  }

  /**
   * Mark model as currently downloading
   */
  public markAsDownloading(userId?: string): void {
    this.setProperty('downloadStatus', Enums.AiModelDownloadStatus.DOWNLOADING);
    if (userId) {
      this.setProperty('updatedBy', userId);
    }
  }

  /**
   * Mark model as successfully downloaded
   */
  public markAsDownloaded(localPath: string, fileSizeMb?: number, checksum?: string, userId?: string): void {
    this.setProperty('downloadStatus', Enums.AiModelDownloadStatus.DOWNLOADED);
    this.setProperty('localPath', localPath);
    this.setProperty('downloadedAt', new Date());
    if (fileSizeMb !== undefined) {
      this.setProperty('fileSizeMb', fileSizeMb);
    }
    if (checksum) {
      this.setProperty('checksum', checksum);
    }
    if (userId) {
      this.setProperty('updatedBy', userId);
    }
  }

  /**
   * Mark model download as failed
   */
  public markAsDownloadFailed(userId?: string): void {
    this.setProperty('downloadStatus', Enums.AiModelDownloadStatus.DOWNLOAD_FAILED);
    if (userId) {
      this.setProperty('updatedBy', userId);
    }
  }

  /**
   * Reset download status to not downloaded
   */
  public resetDownloadStatus(userId?: string): void {
    this.setProperty('downloadStatus', Enums.AiModelDownloadStatus.NOT_DOWNLOADED);
    this.setProperty('localPath', null);
    this.setProperty('downloadedAt', null);
    this.setProperty('fileSizeMb', null);
    this.setProperty('checksum', null);
    if (userId) {
      this.setProperty('updatedBy', userId);
    }
  }

  // ============================================
  // TASK-860 — registry semantics
  // ============================================

  /** Cloud rows have no weights; `deploymentKind` is the truth, not the deprecated `format` pseudo-values. */
  get isCloud(): boolean {
    return this._deploymentKind === Enums.AiDeploymentKind.CLOUD;
  }

  /**
   * Record a MEASURED availability (inventory job / publish processor). Never
   * called from an admin edit — availability is a fact about the bucket.
   */
  public markAvailability(availability: Enums.AiModelAvailability, detail: JsonValue | null = null, checkedAt: Date = new Date()): void {
    this.setProperty('availability', availability);
    this.setProperty('availabilityCheckedAt', checkedAt);
    this.setProperty('availabilityDetail', detail);
  }

  /**
   * The publish processor's write-back: bucket identity + the derived
   * `localPath` + AVAILABLE, plus the legacy DOWNLOADED bookkeeping kept in
   * step until R3 removes it (Python resolvers still read `localPath`).
   */
  public recordPublish(record: AiModelPublishRecord): void {
    this.setProperty('bucketPrefix', record.bucketPrefix);
    this.setProperty('primaryObject', record.primaryObject ?? null);
    this.setProperty('manifestDigest', record.manifestDigest);
    if (record.hfRevision !== undefined) {
      this.setProperty('hfRevision', record.hfRevision);
    }
    this.markAvailability(Enums.AiModelAvailability.AVAILABLE, null);
    this.markAsDownloaded(record.localPath, record.fileSizeMb, record.checksum, record.userId);
  }

  /** Replace the platform-default election (de-duplicated, order preserved). */
  public setPlatformDefaultFor(kinds: Enums.AiTaskKind[], userId?: string): void {
    this.setProperty('isPlatformDefaultFor', [...new Set(kinds)]);
    if (userId) {
      this.setProperty('updatedBy', userId);
    }
  }

  public override validate(): void {
    super.validate();
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Model name is required');
    }
    if (!this._slug || this._slug.trim().length === 0) {
      throw new BusinessException('Model slug is required');
    }
    if (!this._sourceUri || this._sourceUri.trim().length === 0) {
      throw new BusinessException('Model source URI is required');
    }
    if (!this._libraryName || this._libraryName.trim().length === 0) {
      throw new BusinessException('Model libraryName is required');
    }
    if (!this._servedBy || this._servedBy.trim().length === 0) {
      throw new BusinessException('Model servedBy is required');
    }
    if (this.isCloud && (!this._wireModelId || this._wireModelId.trim().length === 0)) {
      throw new BusinessException('A CLOUD model requires a wireModelId');
    }
    // Validate slug format (lowercase, alphanumeric, hyphens only)
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(this._slug)) {
      throw new BusinessException('Model slug must be lowercase alphanumeric with hyphens (e.g., "whisper-large-v3")');
    }
  }
}
