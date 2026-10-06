/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { GovernedPromptPieceEntity, IGovernedPromptPieceEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateGovernedPromptPieceProps extends BaseEntityFactoryCreateProps {
  digest: IGovernedPromptPieceEntity['digest'];
  kind: IGovernedPromptPieceEntity['kind'];
  sourceType: IGovernedPromptPieceEntity['sourceType'];
  sourceId?: IGovernedPromptPieceEntity['sourceId'];
  sourceKey?: IGovernedPromptPieceEntity['sourceKey'];
  policyVersion: IGovernedPromptPieceEntity['policyVersion'];
  verdict: IGovernedPromptPieceEntity['verdict'];
  findings?: IGovernedPromptPieceEntity['findings'];
  textChars: IGovernedPromptPieceEntity['textChars'];
  screenedAt?: IGovernedPromptPieceEntity['screenedAt'];
  tenantId: IGovernedPromptPieceEntity['tenantId'];
  Tenant?: IGovernedPromptPieceEntity['Tenant'];

  createdAt?: IGovernedPromptPieceEntity['createdAt'];
  updatedAt?: IGovernedPromptPieceEntity['updatedAt'];
  createdBy?: IGovernedPromptPieceEntity['createdBy'];
  updatedBy?: IGovernedPromptPieceEntity['updatedBy'];
}

export class GovernedPromptPieceFactory {
  static CreateGovernedPromptPiece(props: CreateGovernedPromptPieceProps): GovernedPromptPieceEntity {
    const id = generateId();
    const now = new Date();

    return new GovernedPromptPieceEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      digest: props.digest,
      kind: props.kind,
      sourceType: props.sourceType,
      sourceId: props.sourceId ?? null,
      sourceKey: props.sourceKey ?? null,
      policyVersion: props.policyVersion,
      verdict: props.verdict,
      findings: props.findings ?? null,
      textChars: props.textChars,
      screenedAt: props.screenedAt ?? now,
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
