import { z } from 'zod';

/** The subset of JSON Schema that the form generator and decoder use. */
export interface JsonSchemaNode {
  type?: string;
  title?: string;
  description?: string;
  placeholder?: string;
  format?: string;
  pattern?: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export function toJsonSchema(schema: z.ZodType): JsonSchemaNode {
  return z.toJSONSchema(schema) as JsonSchemaNode;
}

/** Keywords the decoder is given. Everything else is enforced by Zod afterwards. */
const DECODER_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'additionalProperties',
]);

/**
 * Reduces a JSON Schema to the structural subset used to constrain decoding:
 * types, nesting, required keys and enums. Ranges, regex patterns, formats
 * and cross-field rules are left to Zod, so the grammar stays small and
 * nothing depends on the decoder's support for those keywords.
 */
export function toDecoderSchema(node: JsonSchemaNode): JsonSchemaNode {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!DECODER_KEYWORDS.has(key)) continue;
    if (key === 'properties' && value !== undefined) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchemaNode>).map(([k, child]) => [
          k,
          toDecoderSchema(child),
        ]),
      );
    } else if (key === 'items' && value !== undefined) {
      out[key] = toDecoderSchema(value as JsonSchemaNode);
    } else {
      out[key] = value;
    }
  }
  return out as JsonSchemaNode;
}
