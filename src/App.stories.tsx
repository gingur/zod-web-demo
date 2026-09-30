import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { App } from './App';

const meta = {
  title: 'App/Schema Copilot',
  component: App,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

/**
 * The end-to-end path the live demo takes, with the scripted model: the first
 * attempt breaks a cross-field rule, Zod rejects it, the model corrects it, and
 * only then does the form change.
 */
export const RejectsThenApplies: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Use scripted mode instead' }));
    await userEvent.click(canvas.getByRole('button', { name: /Run this on mobile only/ }));

    await expect(
      await canvas.findByText(/Rejected by Zod/, {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await expect(
      await canvas.findByText('Applied after 2 attempts', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();

    await expect(canvas.getByLabelText('Discount code')).toHaveValue('SAVE15');
    await expect(canvas.getByLabelText('Trigger')).toHaveValue('time_on_page');
    await expect(canvas.getByText('Valid')).toBeInTheDocument();

    await userEvent.click(canvas.getByRole('button', { name: 'Undo AI change' }));
    await expect(canvas.getByLabelText('Discount code')).toHaveValue('WELCOME10');
  },
};

export const NumericRuleRecovers: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Use scripted mode instead' }));
    await userEvent.click(canvas.getByRole('button', { name: /visitors from Instagram/ }));
    await expect(
      await canvas.findByText(/greater_than needs a number/, {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await expect(
      await canvas.findByText('Applied after 2 attempts', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await expect(
      canvas.getAllByLabelText('Value').map((el) => (el as HTMLInputElement).value),
    ).toEqual(['instagram', '50']);
  },
};
