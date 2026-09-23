/** Minimal input/output seam so the same interactive driver can run against a real
 *  terminal or against scripted input in a test - see nodeIO.ts and scriptedIO.ts. */
export interface CliIO {
  print(line: string): void;
  ask(prompt: string): Promise<string>;
  close?(): void;
}
