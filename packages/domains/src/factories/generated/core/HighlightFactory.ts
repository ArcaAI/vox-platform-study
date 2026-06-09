/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { HighlightEntity, IHighlightEntity } from '../../../entities';

export interface CreateHighlightProps extends BaseEntityFactoryCreateProps {
  consultationId: IHighlightEntity['consultationId'];
  targetKind: IHighlightEntity['targetKind'];
  exact: IHighlightEntity['exact'];
  startOffset: IHighlightEntity['startOffset'];
  endOffset: IHighlightEntity['endOffset'];
  sourceContextItemId?: IHighlightEntity['sourceContextItemId'];
  prefix?: IHighlightEntity['prefix'];
  suffix?: IHighlightEntity['suffix'];
  color?: IHighlightEntity['color'];
  label?: IHighlightEntity['label'];
  note?: IHighlightEntity['note'];
  tenantId: IHighlightEntity['tenantId'];

  createdAt?: IHighlightEntity['createdAt'];
  createdBy?: IHighlightEntity['createdBy'];
  updatedBy?: IHighlightEntity['updatedBy'];
}

export class HighlightFactory {
  /**
   * Create a durable manual-doctor highlight anchored to a persisted surface.
   */
  static CreateHighlight(props: CreateHighlightProps): HighlightEntity {
    const id = generateId();
    const now = new Date();

    return new HighlightEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,

      consultationId: props.consultationId,
      targetKind: props.targetKind,
      exact: props.exact,
      startOffset: props.startOffset,
      endOffset: props.endOffset,
      sourceContextItemId: props.sourceContextItemId ?? null,
      prefix: props.prefix ?? null,
      suffix: props.suffix ?? null,
      color: props.color ?? null,
      label: props.label ?? null,
      note: props.note ?? null,
      tenantId: props.tenantId,
    });
  }
}
