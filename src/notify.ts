// Port of notify in ciel/actions.go:126: a macOS notification; replaceable in tests.
import { execFile } from 'node:child_process';

export let notify: (title: string, text: string) => void = (title, text) => {
  const script = `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`;
  execFile('osascript', ['-e', script], (err) => {
    if (err !== null) console.error(`notification failed: ${err.message}`);
  });
};

export function setNotify(fn: typeof notify): void {
  notify = fn;
}
