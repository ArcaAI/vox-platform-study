import { useState } from 'react';
import { MasterDetailLayout, type MasterDetailColumnDefinition, type MasterDetailColumnState } from '../../../shadcn/master-detail-layout';

// Playwright CT proxies function props as async RPC to Node, so render-prop
// callbacks (renderItem / keyExtractor) cannot return values synchronously in
// the browser. These fixtures keep those functions inside browser-bundled code
// and expose only serializable props to the test.

interface FruitItem {
  id: string;
  name: string;
}

const fruits: FruitItem[] = [
  { id: 'apple', name: 'Apple' },
  { id: 'banana', name: 'Banana' },
  { id: 'cherry', name: 'Cherry' },
];

const fruitColumn: MasterDetailColumnDefinition<FruitItem> = {
  id: 'fruits',
  title: 'Fruits',
  description: '3 total',
  skeletonCount: 3,
  emptyTitle: 'No fruits',
  emptyDescription: 'No fruits found.',
  renderItem: (item) => <span>{item.name}</span>,
  keyExtractor: (item) => item.id,
};

export function FruitMasterDetail({ selectedId = null }: { selectedId?: string | null }) {
  const columns: MasterDetailColumnDefinition<FruitItem>[] = [fruitColumn];
  const states: MasterDetailColumnState<FruitItem>[] = [{ data: fruits, isLoading: false, selectedId, onSelect: () => {} }];
  return <MasterDetailLayout columns={columns} states={states} />;
}

export function InteractiveFruitMasterDetail() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const columns: MasterDetailColumnDefinition<FruitItem>[] = [fruitColumn];
  const states: MasterDetailColumnState<FruitItem>[] = [{ data: fruits, isLoading: false, selectedId, onSelect: setSelectedId }];
  return (
    <div>
      <MasterDetailLayout columns={columns} states={states} />
      <span data-testid="selected-fruit">{selectedId ?? ''}</span>
    </div>
  );
}
