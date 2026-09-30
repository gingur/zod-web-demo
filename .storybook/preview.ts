import type { Preview } from '@storybook/react-vite';
import '../src/index.css';

const preview: Preview = {
  tags: ['test'],
  parameters: { layout: 'padded' },
};

export default preview;
