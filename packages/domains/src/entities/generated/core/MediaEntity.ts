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
    throw new BusinessException('Method not implemented.');
  }
}
