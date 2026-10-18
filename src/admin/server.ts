// The dashboard's HTTP side: the admin API and the built web UI, on 127.0.0.1 only. Every API call carries the
// bearer token kept in <data_dir>/admin-token; the Host header must name this server, so a rebinding DNS name
// cannot reach it from a browser tab. Nothing here ever returns keychain values.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Config } from '../config/schema.js';
import { PROFILES } from '../config/schema.js';
import { runDoctor } from '../doctor.js';
import { READ_ONLY_MCP_TOOLS } from '../fence/constants.js';
import type { State } from '../state/state.js';
import type { Watcher } from '../teams/watcher.js';
import type { ConfigApplyResult, ConfigView, ReloadResult } from './api-types.js';
import { applyOps, checkCandidate, ConfigProblems, type Doctor, listBackups, readConfigText, writeConfig } from './config-edit.js';
import { eventsPage, messagesPage, overview, readEvents, requestsPage } from './views.js';

export type Live = { cfg: Config; state: State; watcher: Watcher; reloadedAt: Date; reloadError?: string };

export type AdminDeps = {
  configPath: string;
  dataDir: string;
  startedAt: Date;
  live: () => Live | undefined; // undefined while the watcher restarts
  reload: () => Promise<ReloadResult>; // checks the config on disk like a save, and keeps the running one if it fails
  doctor?: Doctor;
  webDir?: string;
  now?: () => Date;
};

export const adminTokenPath = (dataDir: string): string => join(dataDir, 'admin-token');

export function adminToken(dataDir: string): string {
  const path = adminTokenPath(dataDir);
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length >= 32) return token;
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  return token;
}

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const BUILTIN = ['review', 'code_mapping', 'kb_query'];
const MAX_BODY = 1 << 20;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly problems?: string[]) {
    super(message);
  }
}

