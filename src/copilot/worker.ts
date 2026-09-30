import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

// Runs inference off the main thread so the form and chat stay responsive.
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (message: MessageEvent) => {
  handler.onmessage(message);
};
