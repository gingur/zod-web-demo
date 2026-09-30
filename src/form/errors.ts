import type { z } from 'zod';
import { pathKey, type Path } from '@/lib/path';

/** First validation message per dotted path; an empty map means the value is valid. */
export function validationErrors(schema: z.ZodType, value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const result = schema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = pathKey(issue.path as Path);
      if (!map.has(key)) map.set(key, issue.message);
    }
  }
  return map;
}
