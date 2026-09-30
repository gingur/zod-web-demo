import { z } from 'zod';

/**
 * A generic marketing popup campaign. Names and fields are illustrative and
 * not taken from any production system.
 *
 * This file is the single definition. The form, the JSON Schema that
 * constrains the model's decoding, and the validation that runs on every
 * human or model edit are all derived from it.
 */

const device = z.enum(['desktop', 'mobile', 'tablet']);

const audienceRule = z
  .object({
    attribute: z
      .enum(['utm_source', 'referrer', 'cart_value', 'pages_viewed'])
      .meta({ title: 'Attribute' }),
    operator: z
      .enum(['equals', 'contains', 'greater_than', 'less_than'])
      .meta({ title: 'Operator' }),
    value: z.string().min(1, 'Enter a value').meta({ title: 'Value' }),
  })
  .strict();

export const campaignSchema = z
  .object({
    name: z.string().min(1, 'Name is required').max(60).meta({ title: 'Campaign name' }),
    status: z.enum(['draft', 'scheduled', 'live', 'paused']).meta({ title: 'Status' }),
    schedule: z
      .object({
        start: z.iso.date().meta({ title: 'Start date' }),
        end: z.iso.date().meta({ title: 'End date' }),
      })
      .strict()
      .meta({ title: 'Schedule' }),
    trigger: z
      .object({
        type: z.enum(['exit_intent', 'time_on_page', 'scroll_depth']).meta({ title: 'Trigger' }),
        delaySeconds: z.number().int().min(0).max(120).meta({
          title: 'Delay (seconds)',
          description: 'Used by the time_on_page trigger.',
        }),
        scrollPercent: z.number().int().min(0).max(100).meta({
          title: 'Scroll depth (%)',
          description: 'Used by the scroll_depth trigger.',
        }),
      })
      .strict()
      .meta({ title: 'Trigger' }),
    targeting: z
      .object({
        devices: z.array(device).min(1, 'Pick at least one device').meta({ title: 'Devices' }),
        excludedPaths: z.array(z.string().startsWith('/', 'Paths must start with /')).meta({
          title: 'Excluded paths',
          description: 'Pages where the popup never shows.',
          placeholder: '/checkout',
        }),
        newVisitorsOnly: z.boolean().meta({ title: 'New visitors only' }),
      })
      .strict()
      .meta({ title: 'Targeting' }),
    audienceRules: z.array(audienceRule).max(5, 'At most 5 audience rules').meta({
      title: 'Audience rules',
      description: 'All rules must match for a visitor to qualify.',
    }),
    offer: z
      .object({
        headline: z.string().min(1, 'Headline is required').max(60).meta({ title: 'Headline' }),
        discountPercent: z.number().int().min(0).max(50).meta({ title: 'Discount (%)' }),
        code: z
          .string()
          .regex(/^[A-Z0-9]{4,12}$/, 'Use 4 to 12 uppercase letters or digits')
          .meta({ title: 'Discount code' }),
      })
      .strict()
      .meta({ title: 'Offer' }),
    frequency: z
      .enum(['once_per_session', 'once_per_day', 'every_visit'])
      .meta({ title: 'Frequency' }),
  })
  .strict()
  .superRefine((c, ctx) => {
    // Cross-field rules. JSON Schema can't express these, so constrained
    // decoding can't enforce them; Zod catches them after generation.
    if (c.schedule.end < c.schedule.start) {
      ctx.addIssue({
        code: 'custom',
        path: ['schedule', 'end'],
        message: 'End date must be on or after the start date',
      });
    }
    if (c.trigger.type === 'exit_intent' && !c.targeting.devices.includes('desktop')) {
      ctx.addIssue({
        code: 'custom',
        path: ['trigger', 'type'],
        message:
          'Exit intent needs a desktop cursor: add desktop to targeting.devices, or use time_on_page or scroll_depth',
      });
    }
    if (c.trigger.type === 'scroll_depth' && c.trigger.scrollPercent < 10) {
      ctx.addIssue({
        code: 'custom',
        path: ['trigger', 'scrollPercent'],
        message: 'Scroll depth must be at least 10%',
      });
    }
    c.audienceRules.forEach((rule, i) => {
      const numeric = rule.operator === 'greater_than' || rule.operator === 'less_than';
      if (numeric && !Number.isFinite(Number(rule.value))) {
        ctx.addIssue({
          code: 'custom',
          path: ['audienceRules', i, 'value'],
          message: `${rule.operator} needs a number`,
        });
      }
    });
  })
  .meta({ title: 'Popup campaign' });

export type Campaign = z.infer<typeof campaignSchema>;

/** Plain-language versions of the cross-field rules, for the model's prompt. */
export const CROSS_FIELD_RULES: readonly string[] = [
  'schedule.end must be on or after schedule.start.',
  'trigger.type exit_intent requires desktop in targeting.devices.',
  'trigger.type scroll_depth requires trigger.scrollPercent of at least 10.',
  'audienceRules using greater_than or less_than need a numeric value.',
];

export const defaultCampaign: Campaign = campaignSchema.parse({
  name: 'Fall welcome offer',
  status: 'draft',
  schedule: { start: '2026-10-01', end: '2026-10-31' },
  trigger: { type: 'exit_intent', delaySeconds: 5, scrollPercent: 50 },
  targeting: { devices: ['desktop', 'mobile'], excludedPaths: [], newVisitorsOnly: true },
  audienceRules: [],
  offer: { headline: 'Get 10% off your first order', discountPercent: 10, code: 'WELCOME10' },
  frequency: 'once_per_session',
});
