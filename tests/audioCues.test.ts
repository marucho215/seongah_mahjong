import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { GameEvent } from "../src/core/GameLog.js";
import { AudioCueTracker, toAudioCue } from "../src/gui/audioCues.js";
import { PUBLIC_DIR } from "../src/gui/createGuiServer.js";

describe("toAudioCue: game.log 이벤트를 공개 신호로 변환", () => {
  it("패 종류 같은 숨은 정보를 담지 않는다 (상대가 뽑은 패 포함)", () => {
    const draw = toAudioCue({ type: "draw", player: 2, tile: "z7", source: "wall" });
    expect(draw).toEqual({ type: "draw", seat: 2 });
    const discard = toAudioCue({ type: "discard", player: 1, tile: "m1", tsumogiri: true, riichiDeclaration: false });
    expect(discard).toEqual({ type: "discard", seat: 1 });
    const kita = toAudioCue({ type: "kita", player: 0, tile: "z4" });
    expect(kita).toEqual({ type: "kita", seat: 0 });
  });

  it("후로 종류를 chi / pon / kan으로 묶는다", () => {
    const call = (c: "chi" | "pon" | "kan_open" | "kan_closed" | "kan_added") => toAudioCue({ type: "call", call: c, player: 1, kind: "p1" });
    expect(call("chi")).toEqual({ type: "chi", seat: 1 });
    expect(call("pon")).toEqual({ type: "pon", seat: 1 });
    for (const k of ["kan_open", "kan_closed", "kan_added"] as const) expect(call(k)).toEqual({ type: "kan", seat: 1 });
  });

  it("리치 / 론 / 쯔모 / 국 시작을 구분한다", () => {
    expect(toAudioCue({ type: "riichi", player: 2 })).toEqual({ type: "riichi", seat: 2 });
    const win = (isTsumo: boolean): GameEvent => ({ type: "win", player: 1, isTsumo, yaku: [], han: 1, fu: 30, yakumanUnits: 0, points: 1000, deltas: {} });
    expect(toAudioCue(win(true))).toEqual({ type: "tsumo", seat: 1 });
    expect(toAudioCue(win(false))).toEqual({ type: "ron", seat: 1 });
    const start = (handIndex: number): GameEvent => ({ type: "hand_start", handIndex, roundWind: 1, roundHandNumber: 1, dealer: 0, honba: 0, kyotaku: 0, scores: [1, 2, 3], wallSeed: 42 });
    expect(toAudioCue(start(0))).toEqual({ type: "hand_start", first: true });
    expect(toAudioCue(start(3))).toEqual({ type: "hand_start", first: false });
  });

  it("국 종료 신호는 공탁 회수 여부만 알려준다", () => {
    const base = { type: "hand_end" as const, scores: [1, 2, 3], nextDealer: 0, honba: 0, kyotaku: 0 };
    expect(toAudioCue(base)).toEqual({ type: "hand_end", riichiSticksCollected: false });
    const transition = { roundWind: 1, roundHandNumber: 1, dealerSeat: 0, dealerContinues: false, nextDealer: 1, nextRoundWind: 1, nextRoundHandNumber: 2, honbaBefore: 0, honbaAfter: 0, kyotakuBefore: 1, kyotakuAfter: 0, scoresBeforeSettlement: [1, 2, 3], scoresAfterSettlement: [1, 2, 3], pointDeltas: {} };
    const agari = (kyotakuAwarded: number): GameEvent => ({ ...base, result: { kind: "agari", winners: [], kyotakuRecipient: 1, kyotakuAwarded, ...transition } });
    expect(toAudioCue(agari(1))).toEqual({ type: "hand_end", riichiSticksCollected: true });
    expect(toAudioCue(agari(0))).toEqual({ type: "hand_end", riichiSticksCollected: false });
  });

  it("소리와 무관한 이벤트는 신호가 없다", () => {
    expect(toAudioCue({ type: "deal", hands: [["m1"]], doraIndicator: "m1" })).toBeNull();
    expect(toAudioCue({ type: "abortive_draw", reason: "nine_terminals" })).toBeNull();
    expect(toAudioCue({ type: "game_end", finalScores: [1, 2, 3], reason: "length", eliminatedPlayers: [] })).toBeNull();
  });
});

