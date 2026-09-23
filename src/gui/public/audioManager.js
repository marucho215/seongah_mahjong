"use strict";

/**
 * 기본 오디오 매니저. 효과음을 세 카테고리로 나눠 다룬다.
 *   sfx.*   - 패 충돌, 리치봉, 셔플 같은 물리음 (physical)
 *   ui.*    - 버튼 확인/취소, 결과창 같은 비언어 UI 소리
 *   voice.* - 사람이 말하는 선언 음성. 지금은 자리만 예약했고 아무것도 연결하지 않았다.
 *             (성인 남성 선언 음성은 공용 효과음 계층에 넣지 않는다. 나중에 캐릭터별 보이스를
 *              붙일 때 sfx/ui와 섞이지 않도록 카테고리와 볼륨을 처음부터 분리해 둔다.)
 *
 * 소리 파일이 없으면(예: 저장소에 없는 T-STUDIO 원본) 조용히 건너뛴다. 게임 동작에는 영향이 없다.
 */
const AudioManager = (() => {
  const AUDIO_ROOT = "/assets/audio";

  /** 재생 가능한 소리 목록. files는 여러 개면 번갈아 쓰는 변형이다. fadeOutMs는 긴 소리를 잘라 낼 때 쓴다. */
  const MANIFEST = {
    "sfx.discard": { files: [`${AUDIO_ROOT}/tstudio/mahjong_tile_1.mp3`], gain: 0.9 },
    "sfx.kita": { files: [`${AUDIO_ROOT}/tstudio/mahjong_tile_2.mp3`], gain: 0.7 },
    "sfx.pon": { files: [`${AUDIO_ROOT}/tstudio/mahjong_tile_3.mp3`], gain: 0.9 },
    "sfx.kan": { files: [`${AUDIO_ROOT}/tstudio/mahjong_tile_4.mp3`], gain: 1.0 },
    "sfx.riichiStick": { files: [`${AUDIO_ROOT}/tstudio/riich_bets_1.mp3`], gain: 0.9 },
    "sfx.riichiCollect": { files: [`${AUDIO_ROOT}/tstudio/take_the_riich_bets_2.mp3`], gain: 0.9 },
    // 6.9초로 길어서 앞부분만 낮은 볼륨으로 쓰고 서서히 줄인다.
    "sfx.shuffle": { files: [`${AUDIO_ROOT}/tstudio/shuffle_the_mahjong_tiles.mp3`], gain: 0.5, maxMs: 2600, fadeOutMs: 900 },
    "ui.confirm": { files: [`${AUDIO_ROOT}/ui/UI_023.wav`], gain: 0.8 },
    "ui.cancel": { files: [`${AUDIO_ROOT}/ui/UI_040.wav`], gain: 0.8 },
    "ui.result": { files: [`${AUDIO_ROOT}/ui/UI_029.wav`], gain: 0.8 },
    // voice.*: 예약만 (비어 있음)
  };

  const CATEGORIES = ["sfx", "ui", "voice"];
  const STORAGE_KEY = "seongah-audio-settings";
  const CUE_GAP_MS = 170; // AI 행동이 한꺼번에 도착해도 겹쳐서 뭉개지지 않게 하는 재생 간격

  const state = { master: 0.8, muted: false, categories: { sfx: 1, ui: 1, voice: 1 } };
  let ctx = null;
  const gains = {};
  const bufferCache = new Map();
  let lastSeq = 0;
  let queue = [];
  let pumping = false;

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved === "object") {
        if (typeof saved.master === "number") state.master = Math.min(1, Math.max(0, saved.master));
        if (typeof saved.muted === "boolean") state.muted = saved.muted;
        for (const c of CATEGORIES) {
          if (saved.categories && typeof saved.categories[c] === "number") state.categories[c] = Math.min(1, Math.max(0, saved.categories[c]));
        }
      }
    } catch (_) {
      /* 저장소를 못 읽어도 기본값으로 동작한다 */
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
      /* 저장 실패는 무시 */
    }
  }

  function applyVolumes() {
    if (!ctx) return;
    gains.master.gain.value = state.muted ? 0 : state.master;
    for (const c of CATEGORIES) gains[c].gain.value = state.categories[c];
  }

  /** 브라우저 정책상 오디오는 사용자 입력 뒤에야 켤 수 있으므로, 첫 클릭/키 입력에서 깨운다. */
  function ensureContext() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    gains.master = ctx.createGain();
    gains.master.connect(ctx.destination);
    for (const c of CATEGORIES) {
      gains[c] = ctx.createGain();
      gains[c].connect(gains.master);
    }
    applyVolumes();
    return ctx;
  }

  function unlock() {
    const c = ensureContext();
    if (c && c.state === "suspended") c.resume();
    if (c) preloadAll();
  }

  function loadBuffer(url) {
    if (bufferCache.has(url)) return bufferCache.get(url);
    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((data) => ctx.decodeAudioData(data))
      .catch((err) => {
        console.debug(`[audio] 소리 파일을 쓸 수 없어 건너뜁니다: ${url} (${err.message})`);
        return null;
      });
    bufferCache.set(url, promise);
    return promise;
  }

  function preloadAll() {
    for (const def of Object.values(MANIFEST)) for (const url of def.files) loadBuffer(url);
  }

  const variantIndex = {};

  /** key("sfx.discard" 등)의 소리를 재생한다. 켜지지 않았거나, 음소거이거나, 파일이 없으면 아무 일도 하지 않는다. */
  async function play(key) {
    const def = MANIFEST[key];
    if (!def || !ctx || ctx.state !== "running" || state.muted) return;
    const category = key.split(".")[0];
    if (!gains[category]) return;
    const i = (variantIndex[key] = ((variantIndex[key] ?? -1) + 1) % def.files.length);
    const buffer = await loadBuffer(def.files[i]);
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = def.gain ?? 1;
    src.connect(g);
    g.connect(gains[category]);
    const now = ctx.currentTime;
    if (def.maxMs) {
      const end = now + def.maxMs / 1000;
      const fade = (def.fadeOutMs ?? 300) / 1000;
      g.gain.setValueAtTime(def.gain ?? 1, end - fade);
      g.gain.linearRampToValueAtTime(0, end);
      src.start(now);
      src.stop(end + 0.02);
    } else {
      src.start(now);
    }
  }

  /**
   * 서버가 보낸 공개 효과음 신호(AudioCue) -> 재생할 소리 키.
   * 공용 소리를 배정하지 않은 신호(draw, chi, ron, tsumo)는 빈 목록이다. 선언 음성은 쓰지 않는다.
   */
  function keysForCue(cue) {
    switch (cue.type) {
      case "discard": return ["sfx.discard"];
      case "kita": return ["sfx.kita"];
      case "pon": return ["sfx.pon"];
      case "kan": return ["sfx.kan"];
      case "riichi": return ["sfx.riichiStick"];
      case "hand_start": return ["sfx.shuffle"];
      case "hand_end": return cue.riichiSticksCollected ? ["ui.result", "sfx.riichiCollect"] : ["ui.result"];
      default: return [];
    }
  }

  /** 접속 시점의 기준 seq. 이 이하의 신호는 과거이므로 재생하지 않는다. */
  function setBase(seq) {
    if (typeof seq === "number") lastSeq = Math.max(lastSeq, seq);
  }

  /** 받은 신호를 순서대로 재생 대기열에 넣는다 (이미 본 seq는 무시). */
  function enqueueCues(cues) {
    for (const cue of cues || []) {
      if (cue.seq <= lastSeq) continue;
      lastSeq = cue.seq;
      queue.push(...keysForCue(cue));
    }
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length > 0) {
      const key = queue.shift();
      play(key);
      await new Promise((r) => setTimeout(r, CUE_GAP_MS));
    }
    pumping = false;
  }

  function setMaster(v) {
    state.master = Math.min(1, Math.max(0, v));
    applyVolumes();
    saveSettings();
  }

  function setMuted(m) {
    state.muted = !!m;
    applyVolumes();
    saveSettings();
  }

  /** 카테고리별 볼륨 (지금 화면에는 마스터만 노출하지만, 캐릭터 보이스를 붙일 때를 위해 분리해 둔다). */
  function setCategoryVolume(category, v) {
    if (!CATEGORIES.includes(category)) return;
    state.categories[category] = Math.min(1, Math.max(0, v));
    applyVolumes();
    saveSettings();
  }

  /** 우측 상단의 작은 음소거 버튼 + 볼륨 슬라이더를 연결한다. */
  function mountControls() {
    const box = document.getElementById("audio-controls");
    if (!box) return;
    const mute = box.querySelector(".audio-mute");
    const vol = box.querySelector(".audio-volume");
    const refresh = () => {
      mute.textContent = state.muted ? "소리 끔" : "소리 켬";
      mute.classList.toggle("is-off", state.muted);
      vol.value = String(state.master);
    };
    mute.addEventListener("click", () => {
      setMuted(!state.muted);
      refresh();
    });
    vol.addEventListener("input", () => {
      setMaster(Number(vol.value));
      if (state.muted && Number(vol.value) > 0) setMuted(false);
      refresh();
    });
    refresh();
  }

  loadSettings();
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);

  return { play, enqueueCues, setBase, setMaster, setMuted, setCategoryVolume, mountControls, keysForCue, MANIFEST };
})();
