import { TagEntity } from '../../entities';
import { BaseTenantEntity, IBaseTenantEntity } from './base.tenantEntity';

export interface IBaseTaggedEntity extends IBaseTenantEntity {
  tags?: string[] | null;
  Tags?: TagEntity[] | null;
}

export abstract class BaseTaggedEntity extends BaseTenantEntity {
  private _tags?: IBaseTaggedEntity['tags'];
  private _Tags?: IBaseTaggedEntity['Tags'];

  constructor(props: IBaseTaggedEntity) {
    super(props);
    this._tags = props.tags || [];
    if (props.Tags && props.Tags.length > 0) {
      this._Tags = props.Tags;
    }
  }

  get tags(): IBaseTaggedEntity['tags'] {
    return this._tags;
  }

  set tags(tags: IBaseTaggedEntity['tags']) {
    this.setProperty('tags', tags);
  }

  get Tags(): IBaseTaggedEntity['Tags'] {
    return this._Tags;
  }

  set Tags(tags: IBaseTaggedEntity['Tags']) {
    this.setProperty('_Tags', tags);
  }

  public addTag(tag: TagEntity) {
    if (this.hasTag(tag)) {
      throw new Error('Tag already exists on entity');
    }
    if (!this._tags) {
      this.setProperty('_tags', [tag.id]);
    } else {
      this.setProperty('_tags', [...this._tags, tag.id]);
    }
  }

  public removeTag(tag: TagEntity) {
    if (!this.hasTag(tag)) {
      throw new Error('Tag does not exist on entity');
    }
    if (!this._tags) {
      this.setProperty('_tags', []);
    } else {
      this.setProperty(
        '_tags',
        this._tags.filter((t) => t !== tag.id),
      );
    }
  }

  public hasTag(tag: TagEntity): boolean {
    if (!this._tags) {
      return false;
    }
    return this._tags.includes(tag.id);
  }

  public override validate(): void {}
}
