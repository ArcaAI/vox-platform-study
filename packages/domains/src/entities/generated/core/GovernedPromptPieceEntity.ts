/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import { GovernedPromptPieceKind, GovernedPromptSourceType, GovernedPromptVerdict } from '../../../enums';

/** sha256 lower-case hex — the only digest shape a piece row may carry (FC-2). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

// TASK-1047 FC-3 — ONE authoring-time screening verdict for ONE static prompt piece (a template
// body, a composite fragment, a platform constant) under ONE guardrail policy version.
//
// The row identifies the text by `digest` (sha256 of its exact UTF-8) and never stores it. The
// verdict is a property of the TEXT under a policy, so a SYSTEM row vouches for every tenant's
// identical piece; `tenantId` records whose content produced it. `policyVersion` here is
// GUARDRAIL's policy version (a hash of screen taxonomy + model ids + thresholds), not an authored
// revision and not the `_version` OCC counter.
export interface IGovernedPromptPieceEntity extends IBaseTenantEntity {
  digest: string;
  kind: GovernedPromptPieceKind;
  sourceType: GovernedPromptSourceType;
  sourceId?: string | null;
  sourceKey?: string | null;
  policyVersion: string;
  verdict: GovernedPromptVerdict;
  // Finding codes + reasons, never text.
  findings?: JsonValue | null;
  textChars: number;
  screenedAt: Date;
}

export class GovernedPromptPieceEntity extends BaseTenantEntity {
  private _digest: IGovernedPromptPieceEntity['digest'];
  private _kind: IGovernedPromptPieceEntity['kind'];
  private _sourceType: IGovernedPromptPieceEntity['sourceType'];
  private _sourceId?: IGovernedPromptPieceEntity['sourceId'];
  private _sourceKey?: IGovernedPromptPieceEntity['sourceKey'];
  private _policyVersion: IGovernedPromptPieceEntity['policyVersion'];
  private _verdict: IGovernedPromptPieceEntity['verdict'];
  private _findings?: IGovernedPromptPieceEntity['findings'];
  private _textChars: IGovernedPromptPieceEntity['textChars'];
  private _screenedAt: IGovernedPromptPieceEntity['screenedAt'];

  constructor(init: IGovernedPromptPieceEntity) {
    super(init);
    this._digest = init.digest;
    this._kind = init.kind;
    this._sourceType = init.sourceType;
    this._sourceId = init.sourceId;
    this._sourceKey = init.sourceKey;
    this._policyVersion = init.policyVersion;
    this._verdict = init.verdict;
    this._findings = init.findings;
    this._textChars = init.textChars;
    this._screenedAt = init.screenedAt;
  }

  get digest(): IGovernedPromptPieceEntity['digest'] {
    return this._digest;
  }

  set digest(value: IGovernedPromptPieceEntity['digest']) {
    this.setProperty('digest', value);
  }

  get kind(): IGovernedPromptPieceEntity['kind'] {
    return this._kind;
  }

  set kind(value: IGovernedPromptPieceEntity['kind']) {
    this.setProperty('kind', value);
  }

  get sourceType(): IGovernedPromptPieceEntity['sourceType'] {
    return this._sourceType;
  }

  set sourceType(value: IGovernedPromptPieceEntity['sourceType']) {
    this.setProperty('sourceType', value);
  }

  get sourceId(): IGovernedPromptPieceEntity['sourceId'] {
    return this._sourceId;
  }

  set sourceId(value: IGovernedPromptPieceEntity['sourceId']) {
    this.setProperty('sourceId', value);
  }

  get sourceKey(): IGovernedPromptPieceEntity['sourceKey'] {
    return this._sourceKey;
  }

  set sourceKey(value: IGovernedPromptPieceEntity['sourceKey']) {
    this.setProperty('sourceKey', value);
  }

  get policyVersion(): IGovernedPromptPieceEntity['policyVersion'] {
    return this._policyVersion;
  }

  set policyVersion(value: IGovernedPromptPieceEntity['policyVersion']) {
    this.setProperty('policyVersion', value);
  }

  get verdict(): IGovernedPromptPieceEntity['verdict'] {
    return this._verdict;
  }

  set verdict(value: IGovernedPromptPieceEntity['verdict']) {
    this.setProperty('verdict', value);
  }

  get findings(): IGovernedPromptPieceEntity['findings'] {
    return this._findings;
  }

  set findings(value: IGovernedPromptPieceEntity['findings']) {
    this.setProperty('findings', value);
  }

  get textChars(): IGovernedPromptPieceEntity['textChars'] {
    return this._textChars;
  }

  set textChars(value: IGovernedPromptPieceEntity['textChars']) {
    this.setProperty('textChars', value);
  }

  get screenedAt(): IGovernedPromptPieceEntity['screenedAt'] {
    return this._screenedAt;
  }

  set screenedAt(value: IGovernedPromptPieceEntity['screenedAt']) {
    this.setProperty('screenedAt', value);
  }

  public override validate(): void {
    super.validate();
    if (typeof this._digest !== 'string' || !SHA256_HEX.test(this._digest)) {
      throw new BusinessException('GovernedPromptPiece digest must be a sha256 lower-case hex string.');
    }
    if (typeof this._policyVersion !== 'string' || this._policyVersion.trim().length === 0) {
      throw new BusinessException('GovernedPromptPiece policyVersion is required.');
    }
    if (!Number.isInteger(this._textChars) || this._textChars < 0) {
      throw new BusinessException('GovernedPromptPiece textChars must be a non-negative integer.');
    }
  }
}
