export type Path = readonly (string | number)[];

export function pathKey(path: Path): string {
  return path.join('.');
}

export function getAt(root: unknown, path: Path): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/** Returns a copy of `root` with `value` at `path`, copying only the containers on the way. */
export function setAt<T>(root: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path as [string | number, ...(string | number)[]];
  const container: unknown = root;
  if (Array.isArray(container)) {
    const copy = [...container];
    copy[head as number] = setAt(copy[head as number], rest, value);
    return copy as T;
  }
  const obj = (container !== null && typeof container === 'object' ? container : {}) as Record<
    string,
    unknown
  >;
  return { ...obj, [head]: setAt(obj[head as string], rest, value) } as T;
}
