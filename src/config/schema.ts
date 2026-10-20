import { z } from 'zod';

export const PROFILES = ['review', 'mapping', 'kb_read', 'classifier', 'mcp_read'] as const;
export type ProfileName = (typeof PROFILES)[number];

const DURATION = /^(\d+)(s|m|h)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

export function parseDuration(text: string): number {
  const m = DURATION.exec(text);
  if (m === null) throw new Error(`invalid duration "${text}" (use <n>s, <n>m or <n>h)`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

const Duration = z.string().transform((text, ctx) => {
  try {
    return parseDuration(text);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

const Route = z.strictObject({ match: z.string(), prompt: z.string() });

const Capability = z.strictObject({
  enabled: z.boolean().default(true), // false: still recognised, so a request gets the "not enabled" reply
  profile: z.enum(PROFILES),
  lane: z.string(),
  model: z.string().default('claude-opus-5-5'),
  budget_usd: z.number().positive().optional(),
  timeout: Duration,
  workdir: z.string().optional(),
  prompt: z.string().optional(),
  post_findings: z.boolean().default(false),
  auto_approve: z.boolean().default(false), // review only: approve a clean MR as the owner through glab-mcp
  routes: z.array(Route).default([]),
  seatbelt: z.boolean().default(false),
  skill_source: z.string().optional(),
  skill_dir: z.string().optional(),
  kb_dir: z.string().optional(),
  per_person_limit: z.number().int().positive().optional(),
  trigger: z.string().optional(),
  mcp: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
});

// Ciel's per-capability defaults (config.go loadConfig), keyed by capability name.
const CAPABILITY_DEFAULTS: Record<string, Record<string, unknown>> = {
  review: { timeout: '45m', budget_usd: 8, prompt: '/apo-review-mr {url}', workdir: '~/.claude/kb' },
  code_mapping: {
    timeout: '30m', budget_usd: 5, skill_source: '~/.claude/kb/.claude/skills/kb-eventsource-ops',
    prompt: 'Read {skill}/SKILL.md and {skill}/references/author-eventsource.md and follow them.', // ciel config.go:128
  },
  kb_query: { timeout: '15m', budget_usd: 3, kb_dir: '~/.claude/kb' },
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const Capabilities = z.preprocess((raw) => {
  if (!isPlainObject(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [name, cap] of Object.entries(raw)) out[name] = isPlainObject(cap) ? { ...CAPABILITY_DEFAULTS[name], ...cap } : cap;
  return out;
}, z.record(z.string(), Capability));

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const CLOCK = /^\d{2}:\d{2}$/;

export const ConfigSchema = z.strictObject({
  data_dir: z.string().default('~/.audee'),
  auth: z.strictObject({
    owner: z.enum(['subscription', 'api_key']).default('subscription'),
    teammates: z.enum(['subscription', 'api_key']).default('api_key'),
    api_key_keychain_item: z.string().default('audee-anthropic'),
    // An Anthropic-compatible gateway (LiteLLM) for API-key sessions; subscription sessions always use the login.
    base_url: z.string().regex(/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/u, 'must be an https URL').optional(),
  }).prefault({}),
  concurrency: z.strictObject({
    max_concurrent: z.number().int().positive().default(3),
    lanes: z.record(z.string(), z.strictObject({ concurrency: z.number().int().positive(), buffer: z.number().int().positive().default(32) })),
  }),
  people: z.array(z.strictObject({
    name: z.string().min(1),
    owner: z.boolean().default(false),
    ids: z.array(z.string()).min(1),
    can: z.array(z.string()).default([]),
    gitlab: z.string().min(1).optional(),
    max_inflight: z.number().int().positive().default(2),
  })).min(1),
  channels: z.strictObject({
    teams: z.strictObject({
      onedrive_dir: z.string(),
      chats: z.array(z.string()),
      aliases: z.array(z.string()).default([]),
      mr_url_pattern: z.string().default('https://gitlab\\.gt\\.vng\\.vn/[^\\s"\'<>]+/-/merge_requests/\\d+'),
      history_size: z.number().int().positive().default(6),
      quiet_after: Duration.prefault('4h'),
      work_hours: z.strictObject({
        days: z.array(z.enum(WEEKDAYS)).default(['mon', 'tue', 'wed', 'thu', 'fri']),
        start: z.string().regex(CLOCK).default('09:00'),
        end: z.string().regex(CLOCK).default('18:00'),
      }).prefault({}),
      shadow: z.boolean().default(false),
    }),
  }),
  classifier: z.strictObject({
    model: z.string().default('claude-opus-5-5'),
    effort: z.enum(['low', 'medium', 'high']).default('low'),
    timeout: Duration.prefault('3m'),
    // api_key sends every classification to the API key (and auth.base_url, when set) instead of the owner's login.
    auth: z.enum(['subscription', 'api_key']).default('subscription'),
  }).prefault({}),
  capabilities: Capabilities,
  keychain_env: z.record(z.string(), z.string()).default({}),
  mcp_servers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}), // audee-only MCP servers, before ~/.claude.json
  // The dashboard, served by `audee serve` on 127.0.0.1 only.
  admin: z.strictObject({ port: z.number().int().min(1024).max(65535).default(7420) }).prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Capability = Config['capabilities'][string];
