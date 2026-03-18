/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AsrPipelineEntity, IAsrPipelineEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateAsrPipelineProps extends BaseEntityFactoryCreateProps {
    name: IAsrPipelineEntity['name'];
    slug: IAsrPipelineEntity['slug'];
    description?: IAsrPipelineEntity['description'];
    configYaml: IAsrPipelineEntity['configYaml'];
    tenantId?: IAsrPipelineEntity['tenantId'];
    tags?: IAsrPipelineEntity['tags'];

    createdAt?: IAsrPipelineEntity['createdAt'];
    updatedAt?: IAsrPipelineEntity['updatedAt'];
    createdBy?: IAsrPipelineEntity['createdBy'];
    updatedBy?: IAsrPipelineEntity['updatedBy'];
}

export class AsrPipelineFactory {
    /**
     * Create a new ASR pipeline
     */
    static CreateAsrPipeline(props: CreateAsrPipelineProps): AsrPipelineEntity {
        const id = generateId();
        const now = new Date();

        return new AsrPipelineEntity({
            id,

            createdAt: props.createdAt || now,
            updatedAt: props.updatedAt || now,
            createdBy: props.createdBy ?? null,
            updatedBy: props.updatedBy || null,

            name: props.name,
            slug: props.slug,
            description: props.description ?? null,
            configYaml: props.configYaml,
            tenantId: props.tenantId ?? '',
            tags: props.tags ?? [],
        });
    }

    /**
     * Generate a URL-friendly slug from a name
     */
    static GenerateSlug(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
    }
}
