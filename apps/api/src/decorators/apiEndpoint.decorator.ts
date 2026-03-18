/* eslint-disable @typescript-eslint/no-explicit-any */
import {
    HttpMethod,
    ApiResponseType,
    PaginatedResponse
} from '@arcaai/applications';
import {
    applyDecorators,
    Type,
    Get,
    Post,
    Put,
    Delete,
    Patch
} from '@nestjs/common';
import {
    ApiExtraModels,
    ApiOkResponse,
    ApiOperation,
    getSchemaPath
} from '@nestjs/swagger';

export type RetrievalParams = string[];

export interface ApiEndpointOptions<TModel extends Type<any>> {
    method?: HttpMethod;
    path?: string | string[];
    returnedModel: TModel;
    type?: ApiResponseType;
    multi?: boolean;
    append?: string;
    by?: RetrievalParams;
    byAnd?: RetrievalParams;
    byOr?: RetrievalParams;
    additionalData?: object;
}

/**
 *  Decorator for defining an API endpoint
 * @param param0
 * @returns
 */
export function ApiEndpoint<TModel extends Type<any>>({
    method = HttpMethod.GET,
    path,
    returnedModel,
    type = ApiResponseType.SINGLE,
    multi,
    append,
    by,
    byAnd,
    byOr,
    additionalData
}: ApiEndpointOptions<TModel>) {
    const entityName = returnedModel.name;
    const isMulti = multi || type === ApiResponseType.MULTIPLE;
    const responseType = isMulti ? ApiResponseType.MULTIPLE : type;

    const description =
        getDescription(method, isMulti, entityName, by || byAnd, byOr) +
        (append ? ` ${append}` : '');

    const schema = getResponseTypesSchema(returnedModel, responseType);

    const apiOkResponseOptions = {
        description,
        schema,
        ...additionalData
    };

    const methodDecorator = getHttpMethodDecorator(method, path);

    const decorators = [
        ApiOperation({ summary: description }),
        methodDecorator,
        ApiExtraModels(returnedModel) // Add this line
    ];
    if (isMulti) {
        decorators.push(ApiExtraModels(PaginatedResponse));
    }
    decorators.push(ApiOkResponse(apiOkResponseOptions));

    return applyDecorators(...decorators);
}

function getDescription(
    method: HttpMethod,
    isMulti: boolean,
    entityName: string,
    byAnd?: RetrievalParams,
    byOr?: RetrievalParams
): string {
    let baseDescription;
    switch (method) {
        case HttpMethod.GET:
            baseDescription = isMulti
                ? `Retrieving multiple ${entityName}s`
                : `Retrieving a single ${entityName}`;
            break;
        case HttpMethod.POST:
            baseDescription = `Creating a ${entityName}`;
            break;
        case HttpMethod.PUT:
        case HttpMethod.PATCH:
            baseDescription = `Updating a ${entityName}`;
            break;
        case HttpMethod.DELETE:
            baseDescription = `Deleting a ${entityName}`;
            break;
        default:
            baseDescription = 'Operation';
    }

    if (byAnd || byOr) {
        const andConditions = byAnd?.length ? `by ${byAnd.join(' and ')}` : '';
        const orConditions = byOr?.length ? `or ${byOr.join(' or ')}` : '';
        const conjunction = andConditions && orConditions ? ' and ' : '';
        baseDescription +=
            andConditions || orConditions
                ? ` ${andConditions}${conjunction}${orConditions}`
                : '';
    }
    return baseDescription;
}

const getHttpMethodDecorator = (
    httpMethod: HttpMethod,
    path?: string | string[]
) => {
    switch (httpMethod) {
        case HttpMethod.POST:
            return Post(path);
        case HttpMethod.PUT:
            return Put(path);
        case HttpMethod.DELETE:
            return Delete(path);
        case HttpMethod.PATCH:
            return Patch(path);
        case HttpMethod.GET:
        default:
            return Get(path);
    }
};

function getResponseTypesSchema(
    returnedModel: Type<any>,
    responseType: ApiResponseType
) {
    if (responseType === ApiResponseType.SINGLE) {
        return {
            $ref: getSchemaPath(returnedModel)
        };
    }
    return {
        allOf: [
            { $ref: getSchemaPath(PaginatedResponse) },
            {
                properties: {
                    data: {
                        type: 'array',
                        items: { $ref: getSchemaPath(returnedModel) }
                    }
                }
            }
        ]
    };
}
