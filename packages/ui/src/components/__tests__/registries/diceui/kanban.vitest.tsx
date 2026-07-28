import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Kanban, KanbanBoard, KanbanColumn, KanbanItem } from '@/components/registries/diceui/kanban';

describe('Kanban', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Kanban value={{ col1: ['a'] }} getItemValue={(i) => i}>
        <KanbanBoard>
          <KanbanColumn value="col1" asHandle>
            <KanbanItem value="a" asHandle>
              a
            </KanbanItem>
          </KanbanColumn>
        </KanbanBoard>
      </Kanban>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
