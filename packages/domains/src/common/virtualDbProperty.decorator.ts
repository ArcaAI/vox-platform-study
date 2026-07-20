export function VirtualDbProperty() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a property decorator's `target` is the prototype of whatever class it's applied to; it writes an ad-hoc `__virtualProperties` static not declared on any known type, which TS's own `PropertyDecorator`/`Object` target types don't expose either
  return function (target: any, propertyKey: string) {
    if (!target.constructor.__virtualProperties) {
      target.constructor.__virtualProperties = [];
    }
    target.constructor.__virtualProperties.push(propertyKey);
  };
}
