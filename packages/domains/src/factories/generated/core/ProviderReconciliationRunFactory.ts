/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { IProviderReconciliationRunEntity, ProviderReconciliationRunEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateProviderReconciliationRunProps extends BaseEntityFactoryCreateProps {
  tenantId: IProviderReconciliationRunEntity['tenantId'];
  provider: IProviderReconciliationRunEntity['provider'];
  windowStart: IProviderReconciliationRunEntity['windowStart'];
  windowEnd: IProviderReconciliationRunEntity['windowEnd'];
  windowLabel: IProviderReconciliationRunEntity['windowLabel'];
  status: IProviderReconciliationRunEntity['status'];
  reason?: IProviderReconciliationRunEntity['reason'];
  ledgerQuantity?: IProviderReconciliationRunEntity['ledgerQuantity'];
  providerQuantity?: IProviderReconciliationRunEntity['providerQuantity'];
  providerUnit?: IProviderReconciliationRunEntity['providerUnit'];
  relativeDrift?: IProviderReconciliationRunEntity['relativeDrift'];
  breachedThreshold?: IProviderReconciliationRunEntity['breachedThreshold'];
  thresholdPct: IProviderReconciliationRunEntity['thresholdPct'];
  runAt?: IProviderReconciliationRunEntity['runAt'];

  createdAt?: IProviderReconciliationRunEntity['createdAt'];
  createdBy?: IProviderReconciliationRunEntity['createdBy'];
}

export class ProviderReconciliationRunFactory {
  /**
   * Build one reconciliation-run record.
   *
   * The comparison fields stay NULL on a skipped/failed run rather than
   * defaulting to 0: a stored 0 is indistinguishable from "the vendor genuinely
   * billed nothing", which is the one reading that must never be guessed.
   */
  static CreateProviderReconciliationRun(props: CreateProviderReconciliationRunProps): ProviderReconciliationRunEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new ProviderReconciliationRunEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      provider: props.provider,
      windowStart: props.windowStart,
      windowEnd: props.windowEnd,
      windowLabel: props.windowLabel,
      status: props.status,
      reason: props.reason ?? null,
      ledgerQuantity: props.ledgerQuantity ?? null,
      providerQuantity: props.providerQuantity ?? null,
      providerUnit: props.providerUnit ?? null,
      relativeDrift: props.relativeDrift ?? null,
      breachedThreshold: props.breachedThreshold ?? false,
      thresholdPct: props.thresholdPct,
      runAt: props.runAt ?? now,
    });
  }
}
