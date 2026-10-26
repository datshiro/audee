#!/usr/bin/env node
// A stream-json stand-in for the CLI. Each user message plays the next entry of $FAKE_TURNS (a JSON array of turns);
// a turn lists messages to print, a {"delay": ms} entry waits and {"result": text, "denials"?: [...]} prints a success
// result.
// User messages are appended to $FAKE_STREAM_LOG, one text per line.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const turns = JSON.parse(process.env.FAKE_TURNS ?? '[]');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const result = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, session_id: 's', total_cost_usd: 0, permission_denials: [], duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, uuid: 'u' });
let next = 0;
let playing = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  if (m.type !== 'user') return;
  const c = m.message.content;
  appendFileSync(process.env.FAKE_STREAM_LOG, JSON.stringify(typeof c === 'string' ? c : c.map((b) => b.text).join('')) + '\n');
  const turn = turns[next++] ?? [{ result: 'no more turns' }];
  playing = playing.then(async () => {
    for (const step of turn) {
      if ('delay' in step) await sleep(step.delay);
      else if ('result' in step) send({ ...result(step.result), permission_denials: step.denials ?? [] });
      else send(step);
    }
  });
}).on('close', () => { playing.then(() => process.exit(0)); });
