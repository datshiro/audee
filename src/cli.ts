import { pathToFileURL } from 'node:url';

const USAGE = `usage: audee [-config path] <command>
  serve         run the Teams agent
  doctor        check the setup
  rerun <id>    redo a request (MR URL or Teams message id)
  pin-skill     pin the code-mapping skill to a git ref
  shadow-report compare shadow classifications with Ciel's`;

export async function main(argv: string[], out: (s: string) => void): Promise<number> {
  switch (argv[0]) {
    default:
      out(USAGE);
      return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), console.log);
}
