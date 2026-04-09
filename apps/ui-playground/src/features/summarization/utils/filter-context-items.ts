export interface ContextItemLike {
  id: string;
  type?: string;
  content?: string;
  createdAt?: string;
}

export type ContextRecency = 'ALL' | '24H' | '7D' | '30D';

export interface ContextItemFilter {
  query: string;
  type: string;
  recency: ContextRecency;
}

function isFuzzyMatch(value: string, query: string): boolean {
  if (!query) return true;
  const source = value.toLowerCase();
  const target = query.toLowerCase();

  let sourceIndex = 0;
  for (let queryIndex = 0; queryIndex < target.length; queryIndex += 1) {
    sourceIndex = source.indexOf(target[queryIndex], sourceIndex);
    if (sourceIndex === -1) return false;
    sourceIndex += 1;
  }

  return true;
}

function isWithinRecency(createdAt: string | undefined, recency: ContextRecency, now: Date): boolean {
  if (recency === 'ALL') return true;
  if (!createdAt) return false;

  const createdAtTime = new Date(createdAt).getTime();
  if (Number.isNaN(createdAtTime)) return false;

  const nowTime = now.getTime();
  const dayMillis = 24 * 60 * 60 * 1000;
  const thresholdMillis = recency === '24H' ? dayMillis : recency === '7D' ? dayMillis * 7 : dayMillis * 30;

  if (createdAtTime > nowTime) return false;
  return nowTime - createdAtTime <= thresholdMillis;
}

export function filterContextItems(items: ContextItemLike[], filter: ContextItemFilter, now = new Date()): ContextItemLike[] {
  const query = filter.query.trim();

  return items.filter((item) => {
    const itemType = item.type ?? 'UNKNOWN';
    const idMatch = isFuzzyMatch(item.id, query);
    const typeMatch = filter.type === 'ALL' || itemType === filter.type;
    const recencyMatch = isWithinRecency(item.createdAt, filter.recency, now);

    return idMatch && typeMatch && recencyMatch;
  });
}
