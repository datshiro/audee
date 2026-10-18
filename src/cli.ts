import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinSkill } from './capability/pin-skill.js';
import { expandHome, loadConfig } from './config/load.js';
import { formatChecks, ownerAuthProbe, runDoctor } from './doctor.js';
import { rerun } from './rerun.js';
import { serve } from './serve.js';
import { shadowReport } from './shadow-report.js';
import { shortId } from './teams/detect.js';

const USAGE = `usage: audee [-config path] <command>
  serve         run the Teams agent
  doctor [--probe]  check the setup (--probe runs one owner session in the daemon environment)
  rerun <id>    redo a request (MR URL or Teams message id)
  pin-skill     pin the code-mapping skill to a git ref
  shadow-report compare shadow classifications with Ciel's`;

const DEFAULT_CONFIG = '~/.audee/config.yaml';

function parseArgs(argv: string[]): { configPath: string; command: string | undefined; rest: string[] } {
  let configPath = DEFAULT_CONFIG;
  let i = 0;
  if (argv[0] === '-config' && argv[1] !== undefined) {
    configPath = argv[1];
    i = 2;
  }
  return { configPath, command: argv[i], rest: argv.slice(i + 1) };
}

function dataDirOf(configPath: string): string {
  try {
    return expandHome(loadConfig(configPath).data_dir);
  } catch {
    return expandHome('~/.audee'); // no config yet: the report still runs on the default folders
  }
}

export async function main(argv: string[], out: (s: string) => void, signal?: AbortSignal): Promise<number> {
  const { configPath, command, rest } = parseArgs(argv);
  switch (command) {
    case 'serve': {
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      signal?.addEventListener('abort', stop, { once: true });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        await serve(configPath, controller.signal, { out });
        return 0;
      } catch (e) {
        out(`serve: ${(e as Error).message}`);
        return 1;
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }
    case 'doctor': {
      try {
        const cfg = loadConfig(configPath);
        const checks = await runDoctor(cfg, rest[0] === '--probe' ? { authProbe: () => ownerAuthProbe(cfg) } : {});
        for (const line of formatChecks(checks)) out(line);
        return checks.every((c) => c.ok) ? 0 : 1;
      } catch (e) {
        out(`doctor: ${(e as Error).message}`);
        return 1;
      }
    }
    case 'rerun': {
      const target = rest[0];
      if (target === undefined) {
        out('usage: audee rerun <mr-url | message-id>');
        return 2;
      }
      try {
        const job = rerun(loadConfig(configPath), target);
        out(`queued: ${target}`);
        out(`reply to ${shortId(job.principal.replace(/^teams:/u, ''))} in chat ${shortId(job.chatId.replace(/^19:/u, ''))}`);
        return 0;
      } catch (e) {
        out(`rerun: ${(e as Error).message}`);
        return 1;
      }
    }
    case 'shadow-report': {
      const since = rest[0] === '--since' ? rest[1] : undefined;
      const report = shadowReport(expandHome('~/.ciel/events.jsonl'), join(dataDirOf(configPath), 'events.jsonl'), since);
      for (const line of report.lines) out(line);
      return 0;
    }
    case 'pin-skill': {
      try {
        const cfg = loadConfig(configPath);
        const cap = cfg.capabilities['code_mapping'];
        if (cap?.skill_source === undefined || cap.skill_dir === undefined) throw new Error('capabilities.code_mapping needs skill_source and skill_dir');
        const pinned = pinSkill({ skillSource: expandHome(cap.skill_source), skillDir: expandHome(cap.skill_dir) }, rest[0] ?? '');
        out(`pinned ${pinned.ref} at ${pinned.version}: ${pinned.dest}`);
        return 0;
      } catch (e) {
        out(`pin-skill: ${(e as Error).message}`);
        return 1;
      }
    }
    default:
      out(USAGE);
      return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), console.log);
}
