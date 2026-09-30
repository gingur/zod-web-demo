import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { setAt } from '@/lib/path';
import { campaignSchema, defaultCampaign } from '@/schema/campaign';
import { toJsonSchema } from '@/schema/jsonSchema';
import { validationErrors } from './errors';
import { deriveFields } from './fields';
import { SchemaForm } from './SchemaForm';

const fields = deriveFields(toJsonSchema(campaignSchema));

/** A stateful form validated by the schema, the way the app wires it. */
function Harness({ initial = defaultCampaign as unknown, changed = [] as string[] }) {
  const [value, setValue] = useState<unknown>(initial);
  const errors = useMemo(() => validationErrors(campaignSchema, value), [value]);
  return (
    <div className="max-w-3xl">
      <p className="mb-4 text-sm" data-testid="status">
        {errors.size === 0 ? 'Valid' : `${errors.size} errors`}
      </p>
      <SchemaForm
        fields={fields}
        value={value}
        onChange={(path, next) => setValue((v: unknown) => setAt(v, path, next))}
        errors={errors}
        changed={new Set(changed)}
        changeRevision={1}
      />
    </div>
  );
}

const meta = {
  title: 'Form/SchemaForm',
  component: Harness,
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Generated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('status')).toHaveTextContent('Valid');
    for (const label of [
      'Campaign name',
      'Start date',
      'Trigger',
      'Excluded paths',
      'Discount code',
    ]) {
      await expect(canvas.getAllByText(label).length).toBeGreaterThan(0);
    }
  },
};

export const RejectsBadPath: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText('Excluded paths');
    await userEvent.type(input, 'checkout{enter}');
    await expect(await canvas.findByText('Paths must start with /')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove checkout' }));
    await expect(canvas.getByTestId('status')).toHaveTextContent('Valid');
  },
};

export const CrossFieldRule: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'desktop' }));
    await expect(await canvas.findByText(/Exit intent needs a desktop cursor/)).toBeInTheDocument();
  },
};

export const RepeaterAddsRules: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '+ Add' }));
    await expect(await canvas.findByText('Enter a value')).toBeInTheDocument();
    await userEvent.type(canvas.getByLabelText('Value'), 'instagram');
    await expect(canvas.getByTestId('status')).toHaveTextContent('Valid');
  },
};

export const HighlightedChanges: Story = {
  args: { changed: ['offer', 'offer.code', 'targeting', 'targeting.devices'] },
};
