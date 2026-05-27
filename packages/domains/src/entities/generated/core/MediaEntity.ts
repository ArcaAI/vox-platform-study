/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IMediaEntity extends IBaseTaggedEntity {
  name: string;
  uri: string;
  extension: string;
  mimeType: string;
  size: number;
  hash: string;
  bucketId?: string | null;
  UserMedias?: Entities.UserMediaEntity[] | null;
}

export class MediaEntity extends BaseTaggedEntity {
  private _name: IMediaEntity['name'];
  private _uri: IMediaEntity['uri'];
  private _extension: IMediaEntity['extension'];
  private _mimeType: IMediaEntity['mimeType'];
  private _size: IMediaEntity['size'];
  private _hash: IMediaEntity['hash'];
  private _bucketId?: IMediaEntity['bucketId'];
  private _UserMedias?: IMediaEntity['UserMedias'];

  constructor(init: IMediaEntity) {
    super(init);
    this._name = init.name;
    this._uri = init.uri;
    this._extension = init.extension;
    this._mimeType = init.mimeType;
    this._size = init.size;
    this._hash = init.hash;
    this._bucketId = init.bucketId;
    this._UserMedias = init.UserMedias;
  }

  get name(): IMediaEntity['name'] {
    return this._name;
  }

  set name(value: IMediaEntity['name']) {
    this.setProperty('name', value);
  }

  get uri(): IMediaEntity['uri'] {
    return this._uri;
  }

  set uri(value: IMediaEntity['uri']) {
    this.setProperty('uri', value);
  }

  get extension(): IMediaEntity['extension'] {
    return this._extension;
  }

  set extension(value: IMediaEntity['extension']) {
    this.setProperty('extension', value);
  }

  get mimeType(): IMediaEntity['mimeType'] {
    return this._mimeType;
  }

  set mimeType(value: IMediaEntity['mimeType']) {
    this.setProperty('mimeType', value);
  }

  get size(): IMediaEntity['size'] {
    return this._size;
  }

  set size(value: IMediaEntity['size']) {
    this.setProperty('size', value);
  }

  get hash(): IMediaEntity['hash'] {
    return this._hash;
  }

  set hash(value: IMediaEntity['hash']) {
    this.setProperty('hash', value);
  }

  get bucketId(): IMediaEntity['bucketId'] {
    return this._bucketId;
  }

  set bucketId(value: IMediaEntity['bucketId']) {
    this.setProperty('bucketId', value);
  }

  get UserMedias(): IMediaEntity['UserMedias'] {
    return this._UserMedias;
  }

  set UserMedias(value: IMediaEntity['UserMedias']) {
    this.setProperty('UserMedias', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Media name is required.');
    }
    if (this._name.length > 255) {
      throw new BusinessException('Media name must not exceed 255 characters.');
    }
    if (!this._uri || this._uri.trim().length === 0) {
      throw new BusinessException('Media uri is required.');
    }
    if (this._uri.length > 2048) {
      throw new BusinessException('Media uri must not exceed 2048 characters.');
    }
    if (!this._extension || this._extension.trim().length === 0) {
      throw new BusinessException('Media extension is required.');
    }
    if (this._extension.length > 32) {
      throw new BusinessException('Media extension must not exceed 32 characters.');
    }
    if (!this._mimeType || this._mimeType.trim().length === 0) {
      throw new BusinessException('Media mimeType is required.');
    }
    if (this._mimeType.length > 255) {
      throw new BusinessException('Media mimeType must not exceed 255 characters.');
    }
    if (
      typeof this._size !== 'number' ||
      !Number.isFinite(this._size) ||
      !Number.isInteger(this._size) ||
      this._size < 0
    ) {
      throw new BusinessException('Media size must be a non-negative number.');
    }
    if (!this._hash || this._hash.trim().length === 0) {
      throw new BusinessException('Media hash is required.');
    }
    if (this._hash.length > 255) {
      throw new BusinessException('Media hash must not exceed 255 characters.');
    }
    if (this._bucketId !== undefined && this._bucketId !== null && this._bucketId.trim().length === 0) {
      throw new BusinessException('Media bucketId must not be blank when provided.');
    }
  }
}
