import type { CliIO } from "./cliIO.js";

/**
 * Test-facing IO: answers are produced by a policy function of the current prompt text
 * (not a fixed queue), so a scripted test can react to what the CLI actually asked - e.g.
 * answer differently the first time a given prompt is seen (to exercise re-prompting on
 * invalid input) vs later times. `transcript` captures every printed line and prompt, in
 * order, for assertions.
 */
export function createScriptedIO(answerFor: (prompt: string, askCount: number) => string): CliIO & { transcript: string[] } {
  const transcript: string[] = [];
  let askCount = 0;
  return {
    transcript,
    print(line: string): void {
      transcript.push(line);
    },
    async ask(prompt: string): Promise<string> {
      transcript.push(`? ${prompt}`);
      const answer = answerFor(prompt, askCount);
      askCount++;
      transcript.push(`> ${answer}`);
      return answer;
    },
  };
}