describe("AudioCueTracker: 순서·seq·재접속", () => {
  it("로그를 한 번씩만 읽고 seq를 순서대로 붙이며, 이후 신호만 돌려준다", () => {
    const log: GameEvent[] = [{ type: "riichi", player: 0 }];
    const tracker = new AudioCueTracker(log);
    tracker.sync();
    tracker.sync(); // 두 번 불러도 중복되지 않는다
    expect(tracker.cuesAfter(0)).toEqual([{ type: "riichi", seat: 0, seq: 1 }]);

    log.push({ type: "discard", player: 1, tile: "m1", tsumogiri: false, riichiDeclaration: false });
    log.push({ type: "deal", hands: [], doraIndicator: "m1" }); // 신호 없는 이벤트는 seq를 쓰지 않는다
    log.push({ type: "kita", player: 2, tile: "z4" });
    tracker.sync();
    expect(tracker.latestSeq()).toBe(3);
    expect(tracker.cuesAfter(1).map((c) => [c.seq, c.type])).toEqual([[2, "discard"], [3, "kita"]]);

    tracker.discardThrough(2);
    expect(tracker.cuesAfter(0).map((c) => c.seq)).toEqual([3]);
  });

  it("실제 게임 로그에서 신호 순서가 이벤트 순서와 같고, 숨은 정보 필드가 없다", () => {
    const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "audio-cues-real" });
    gs.playGame();
    const tracker = new AudioCueTracker(gs.log);
    tracker.sync();
    const cues = tracker.cuesAfter(0);

    expect(cues.map((c) => c.seq)).toEqual(cues.map((_, i) => i + 1));
    const expected = gs.log.map(toAudioCue).filter((c) => c !== null).map((c) => c!.type);
    expect(cues.map((c) => c.type)).toEqual(expected);
    expect(cues.filter((c) => c.type === "discard").length).toBe(gs.log.filter((e) => e.type === "discard").length);

    const forbidden = ["tile", "kind", "id", "hands", "wallSeed", "yaku", "points", "deltas", "scores", "decision"];
    for (const cue of cues) {
      for (const key of forbidden) expect(cue, `${cue.type} 신호에 ${key} 필드가 있으면 안 됩니다`).not.toHaveProperty(key);
    }
  });
});

describe("효과음 자산 규칙", () => {
  const manager = readFileSync(join(PUBLIC_DIR, "audioManager.js"), "utf8");
  // audioManager.js는 경로를 `${AUDIO_ROOT}/ui/UI_023.wav` 꼴의 템플릿으로 적는다.
  const referenced = [...manager.matchAll(/\$\{AUDIO_ROOT\}\/(ui|tstudio)\/([A-Za-z0-9_]+\.(?:wav|mp3|ogg))/g)].map((m) => ({ pack: m[1]!, file: m[2]! }));

  it("연결된 Owlish(ui) 파일은 저장소에 실제로 있다", () => {
    const ui = referenced.filter((r) => r.pack === "ui");
    expect(ui.length).toBeGreaterThan(0);
    for (const { file } of ui) expect(existsSync(join(PUBLIC_DIR, "assets/audio/ui", file)), file).toBe(true);
  });

  it("연결된 T-STUDIO 파일은 README에 필요한 파일로 기록되어 있고, 원본은 gitignore 대상이다", () => {
    const readme = readFileSync(join(PUBLIC_DIR, "assets/audio/tstudio/README.md"), "utf8");
    const tstudio = referenced.filter((r) => r.pack === "tstudio");
    expect(tstudio.length).toBeGreaterThan(0);
    for (const { file } of tstudio) expect(readme, file).toContain(file);

    const gitignore = readFileSync(join(PUBLIC_DIR, "../../../.gitignore"), "utf8");
    expect(gitignore).toContain("src/gui/public/assets/audio/tstudio/*.mp3");
    expect(gitignore).toContain("src/gui/public/assets/audio/tstudio/*.ogg");
  });

  it("선언 음성(voice)은 재생 목록에 연결되어 있지 않다", () => {
    expect(manager).not.toMatch(/"voice\.[a-zA-Z]+"\s*:/);
    // T-STUDIO 선언 음성 파일명이 어디에도 참조되지 않는다
    for (const voiceFile of ["ron", "draw", "pung", "kong", "chow", "riichi", "double_riichi", "7_pairs", "all_runs", "all_simples", "full_straight", "value_tiles"]) {
      expect(manager, voiceFile).not.toContain(`/tstudio/${voiceFile}.`);
    }
  });

  it("공용 소리를 배정하지 않은 신호(draw, chi, ron, tsumo)는 재생하지 않는다", () => {
    // 브라우저 전용 코드라 window/localStorage만 가짜로 넣어 Node에서 실행한다.
    const load = new Function("window", "localStorage", `${manager}; return AudioManager.keysForCue;`);
    const keysForCue = load({ addEventListener() {} }, { getItem: () => null, setItem() {} }) as (cue: unknown) => string[];
    for (const type of ["draw", "chi", "ron", "tsumo"]) expect(keysForCue({ type, seat: 0 }), type).toEqual([]);
    expect(keysForCue({ type: "discard", seat: 0 })).toEqual(["sfx.discard"]);
    expect(keysForCue({ type: "hand_end", riichiSticksCollected: true })).toEqual(["ui.result", "sfx.riichiCollect"]);
  });
});
