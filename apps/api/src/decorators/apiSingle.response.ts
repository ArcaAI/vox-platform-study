import { applyDecorators, Type } from '@nestjs/common';
import { ApiOkResponse, getSchemaPath } from '@nestjs/swagger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ApiSingleResponse = <TModel extends Type<any>>(model: TModel) => {
    return applyDecorators(
        ApiOkResponse({
            description: 'Single entity response',
            schema: {
                $ref: getSchemaPath(model),
            },
        }),
    );
};
