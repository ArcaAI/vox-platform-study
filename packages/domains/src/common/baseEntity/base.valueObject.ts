import { toObject } from '../toObject';
import { toRawObject } from '../toRawObject';

export abstract class BaseValueObject {
    constructor() {}

    equals(vo?: BaseValueObject): boolean {
        if (vo === null || vo === undefined) {
            return false;
        }

        // Compare the entire object by stringifying its content
        return JSON.stringify(this) === JSON.stringify(vo);
    }

    /**
     * Converts the instance of a class to a plain object.
     * This method iterates over the properties of the instance,
     * applies a conversion function to each property's value,
     * and returns a new object with the same property names and values.
     * The returned object is immutable.
     */
    public toRawObject(): object {
        return toRawObject(this);
    }

    /**
     * Converts the instance of a class to a plain object.
     * This method iterates over the properties of the instance,
     * removes leading underscores from property names,
     * applies a conversion function to each property's value,
     * and returns a new object with the modified property names and values.
     * The returned object is immutable.
     */
    public toObject(): object {
        return toObject(this);
    }

    /**
     * Converts the instance of a class to a JSON string. (Used by JSON.stringify)
     * @returns A JSON string representing the object.
     */
    public toJSON() {
        return this.toObject();
    }

    public toValue(): unknown {
        return this;
    }
}
