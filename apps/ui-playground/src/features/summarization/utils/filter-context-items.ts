export interface ContextItemLike {
  id: string;
  type?: string;
  content?: string;
  createdAt?: string;
  consultationId?: string;
}

export type ContextRecency = 'ALL' | '24H' | '7D' | '30D';

export interface ContextItemFilter {
  query: string;
  type: string;
  recency: ContextRecency;
  /** Optional patient filter — compares against the patientId resolved from an item's consultationId. 'ALL' disables filtering. */
  patientId?: string;
  /** Lookup: consultationId -> patientId, used with `patientId` filter. */
  consultationPatientMap?: Record<string, string | undefined>;
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
  const patientFilter = filter.patientId && filter.patientId !== 'ALL' ? filter.patientId : undefined;
  const patientMap = filter.consultationPatientMap ?? {};

  return items.filter((item) => {
    const itemType = item.type ?? 'UNKNOWN';
    const idMatch = isFuzzyMatch(item.id, query) || isFuzzyMatch(item.content ?? '', query);
    const typeMatch = filter.type === 'ALL' || itemType === filter.type;
    const recencyMatch = isWithinRecency(item.createdAt, filter.recency, now);
    const patientMatch = !patientFilter || (item.consultationId ? patientMap[item.consultationId] === patientFilter : false);

    return idMatch && typeMatch && recencyMatch && patientMatch;
  });
}
