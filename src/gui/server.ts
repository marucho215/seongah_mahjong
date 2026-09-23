/* Milestone 1 GUI entry point: `npm run play:gui [seed]`. All actual serving logic lives in
 * createGuiServer.ts (importable/testable without spawning a process) - this file only
 * builds the one-hand GameState, starts listening, and prints the URL. Same scope as the
 * CLI: seat 0 is human, ron stays auto-declared, one hand per process (restart to replay). */
import { GameState } from "../core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../rules/RuleConfig.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";
import { createGuiServer } from "./createGuiServer.js";

const PORT = Number(process.env.PORT) || 3000;
const seed = process.argv[2] ?? `gui-${Date.now()}`;

const game = new GameState({
  rules: DEFAULT_SANMA_RULES,
  seed,
  characterProfiles: [null, getCharacterProfile("jegalmina"), getCharacterProfile("jegalnahui")],
  controllers: ["human", undefined, undefined],
});

const { server } = createGuiServer(game);
server.listen(PORT, () => {
  console.log(`Seed: ${seed}`);
  console.log(`Seongah Majak GUI: http://localhost:${PORT}`);
});
