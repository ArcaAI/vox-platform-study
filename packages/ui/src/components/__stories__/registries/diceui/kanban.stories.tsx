import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanItem,
} from '../../../registries/diceui/kanban'

const meta = {
  title: 'Registries/DiceUI/Kanban',
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const initialValue = {
  todo: ['task-1', 'task-2'],
  'in-progress': ['task-3'],
  done: ['task-4'],
}

export const Default: Story = {
  render: () => (
    <Kanban value={initialValue} onValueChange={() => {}}>
      <KanbanBoard>
        <KanbanColumn value="todo">
          {initialValue.todo.map((id) => (
            <KanbanItem key={id} value={id}>
              {id}
            </KanbanItem>
          ))}
        </KanbanColumn>
        <KanbanColumn value="in-progress">
          {initialValue['in-progress'].map((id) => (
            <KanbanItem key={id} value={id}>
              {id}
            </KanbanItem>
          ))}
        </KanbanColumn>
        <KanbanColumn value="done">
          {initialValue.done.map((id) => (
            <KanbanItem key={id} value={id}>
              {id}
            </KanbanItem>
          ))}
        </KanbanColumn>
      </KanbanBoard>
    </Kanban>
  ),
}
