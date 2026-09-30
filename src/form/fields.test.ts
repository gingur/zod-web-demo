import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { deriveFields, emptyValue, UnsupportedFieldError, type Field } from '@/form/fields';
import { campaignSchema, defaultCampaign } from '@/schema/campaign';
import { toDecoderSchema, toJsonSchema } from '@/schema/jsonSchema';
import { getAt, setAt } from '@/lib/path';

const jsonSchema = toJsonSchema(campaignSchema);
const fields = deriveFields(jsonSchema);
const find = (list: Field[], key: string) => list.find((f) => f.key === key);

describe('deriveFields', () => {
  test("mirrors the schema's top-level structure", () => {
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ['name', 'text'],
      ['status', 'select'],
      ['schedule', 'group'],
      ['trigger', 'group'],
      ['targeting', 'group'],
      ['audienceRules', 'repeater'],
      ['offer', 'group'],
      ['frequency', 'select'],
    ]);
  });

  test('maps nested types to controls with their metadata', () => {
    const schedule = find(fields, 'schedule');
    const targeting = find(fields, 'targeting');
    const trigger = find(fields, 'trigger');
    if (schedule?.kind !== 'group' || targeting?.kind !== 'group' || trigger?.kind !== 'group')
      throw new Error('groups');

    expect(find(schedule.fields, 'start')).toMatchObject({
      kind: 'date',
      path: ['schedule', 'start'],
      label: 'Start date',
    });
    expect(find(targeting.fields, 'devices')).toMatchObject({
      kind: 'multiselect',
      options: ['desktop', 'mobile', 'tablet'],
    });
    expect(find(targeting.fields, 'excludedPaths')).toMatchObject({
      kind: 'tags',
      placeholder: '/checkout',
    });
    expect(find(targeting.fields, 'newVisitorsOnly')?.kind).toBe('boolean');
    expect(find(trigger.fields, 'delaySeconds')).toMatchObject({
      kind: 'number',
      integer: true,
      min: 0,
      max: 120,
    });
  });

  test('repeater item fields use paths relative to the item', () => {
    const rules = find(fields, 'audienceRules');
    if (rules?.kind !== 'repeater') throw new Error('repeater');
    expect(rules.maxItems).toBe(5);
    expect(rules.itemFields.map((f) => f.path)).toEqual([['attribute'], ['operator'], ['value']]);
  });

  test("rejects unions and other shapes it can't render", () => {
    expect(() =>
      deriveFields(toJsonSchema(z.object({ v: z.union([z.string(), z.array(z.string())]) }))),
    ).toThrow(UnsupportedFieldError);
    expect(() => deriveFields(toJsonSchema(z.object({ v: z.array(z.number()) })))).toThrow(
      UnsupportedFieldError,
    );
  });
});

describe('emptyValue', () => {
  test('builds a blank audience rule from its schema', () => {
    const rules = find(fields, 'audienceRules');
    if (rules?.kind !== 'repeater') throw new Error('repeater');
    expect(emptyValue(rules.itemSchema)).toEqual({
      attribute: 'utm_source',
      operator: 'equals',
      value: '',
    });
  });
});

describe('toDecoderSchema', () => {
  const decoder = JSON.stringify(toDecoderSchema(jsonSchema));

  test('keeps structure, enums and required keys', () => {
    expect(decoder).toContain('"enum":["exit_intent","time_on_page","scroll_depth"]');
    expect(decoder).toContain('"required"');
    expect(decoder).toContain('"additionalProperties":false');
  });

  test('drops keywords left to Zod', () => {
    for (const keyword of [
      'pattern',
      'format',
      'minimum',
      'maximum',
      'maxItems',
      'minLength',
      '$schema',
    ]) {
      expect(decoder).not.toContain(`"${keyword}"`);
    }
  });
});

describe('campaignSchema', () => {
  test('accepts the default campaign', () => {
    expect(campaignSchema.safeParse(defaultCampaign).success).toBe(true);
  });

  test('enforces cross-field rules with precise paths', () => {
    const bad = setAt(
      setAt(defaultCampaign, ['targeting', 'devices'], ['mobile']),
      ['schedule', 'end'],
      '2026-09-01',
    );
    const result = campaignSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('trigger.type');
    expect(paths).toContain('schedule.end');
  });
});

describe('path helpers', () => {
  test('setAt copies containers along the path and leaves the original alone', () => {
    const next = setAt(defaultCampaign, ['offer', 'code'], 'NEW1');
    expect(getAt(next, ['offer', 'code'])).toBe('NEW1');
    expect(defaultCampaign.offer.code).toBe('WELCOME10');
    expect(next.schedule).toBe(defaultCampaign.schedule);
  });

  test('setAt works inside arrays', () => {
    const list = setAt({ rules: [{ v: 'a' }, { v: 'b' }] }, ['rules', 1, 'v'], 'z');
    expect(list).toEqual({ rules: [{ v: 'a' }, { v: 'z' }] });
  });
});