export class AdminServer {
  private server: Server | undefined;
  private port = 0;
  private readonly token: string;
  private readonly webDir: string;
  private readonly doctor: Doctor;
  private readonly now: () => Date;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AdminDeps) {
    this.token = adminToken(deps.dataDir);
    this.webDir = resolve(deps.webDir ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)));
    this.doctor = deps.doctor ?? ((cfg) => runDoctor(cfg));
    this.now = deps.now ?? (() => new Date());
  }

  // Resolves with the bound port (port 0 picks a free one, for tests).
  listen(port: number): Promise<number> {
    return new Promise((ok, fail) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once('error', fail);
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        this.port = typeof addr === 'object' && addr !== null ? addr.port : port;
        this.server = server;
        ok(this.port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((ok) => {
      if (this.server === undefined) return ok();
      this.server.closeAllConnections();
      this.server.close(() => ok());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) throw new HttpError(421, 'unexpected Host header');
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        this.authorize(req);
        const body = await this.route(req.method ?? 'GET', url, req);
        this.send(res, 200, body);
      } else {
        this.serveStatic(url.pathname, res);
      }
    } catch (e) {
      if (e instanceof HttpError) this.send(res, e.status, { error: e.message, ...(e.problems !== undefined ? { problems: e.problems } : {}) });
      else if (e instanceof ConfigProblems) this.send(res, 400, { error: e.message, problems: e.problems });
      else this.send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private authorize(req: IncomingMessage): void {
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7).trim() : '');
    const want = Buffer.from(this.token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, 'missing or wrong token: run `audee dashboard` for a sign-in link');
  }

  private live(): Live {
    const live = this.deps.live();
    if (live === undefined) throw new HttpError(503, 'audee is reloading; try again in a moment');
    return live;
  }

  private async route(method: string, url: URL, req: IncomingMessage): Promise<unknown> {
    const route = `${method} ${url.pathname}`;
    const p = url.searchParams;
    switch (route) {
      case 'GET /api/overview': {
        const live = this.live();
        return overview({
          cfg: live.cfg, state: live.state, lanes: live.watcher.queue.snapshot(), events: readEvents(this.deps.dataDir, live.cfg),
          configPath: this.deps.configPath, dataDir: this.deps.dataDir, startedAt: this.deps.startedAt, reloadedAt: live.reloadedAt,
          ...(live.reloadError !== undefined ? { reloadError: live.reloadError } : {}), now: this.now(),
        });
      }
      case 'GET /api/events': {
        const live = this.live();
        return eventsPage(readEvents(this.deps.dataDir, live.cfg), p);
      }
      case 'GET /api/messages': {
        const live = this.live();
        return messagesPage(live.cfg, live.state, p);
      }
      case 'GET /api/requests': {
        const live = this.live();
        return requestsPage(live.cfg, live.state, p);
      }
      case 'POST /api/jobs/cancel': {
        const { kind, key } = jobRef(await readJson(req));
        return { result: this.live().watcher.cancel(kind, key) };
      }
      case 'POST /api/jobs/retry': {
        const { kind, key } = jobRef(await readJson(req));
        try {
          return { result: this.live().watcher.retry(kind, key) };
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(409, (e as Error).message);
        }
      }
      case 'POST /api/queue/pause': {
        const body = await readJson(req);
        if (typeof body['paused'] !== 'boolean') throw new HttpError(400, 'paused must be true or false');
        const queue = this.live().watcher.queue;
        queue.setPaused(body['paused']);
        return { paused: queue.paused };
      }
      case 'GET /api/doctor':
        return { checks: await this.doctor(this.live().cfg) };
      case 'GET /api/config':
        return this.configView();
      case 'POST /api/config/validate': {
        const text = applyOps(readConfigText(this.deps.configPath), (await readJson(req))['ops']);
        const live = this.live();
        const { checks } = await checkCandidate(text, live.cfg, live.state.pendingJobs(), this.doctor);
        return { ok: true, reloaded: false, checks } satisfies ConfigApplyResult;
      }
      case 'PATCH /api/config': {
        const ops = (await readJson(req))['ops'];
        return this.exclusive(async () => {
          const text = applyOps(readConfigText(this.deps.configPath), ops);
          const live = this.live();
          const { checks } = await checkCandidate(text, live.cfg, live.state.pendingJobs(), this.doctor);
          const backup = writeConfig(this.deps.configPath, text, this.now());
          const reload = await this.deps.reload();
          if (!reload.ok) throw new HttpError(500, `saved (backup ${backup}) but the reload failed: ${reload.error ?? 'unknown error'}`);
          return { ok: true, reloaded: true, checks, backup } satisfies ConfigApplyResult;
        });
      }
      case 'POST /api/reload':
        return this.exclusive(() => this.deps.reload());
      default:
        throw new HttpError(404, `no route ${route}`);
    }
  }

  // Config writes and reloads run one at a time, so two saves never interleave their read-modify-write.
  private exclusive<T>(f: () => Promise<T>): Promise<T> {
    const run = this.writing.then(f, f);
    this.writing = run.catch(() => undefined);
    return run;
  }

  private configView(): ConfigView {
    const live = this.live();
    const text = readConfigText(this.deps.configPath);
    const raw = (parse(text) ?? {}) as Record<string, unknown>;
    const inUse = Object.values(live.cfg.capabilities).map((c) => c.model);
    return {
      path: this.deps.configPath, text, raw, effective: live.cfg as unknown as Record<string, unknown>, backups: listBackups(this.deps.configPath),
      meta: {
        profiles: [...PROFILES], readOnlyMcpTools: READ_ONLY_MCP_TOOLS, models: [...new Set([...MODELS, ...inUse, live.cfg.classifier.model])],
        efforts: ['low', 'medium', 'high'], weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], builtinCapabilities: BUILTIN,
      },
    };
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    const index = join(this.webDir, 'index.html');
    if (!existsSync(index)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('The dashboard is not built: run `pnpm build:web` in the audee checkout.\n');
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'malformed path');
    }
    let file = resolve(this.webDir, '.' + decoded);
    if (file !== this.webDir && !file.startsWith(this.webDir + sep)) throw new HttpError(404, 'not found');
    if (!existsSync(file) || !statSync(file).isFile()) file = index; // client-side routes
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, ...SECURITY_HEADERS });
    res.end(readFileSync(file));
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'send application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object');
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'body must be a JSON object');
  }
}

function jobRef(body: Record<string, unknown>): { kind: string; key: string } {
  const { kind, key } = body;
  if (typeof kind !== 'string' || kind === '' || typeof key !== 'string' || key === '') throw new HttpError(400, 'kind and key are required');
  return { kind, key };
}
