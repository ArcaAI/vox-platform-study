/**
 * Util function to generate different strings based off the provided name.
 *
 * Examples:
 *
 * ```typescript
 * simpleNames("my-name") // {name: 'my-name', className: 'MyName', propertyName: 'myName', constantName: 'MY_NAME', fileName: 'my-name'}
 * simpleNames("myName") // {name: 'myName', className: 'MyName', propertyName: 'myName', constantName: 'MY_NAME', fileName: 'my-name'}
 * ```
 * @param name
 */
export function simpleNames(name: string) {
  return {
    name,
    className: toClassName(name),
    propertyName: toPropertyName(name),
    constantName: toConstantName(name),
    fileName: toFileName(name),
  };
}

/**
 * Extended utility function to generate comprehensive naming conventions for various application components.
 * This function builds upon simpleNames to provide a more complete set of naming patterns commonly used
 * in application development.
 *
 * @param name The base name to generate variations from
 * @returns An object containing various naming conventions for different application components
 *
 * @example
 * ```typescript
 * names("user-profile")
 * // Returns an object with properties like:
 * // {
 * //   name: 'userProfile',
 * //   className: 'UserProfile',
 * //   entityName: 'UserProfileEntity',
 * //   serviceName: 'UserProfileService',
 * //   ...and many more
 * // }
 * ```
 */
export function names(name: string) {
  const formattedNames = simpleNames(name);

  return {
    name: formattedNames.propertyName,
    className: formattedNames.className,
    entityName: `${formattedNames.className}Entity`,
    dataModelName: `${formattedNames.className}Model`,
    mapperName: `${formattedNames.className}Mapper`,
    dtoMapperName: `${formattedNames.className}DtoMapper`,
    serviceName: `${formattedNames.className}Service`,
    serviceModuleName: `${formattedNames.className}ServiceModule`,
    servicePropertyName: `${formattedNames.name}Service`,
    interfaceName: `I${formattedNames.className}Service`,

    // File Names
    serviceFileName: `${formattedNames.name}.service`,
    serviceModuleFileName: `${formattedNames.name}.service.module`,
    dtoMapperFileName: `${formattedNames.name}.dto.mapper`,
    responseDtoFileName: `${formattedNames.name}.response`,
    paginatedResponseDtoFileName: `paginated${formattedNames.className}.response`,
    createDtoFileName: `create${formattedNames.className}.request`,
    updateDtoFileName: `update${formattedNames.className}.request`,

    // Dto
    responseName: `${formattedNames.className}Response`,
    paginatedResponseName: `Paginated${formattedNames.className}Response`,
    createDtoName: `Create${formattedNames.className}Request`,
    updateDtoName: `Update${formattedNames.className}Request`,

    // Service
    repositoryName: `${formattedNames.className}Repository`,
    repositoryPropertyName: `${formattedNames.propertyName}Repository`,
    resourceTypeName: formattedNames.className,
    factoryName: `${formattedNames.className}Factory`,
    factoryFuncName: `Create${formattedNames.className}`,

    individualEntityPropertyName: formattedNames.propertyName,
    multipleEntitiesPropertyName: `${formattedNames.propertyName}s`,

    // Api
    controllerFileName: `${formattedNames.name}.controller`,
    controllerModuleFileName: `${formattedNames.name}.module`,

    controllerName: `${formattedNames.className}Controller`,
    controllerModuleName: `${formattedNames.className}Module`,
  };
}

export default names;

/**
 * Hyphenated to UpperCamelCase
 */
export function toClassName(str: string) {
  return toCapitalCase(toPropertyName(str));
}
/**
 * Hyphenated to lowerCamelCase
 */
export function toPropertyName(s: string) {
  return s
    .replace(/([^a-zA-Z0-9])+(.)?/g, (_, __, chr) => (chr ? chr.toUpperCase() : ''))
    .replace(/[^a-zA-Z\d]/g, '')
    .replace(/^([A-Z])/, (m) => m.toLowerCase());
}
/**
 * Hyphenated to CONSTANT_CASE
 */
export function toConstantName(s: string) {
  const normalizedS = s.toUpperCase() === s ? s.toLowerCase() : s;
  return toFileName(toPropertyName(normalizedS))
    .replace(/([^a-zA-Z0-9])/g, '_')
    .toUpperCase();
}
/**
 * Upper camelCase to lowercase, hyphenated
 */
export function toFileName(s: string) {
  return s
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/(?!^[_])[ _]/g, '-');
}
/**
 * Capitalizes the first letter of a string
 */
export function toCapitalCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
