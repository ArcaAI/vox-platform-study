import 'reflect-metadata';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClsServiceManager } from 'nestjs-cls';

export function InjectActiveUser(): ClassDecorator {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    return (target: Function) => {
        const original = target;

        const construct = (constructor: any, args: any[]) => {
            const instance = new constructor(...args);

            // Simulate retrieving the user. Replace this with actual user retrieval logic.
            const user = ClsServiceManager.getClsService();
            instance.user = user;

            return instance;
        };

        // The new constructor behaviour
        const newConstructor: any = function (...args: any[]) {
            return construct(original, args);
        };

        // Copy prototype so intanceof operator still works
        newConstructor.prototype = original.prototype;

        return newConstructor;
    };
}
