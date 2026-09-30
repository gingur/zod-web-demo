import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { App } from './App';

const meta = {
  title: 'App/Todo Assistant',
  component: App,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

const titles = (canvas: ReturnType<typeof within>) =>
  canvas.queryAllByTestId('todo').map((li: HTMLElement) => li.textContent);

export const Idle: Story = {};

/**
 * The path the live demo takes, with the scripted model: the first attempt
 * guesses an id, the tool rejects it, the model corrects it, and only then
 * does the list change. The reply is the facts of what happened, written by code.
 */
export const RejectsThenApplies: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Use scripted mode instead' }));
    await userEvent.click(canvas.getByRole('button', { name: /Add eggs and bread/ }));

    await expect(
      await canvas.findByText(/Attempt 1 rejected by Zod/, {}, { timeout: 10_000 }),
    ).toHaveTextContent('There is no todo with id "buy-milk"');
    await expect(
      await canvas.findByText(
        "Added 'Eggs'. Added 'Bread'. Marked 'Buy milk' as done.",
        {},
        { timeout: 10_000 },
      ),
    ).toBeInTheDocument();
    await expect(await canvas.findByText('✓ toggle_todo')).toBeInTheDocument();
    await expect(titles(canvas)).toEqual(['Buy milk', 'Walk the dog', 'Call mom', 'Eggs', 'Bread']);
    await expect(canvas.getByLabelText('Toggle Buy milk')).toBeChecked();
  },
};

export const RefusesOffTopic: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Use scripted mode instead' }));
    await userEvent.click(canvas.getByRole('button', { name: /poem about cats/ }));
    await expect(
      await canvas.findByText(/I can only help with your todo list/, {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await expect(canvas.queryByText(/✓/)).toBeNull();
    await expect(titles(canvas)).toEqual(['Buy milk', 'Walk the dog', 'Call mom']);
  },
};

/** A question: nothing changes, and the model answers in its own words. */
export const AnswersQuestion: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Use scripted mode instead' }));
    await userEvent.click(canvas.getByRole('button', { name: 'What can you do?' }));
    await expect(
      await canvas.findByText(
        /I can add, rename, complete and delete todos/,
        {},
        { timeout: 10_000 },
      ),
    ).toBeInTheDocument();
    await expect(canvas.queryByText(/✓/)).toBeNull();
    await expect(titles(canvas)).toEqual(['Buy milk', 'Walk the dog', 'Call mom']);
  },
};
