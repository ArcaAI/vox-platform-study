import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';

// The composed prompt one LLM call was sent (OD-9). Both messages are
// Vault-Transit (hope-phi) ciphertext only; plaintext is never a field here.
// Append-only: written once, never updated.
export interface IComposedPromptRecordEntity extends IBaseTenantEntity {
  consultationId?: string | null;
  agentSlug?: string | null;
  phase?: string | null;
  provider?: string | null;
  locality?: string | null;
  systemCiphertext?: Buffer | null;
  userCiphertext?: Buffer | null;
  keyVersion?: number | null;
  sha256?: string | null;
}

export class ComposedPromptRecordEntity extends BaseTenantEntity {
  private _consultationId?: IComposedPromptRecordEntity['consultationId'];
  private _agentSlug?: IComposedPromptRecordEntity['agentSlug'];
  private _phase?: IComposedPromptRecordEntity['phase'];
  private _provider?: IComposedPromptRecordEntity['provider'];
  private _locality?: IComposedPromptRecordEntity['locality'];
  private _systemCiphertext?: IComposedPromptRecordEntity['systemCiphertext'];
  private _userCiphertext?: IComposedPromptRecordEntity['userCiphertext'];
  private _keyVersion?: IComposedPromptRecordEntity['keyVersion'];
  private _sha256?: IComposedPromptRecordEntity['sha256'];

  constructor(init: IComposedPromptRecordEntity) {
    super(init);
    this._consultationId = init.consultationId;
    this._agentSlug = init.agentSlug;
    this._phase = init.phase;
    this._provider = init.provider;
    this._locality = init.locality;
    this._systemCiphertext = init.systemCiphertext;
    this._userCiphertext = init.userCiphertext;
    this._keyVersion = init.keyVersion;
    this._sha256 = init.sha256;
  }

  get consultationId(): IComposedPromptRecordEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IComposedPromptRecordEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get agentSlug(): IComposedPromptRecordEntity['agentSlug'] {
    return this._agentSlug;
  }

  set agentSlug(value: IComposedPromptRecordEntity['agentSlug']) {
    this.setProperty('agentSlug', value);
  }

  get phase(): IComposedPromptRecordEntity['phase'] {
    return this._phase;
  }

  set phase(value: IComposedPromptRecordEntity['phase']) {
    this.setProperty('phase', value);
  }

  get provider(): IComposedPromptRecordEntity['provider'] {
    return this._provider;
  }

  set provider(value: IComposedPromptRecordEntity['provider']) {
    this.setProperty('provider', value);
  }

  get locality(): IComposedPromptRecordEntity['locality'] {
    return this._locality;
  }

  set locality(value: IComposedPromptRecordEntity['locality']) {
    this.setProperty('locality', value);
  }

  @Secret()
  get systemCiphertext(): IComposedPromptRecordEntity['systemCiphertext'] {
    return this._systemCiphertext;
  }

  set systemCiphertext(value: IComposedPromptRecordEntity['systemCiphertext']) {
    this.setProperty('systemCiphertext', value);
  }

  @Secret()
  get userCiphertext(): IComposedPromptRecordEntity['userCiphertext'] {
    return this._userCiphertext;
  }

  set userCiphertext(value: IComposedPromptRecordEntity['userCiphertext']) {
    this.setProperty('userCiphertext', value);
  }

  get keyVersion(): IComposedPromptRecordEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IComposedPromptRecordEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get sha256(): IComposedPromptRecordEntity['sha256'] {
    return this._sha256;
  }

  set sha256(value: IComposedPromptRecordEntity['sha256']) {
    this.setProperty('sha256', value);
  }
}
