import type { JsonSchemaNode } from '@/schema/jsonSchema';
import type { Path } from '@/lib/path';

interface FieldBase {
  path: Path;
  key: string;
  label: string;
  description: string | undefined;
}

export type Field =
  | (FieldBase & { kind: 'group'; fields: Field[] })
  | (FieldBase & {
      kind: 'repeater';
      itemFields: Field[];
      itemSchema: JsonSchemaNode;
      maxItems: number | undefined;
    })
  | (FieldBase & { kind: 'boolean' })
  | (FieldBase & {
      kind: 'number';
      integer: boolean;
      min: number | undefined;
      max: number | undefined;
    })
  | (FieldBase & { kind: 'text'; placeholder: string | undefined })
  | (FieldBase & { kind: 'date' })
  | (FieldBase & { kind: 'select'; options: readonly string[] })
  | (FieldBase & { kind: 'multiselect'; options: readonly string[] })
  | (FieldBase & { kind: 'tags'; placeholder: string | undefined });

export class UnsupportedFieldError extends Error {
  constructor(path: Path, detail: string) {
    super(
      `Field "${path.join('.') || '(root)'}" can't be rendered: ${detail}. ` +
        'Narrow the schema type instead of extending the generator.',
    );
    this.name = 'UnsupportedFieldError';
  }
}

export function deriveFields(root: JsonSchemaNode): Field[] {
  if (root.type !== 'object' || root.properties === undefined) {
    throw new UnsupportedFieldError([], 'the root must be an object');
  }
  return deriveObjectFields(root, []);
}

function deriveObjectFields(node: JsonSchemaNode, prefix: Path): Field[] {
  return Object.entries(node.properties ?? {}).map(([key, child]) =>
    deriveField(child, [...prefix, key], key),
  );
}

/** `path` is relative to the container being rendered, so repeater items reuse their fields per index. */
function deriveField(node: JsonSchemaNode, path: Path, key: string): Field {
  const base: FieldBase = { path, key, label: node.title ?? key, description: node.description };

  switch (node.type) {
    case 'object':
      return { ...base, kind: 'group', fields: deriveObjectFields(node, path) };
    case 'boolean':
      return { ...base, kind: 'boolean' };
    case 'integer':
    case 'number':
      return {
        ...base,
        kind: 'number',
        integer: node.type === 'integer',
        min: node.minimum,
        max: node.maximum,
      };
    case 'string':
      if (node.enum !== undefined) return { ...base, kind: 'select', options: node.enum };
      if (node.format === 'date') return { ...base, kind: 'date' };
      return { ...base, kind: 'text', placeholder: node.placeholder };
    case 'array': {
      const items = node.items;
      if (items === undefined) throw new UnsupportedFieldError(path, 'arrays need an item schema');
      if (items.type === 'object') {
        return {
          ...base,
          kind: 'repeater',
          itemFields: deriveObjectFields(items, []),
          itemSchema: items,
          maxItems: node.maxItems,
        };
      }
      if (items.type === 'string') {
        return items.enum !== undefined
          ? { ...base, kind: 'multiselect', options: items.enum }
          : { ...base, kind: 'tags', placeholder: node.placeholder ?? items.placeholder };
      }
      throw new UnsupportedFieldError(
        path,
        `arrays of ${items.type ?? 'unknown'} are not supported`,
      );
    }
    default:
      throw new UnsupportedFieldError(
        path,
        `type "${node.type ?? 'unknown'}" is not supported (unions included)`,
      );
  }
}

/** A blank value for a new repeater item, built from its schema. */
export function emptyValue(node: JsonSchemaNode): unknown {
  switch (node.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(node.properties ?? {}).map(([k, child]) => [k, emptyValue(child)]),
      );
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'integer':
    case 'number':
      return node.minimum ?? 0;
    case 'string':
      return node.enum?.[0] ?? '';
    default:
      return null;
  }
}
