import { Transform } from 'class-transformer';
import { Decimal } from 'decimal.js';

export function VirtualDbProperty() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, propertyKey: string) {
    if (!target.constructor.__virtualProperties) {
      target.constructor.__virtualProperties = [];
    }
    target.constructor.__virtualProperties.push(propertyKey);
  };
}

export function ToDecimal() {
  return Transform(({ value }) => {
    if (value instanceof Decimal) {
      return value.toString();
    }
    return value;
  });
}

export class TestDtoRecord {
  id!: string;
  value!: string;
}

export interface TestBaseResponseProps {
  id: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

export class TestBaseResponse {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;

  constructor(props: TestBaseResponseProps) {
    this.id = props.id;
    this.createdAt = new Date(props.createdAt).toISOString();
    this.updatedAt = new Date(props.updatedAt).toISOString();
    this.archivedAt = props.archivedAt ? new Date(props.archivedAt).toISOString() : null;
    this.deletedAt = props.deletedAt ? new Date(props.deletedAt).toISOString() : null;
    this.createdBy = props.createdBy;
    this.updatedBy = props.updatedBy;
  }
}

/* Test Models */
export class TestBaseDataModel {
  public id: string;
  public createdBy: string | null;
  public updatedBy: string | null;
  public createdAt: Date;
  public updatedAt: Date;
  public archivedAt: Date | null;
  public deletedAt: Date | null;

  constructor(init: TestBaseDataModel) {
    this.id = init.id;
    this.createdBy = init.createdBy;
    this.updatedBy = init.updatedBy;
    this.createdAt = init.createdAt;
    this.updatedAt = init.updatedAt;
    this.archivedAt = init.archivedAt;
    this.deletedAt = init.deletedAt;
  }
}
