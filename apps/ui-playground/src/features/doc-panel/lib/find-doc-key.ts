function readDocKeyFromElement(element: Element): string | null {
  const dataDoc = element.getAttribute('data-doc');
  if (dataDoc) return dataDoc;

  return null;
}

export function findDocKeyFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;

  let current: Element | null = target;
  while (current) {
    const key = readDocKeyFromElement(current);
    if (key) return key;

    current = current.parentElement;
  }

  return null;
}
