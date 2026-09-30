import { z } from 'zod';

/** The subset of JSON Schema the decoder uses. */
export interface JsonSchemaNode {
  type?: string;
  const?: string | number | boolean;
  enum?: readonly (string | number | boolean)[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
  additionalProperties?: boolean;
  oneOf?: readonly JsonSchemaNode[];
  anyOf?: readonly JsonSchemaNode[];
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
  'const',
  'anyOf',
  'oneOf',
  'additionalProperties',
]);

/**
 * Reduces a JSON Schema to the structural subset used to constrain decoding:
 * types, nesting, required keys, enums and which tool shape is allowed.
 * Lengths, counts and every rule that depends on the current todos (such as
 * "that id exists") are left to Zod and the tools, so the grammar stays small.
 *
 * Zod writes a discriminated union as `oneOf` with `const` tags; they become
 * `anyOf` and single-value `enum`, the forms the decoder was verified with.
 * The tags already make the branches exclusive, so nothing is lost.
 */
export function toDecoderSchema(node: JsonSchemaNode): JsonSchemaNode {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!DECODER_KEYWORDS.has(key) || value === undefined) continue;
    switch (key) {
      case 'properties':
        out[key] = Object.fromEntries(
          Object.entries(value as Record<string, JsonSchemaNode>).map(([k, child]) => [
            k,
            toDecoderSchema(child),
          ]),
        );
        break;
      case 'items':
        out[key] = toDecoderSchema(value as JsonSchemaNode);
        break;
      case 'oneOf':
      case 'anyOf':
        out['anyOf'] = (value as JsonSchemaNode[]).map(toDecoderSchema);
        break;
      case 'const':
        out['enum'] = [value];
        break;
      default:
        out[key] = value;
    }
  }
  return out as JsonSchemaNode;
}
