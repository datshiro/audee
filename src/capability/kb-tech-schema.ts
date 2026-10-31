// The tech-mode kb_query answer: sections of blocks, each citing what it states, so audee can check every block and
// copy code from the file itself. audee-owned (kb-answer-v1 is the product contract and stays pinned).
export const MAX_TECH_SECTIONS = 12;
export const MAX_TECH_BLOCKS = 20;
export const MAX_TECH_TEXT_CHARS = 1500;
export const MAX_TECH_CODE_LINES = 15;

const stringList = { type: 'array', items: { type: 'string' } };

export const KB_TECH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'failed'] },
    topic: { type: 'string', description: 'What the question asks, at most 12 words, in the language of the question.' },
    lang: { type: 'string', enum: ['vi', 'en'] },
    title: { type: 'string', description: 'Headline of the answer, at most 120 characters.' },
    sections: {
      type: 'array',
      description: `At most ${MAX_TECH_SECTIONS}.`,
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'At most 120 characters.' },
          blocks: {
            type: 'array',
            description: `At most ${MAX_TECH_BLOCKS}.`,
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['text', 'code'] },
                text: { type: 'string', description: `text: Markdown inline formatting and "- " list lines, no headings, no HTML, no links, at most ${MAX_TECH_TEXT_CHARS} characters. code: "".` },
                cites: { ...stringList, description: `text: every source range (<service>/<path>:<from>-<to>) or wiki doc path it states. code: exactly one source range of at most ${MAX_TECH_CODE_LINES} lines.` },
              },
              required: ['kind', 'text', 'cites'],
              additionalProperties: false,
            },
          },
        },
        required: ['heading', 'blocks'],
        additionalProperties: false,
      },
    },
    notes: { ...stringList, description: 'At most 5, each under 250 characters.' },
    missing: stringList,
  },
  required: ['status', 'topic', 'lang', 'title', 'sections', 'notes', 'missing'],
  additionalProperties: false,
};
