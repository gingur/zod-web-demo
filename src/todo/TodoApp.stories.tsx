import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { initialState, type Call, type TodoState } from './schema';
import { applyCall } from './tools';
import { TodoApp } from './TodoApp';

function Harness() {
  const [state, setState] = useState<TodoState>(initialState);
  const dispatch = (call: Call) =>
    setState((s) => {
      const result = applyCall(s, call);
      return result.ok ? result.state : s;
    });
  return (
    <div className="mx-auto max-w-[550px]">
      <TodoApp state={state} dispatch={dispatch} />
    </div>
  );
}

const meta = {
  title: 'Todo/TodoMVC',
  component: Harness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

const titles = (canvas: ReturnType<typeof within>) =>
  canvas.queryAllByTestId('todo').map((li: HTMLElement) => li.textContent);

export const Default: Story = {};

export const AddEditToggleDelete: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('New todo'), 'Eggs{Enter}');
    await userEvent.type(canvas.getByLabelText('New todo'), '   {Enter}');
    await expect(titles(canvas)).toEqual(['Buy milk', 'Walk the dog', 'Call mom', 'Eggs']);
    await expect(canvas.getByText('items left', { exact: false })).toHaveTextContent(
      '3 items left',
    );

    await userEvent.dblClick(canvas.getByText('Call mom'));
    const edit = canvas.getByLabelText('Edit Call mom');
    await userEvent.clear(edit);
    await userEvent.type(edit, 'Call dad{Enter}');
    await expect(titles(canvas)).toContain('Call dad');

    await userEvent.click(canvas.getByLabelText('Toggle Eggs'));
    await expect(canvas.getByText('items left', { exact: false })).toHaveTextContent(
      '2 items left',
    );

    await userEvent.click(canvas.getByLabelText('Delete Buy milk'));
    await expect(titles(canvas)).toEqual(['Walk the dog', 'Call dad', 'Eggs']);

    // As in TodoMVC, clearing a todo's text in the editor deletes it.
    await userEvent.dblClick(canvas.getByText('Eggs'));
    await userEvent.clear(canvas.getByLabelText('Edit Eggs'));
    await userEvent.keyboard('{Enter}');
    await expect(titles(canvas)).toEqual(['Walk the dog', 'Call dad']);
  },
};

export const FiltersToggleAllAndClear: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: 'Active' }));
    await expect(titles(canvas)).toEqual(['Buy milk', 'Call mom']);
    await userEvent.click(canvas.getByRole('link', { name: 'Completed' }));
    await expect(titles(canvas)).toEqual(['Walk the dog']);
    await userEvent.click(canvas.getByRole('link', { name: 'All' }));

    await userEvent.click(canvas.getByLabelText('Mark all as complete'));
    await expect(canvas.getByText('items left', { exact: false })).toHaveTextContent(
      '0 items left',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Clear completed' }));
    await expect(titles(canvas)).toEqual([]);
  },
};
