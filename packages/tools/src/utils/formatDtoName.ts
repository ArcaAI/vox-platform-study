export function formatDtoName(name: string) {
    const isArray = name.endsWith('[]');
    const postFix = isArray ? '[]' : '';

    if (name.endsWith('Request' + postFix)) {
        return name.replace('Request' + postFix, 'RequestDto' + postFix);
    }
    if (name.endsWith('Response' + postFix)) {
        return name.replace('Response' + postFix, 'ResponseDto' + postFix);
    }
    if (name.endsWith('Enum' + postFix)) {
        return name.replace('Enum' + postFix, 'EnumDto' + postFix);
    }
    if (name === 'DtoRecord' + postFix) {
        return 'DtoRecordDto' + postFix;
    }
    return name;
}

export default formatDtoName;