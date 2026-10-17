import { pathToFileURL } from 'node:url';
import { pinSkill } from './capability/pin-skill.js';
import { expandHome, loadConfig } from './config/load.js';

const USAGE = `usage: audee [-config path] <command>
  serve         run the Teams agent
  doctor        check the setup
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

export async function main(argv: string[], out: (s: string) => void): Promise<number> {
  const { configPath, command, rest } = parseArgs(argv);
  switch (command) {
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
