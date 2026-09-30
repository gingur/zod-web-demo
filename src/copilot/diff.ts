import { pathKey, type Path } from '@/lib/path';

export interface Change {
  path: string;
  before: unknown;
  after: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isPlainObject);
}

/**
 * Leaf-level differences between two configs. Objects recurse; arrays of
 * objects recurse per index; arrays of primitives compare as a single value,
 * which is how a person reads "devices changed from [a, b] to [b]".
 */
export function diff(before: unknown, after: unknown, path: Path = []): Change[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) => diff(before[k], after[k], [...path, k]));
  }
  if (isObjectArray(before) && isObjectArray(after) && (before.length > 0 || after.length > 0)) {
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, i) => diff(before[i], after[i], [...path, i])).flat();
  }
  return JSON.stringify(before) === JSON.stringify(after)
    ? []
    : [{ path: pathKey(path), before, after }];
}

/** Every path prefix touched by a set of changes, so a changed leaf also highlights its group. */
export function changedPrefixes(changes: readonly Change[]): Set<string> {
  const out = new Set<string>();
  for (const { path } of changes) {
    const parts = path.split('.');
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('.'));
  }
  return out;
}
