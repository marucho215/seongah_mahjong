import { createInterface } from "node:readline";
import type { CliIO } from "./cliIO.js";

/** Real terminal I/O for the human-play CLI - stdin/stdout via node:readline.
 *
 * Deliberately consumes lines via the readline interface's async iterator, not repeated
 * `question()` calls (promise- or callback-wrapped): with stdin piped/redirected from a
 * file rather than a live TTY, readline emits "line" events for buffered input eagerly,
 * and a fresh `question()` call registered after an `await` (i.e. after a microtask turn)
 * can miss a line that already fired - reproduced in isolation, unrelated to this driver's
 * own logic. `for await` / the async iterator instead pulls lines one at a time correctly
 * regardless of that timing, and behaves identically for a real interactive terminal, where
 * a human can't type fast enough to ever hit the race in the first place. */
export function createNodeIO(): CliIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  return {
    print(line: string): void {
      console.log(line);
    },
    async ask(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      const { value, done } = await lines.next();
      return done ? "" : value;
    },
    close(): void {
      rl.close();
    },
  };
}
