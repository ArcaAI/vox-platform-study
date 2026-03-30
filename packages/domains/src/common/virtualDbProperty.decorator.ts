export function VirtualDbProperty() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, propertyKey: string) {
    if (!target.constructor.__virtualProperties) {
      target.constructor.__virtualProperties = [];
    }
    target.constructor.__virtualProperties.push(propertyKey);
  };
}
