"use strict";

// 리플레이 모드: 대국 화면(index.html + app.js)과 같은 작탁에서 리플레이를 본다. 주소 `/?replay=<파일>[&autoplay=1]`.
// 서버가 현재 엔진으로 재현한 결과(/api/replays/<파일>)의 수마다 표시용 상태(모든 좌석 손패/멘츠/강/북, 도라, 점수)를
// 대국 화면이 그리는 view 모양으로 바꿔 app.js의 renderTable/renderMySeat/renderHandEndPanel로 그린다. 재현이 원본과
// 한 곳이라도 다르면 서버가 ok:false를 주고, 이 화면은 이유만 보여준다 (상태를 추측해 그리지 않는다).
// - 손패: 기본은 전원 공개. "아래 자리만"으로 바꾸면 그 좌석 시점(다른 좌석은 뒷면)이 된다. 아래 자리는 고를 수 있다.
// - AI 판단 기록: 오른쪽 접는 패널. 그 수 직전에 엔진이 기록한 판단만 보여준다.
// 서버 이벤트(대국/로비)에는 연결하지 않는다 (app.js의 IS_REPLAY_MODE).

const REPLAY_CALL_KO = { chi: "치", pon: "퐁", kan_open: "대명깡", kan_closed: "암깡", kan_added: "가깡" };
/** 타패 한 수의 기본 유지 시간(ms). 대국 화면의 AI 장면 속도(playbackSpeed.ts PLAYBACK_FRAME_DELAY_MS)와 같은 값이다. */
const REPLAY_SPEEDS = { slow: 1300, normal: 800, fast: 350 };
const REPLAY_SPEED_KO = { slow: "느림", normal: "보통", fast: "빠름" };
/** 자동 재생에서 그 수에 머무는 시간 (기본 유지 시간의 배수). 대국 화면의 장면 배수(createGuiServer holdMultiplier: 울기·북 x1.5,
 *  리치 x2.2, 쯔모 화료 x2.5, 론 x3)와 같고, 리플레이는 쯔모와 타패가 따로 한 칸씩이라 쯔모 칸은 짧게 지나가 다음 타패에서 머문다. */
function rvHoldOf(e) {
  switch (e.type) {
    case "draw":
    case "dora_indicator_revealed":
    case "deal":
      return 0.3;
    case "call":
    case "kita":
      return 1.5;
    case "riichi":
      return 2.2;
    case "win":
      return e.isTsumo ? 2.5 : 3;
    case "exhaustive_draw":
    case "abortive_draw":
      return 2.5;
    case "hand_end":
      return 5; // 국 결과 창을 읽는 시간
    default:
      return 1;
  }
}
const REPLAY_PREF_KEY = "seongah.replayView";

const rv = {
  data: null, // 서버 응답 { meta, seatNames, reproduction }
  pos: 0,
  playTimer: null,
  anchor: 0, // 아래 자리
  openHands: true,
  aiOpen: false,
  speed: "normal",
  feed: [],
};

function rvLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(REPLAY_PREF_KEY) || "null");
    if (saved && typeof saved === "object") {
      if (typeof saved.openHands === "boolean") rv.openHands = saved.openHands;
      if (typeof saved.aiOpen === "boolean") rv.aiOpen = saved.aiOpen;
      if (saved.speed in REPLAY_SPEEDS) rv.speed = saved.speed;
    }
  } catch (_) {
    /* 저장소를 못 읽어도 기본값으로 동작한다 */
  }
}

function rvSavePrefs() {
  try {
    localStorage.setItem(REPLAY_PREF_KEY, JSON.stringify({ openHands: rv.openHands, aiOpen: rv.aiOpen, speed: rv.speed }));
  } catch (_) {
    /* 저장 실패는 무시 */
  }
}

const rv$ = (id) => document.getElementById(id);

function rvSeatName(seat) {
  return rv.data.seatNames[seat] ?? `Seat ${seat}`;
}

function rvSetStatus(text) {
  rv$("rv-status").textContent = text;
}

// --- 조작 막대 / AI 패널 (화면 맨 위 한 줄, 작탁은 그 아래 남은 공간에 그대로 그린다) ---

function rvButton(label, title, onClick, className = "") {
  const b = el("button", "rv-btn" + (className ? " " + className : ""), { type: "button", title });
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function rvBuildChrome() {
  document.body.classList.add("is-replay");
  const bar = el("header", "rv-bar");
  bar.id = "rv-bar";

  const back = el("a", "rv-back", { href: "/" });
  back.textContent = "로비로";
  const fileRow = el("div", "rv-group rv-file-group");
  const file = el("select", "rv-file", { "aria-label": "리플레이 파일" });
  file.id = "rv-file";
  file.addEventListener("change", () => {
    const name = file.value;
    history.replaceState(null, "", replayUrl(name));
    rvLoadReplay(name);
  });
  const download = el("a", "rv-download hidden", { download: "" });
  download.id = "rv-download";
  download.textContent = "내려받기";
  fileRow.append(file, download);

  const nav = el("div", "rv-group rv-nav hidden");
  nav.id = "rv-nav";
  const hand = el("select", "rv-hand-select", { "aria-label": "국 이동" });
  hand.id = "rv-hand";
  hand.addEventListener("change", () => {
    rvStop();
    rvGoTo(Number(hand.value));
  });
  nav.append(
    hand,
    rvButton("⏮", "국 처음", () => rvAct("handStart")),
    rvButton("◀", "이전 수 (←)", () => rvAct("prev")),
    rvButton("재생", "자동 재생 (스페이스)", () => rvAct("play"), "rv-play"),
    rvButton("▶", "다음 수 (→)", () => rvAct("next")),
    rvButton("⏭", "국 끝", () => rvAct("handEnd")),
    rvButton("화료·유국", "이 국의 화료/유국 지점", () => rvAct("result"))
  );
  nav.querySelector(".rv-play").id = "rv-play";
  const slider = el("input", "rv-slider", { type: "range", min: "0", value: "0", "aria-label": "수순" });
  slider.id = "rv-slider";
  slider.addEventListener("input", () => {
    rvStop();
    rvGoTo(Number(slider.value));
  });
  const position = el("span", "rv-position");
  position.id = "rv-position";
  nav.append(slider, position);

  const view = el("div", "rv-group rv-view hidden");
  view.id = "rv-view";
  const speed = el("select", "rv-speed", { "aria-label": "재생 속도" });
  for (const [value, label] of Object.entries(REPLAY_SPEED_KO)) {
    const opt = el("option", "", { value });
    opt.textContent = label;
    if (value === rv.speed) opt.selected = true;
    speed.appendChild(opt);
  }
  speed.addEventListener("change", () => {
    rv.speed = speed.value;
    rvSavePrefs();
    if (rv.playTimer) {
      rvStop();
      rvPlay();
    }
  });
  const anchor = el("select", "rv-anchor", { "aria-label": "아래 자리" });
  anchor.id = "rv-anchor";
  anchor.title = "작탁 아래(내 자리 위치)에 둘 좌석";
  anchor.addEventListener("change", () => {
    rv.anchor = Number(anchor.value);
    rvRender();
  });
  const hands = rvButton("", "다른 좌석 손패를 앞면으로 볼지, 아래 자리 시점(뒷면)으로 볼지", () => {
    rv.openHands = !rv.openHands;
    rvSavePrefs();
    rvRender();
  }, "rv-toggle");
  hands.id = "rv-open-hands";
  const ai = rvButton("AI 판단", "AI 판단 기록 패널 열기/닫기", () => {
    rv.aiOpen = !rv.aiOpen;
    rvSavePrefs();
    rvRender();
  }, "rv-toggle");
  ai.id = "rv-ai-toggle";
  view.append(speed, anchor, hands, ai);

  const status = el("span", "rv-status", { role: "status" });
  status.id = "rv-status";

  // 효과음 조작(app/audioManager가 이미 연결)은 이 막대 안으로 옮긴다. 대국 전용 버튼은 CSS(body.is-replay)로 숨긴다.
  const audio = document.getElementById("audio-controls");
  // 자주 쓰지 않는 조작(파일, 보기 설정, 상태, 소리)은 한 묶음: 넓은 화면에서는 한 줄에 함께, 좁거나 낮은 화면(휴대폰)에서는
  // "메뉴" 아래로 접는다 (style.css의 모바일 절).
  const extra = el("div", "rv-extra");
  extra.append(fileRow, view, status, audio);
  const more = rvButton("메뉴", "파일·보기 설정·소리 열기/닫기", () => {
    const open = !bar.classList.contains("is-open");
    bar.classList.toggle("is-open", open);
    more.setAttribute("aria-expanded", String(open));
  }, "rv-more");
  more.setAttribute("aria-expanded", "false");
  bar.append(back, nav, more, extra);
  document.body.prepend(bar);

  const panel = el("aside", "rv-ai-panel hidden", { "aria-label": "AI 판단 기록" });
  panel.id = "rv-ai-panel";
  const h2 = el("h2");
  h2.textContent = "AI 판단 기록";
  const note = el("p", "rv-ai-note");
  note.textContent = "이 수 직전에 엔진이 기록한 판단만 보여줍니다.";
  const list = el("div", "rv-ai-list");
  list.id = "rv-ai";
  panel.append(h2, note, list);
  document.body.appendChild(panel);
  window.addEventListener("resize", rvPlaceAiPanel);

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || !rv.data) return;
    if (e.key === "ArrowLeft") rvAct("prev");
    else if (e.key === "ArrowRight") rvAct("next");
    else if (e.key === " ") {
      e.preventDefault();
      rvAct("play");
    } else return;
  });
}

// --- 파일 목록 / 불러오기 ---

async function rvLoadList(wanted) {
  const res = await fetch("/api/replays");
  if (res.status === 401) {
    location.href = "/join.html";
    return [];
  }
  const files = res.ok ? await res.json() : [];
  const select = rv$("rv-file");
  select.innerHTML = "";
  const placeholder = el("option", "", { value: "" });
  placeholder.textContent = files.length ? "리플레이를 고르세요" : "저장된 리플레이가 없습니다";
  select.appendChild(placeholder);
  for (const f of files) {
    const opt = el("option", "", { value: f.name });
    opt.textContent = `${f.name} (${new Date(f.modified).toLocaleString("ko-KR")})`;
    select.appendChild(opt);
  }
  if (wanted && files.some((f) => f.name === wanted)) select.value = wanted;
  return files;
}

async function rvLoadReplay(name) {
  rvStop();
  rv.data = null;
  for (const id of ["rv-nav", "rv-view"]) rv$(id).classList.add("hidden");
  document.body.classList.remove("rv-ready");
  document.getElementById("hand-end-overlay").classList.add("hidden");
  const download = rv$("rv-download");
  download.classList.toggle("hidden", !name);
  // 원본 파일 내려받기 (버그 제보용): 재현 가능 여부와 관계없이 고른 파일이면 보여준다
  if (name) download.href = `/api/replays/${encodeURIComponent(name)}?download=1`;
  if (!name) {
    rvSetStatus("");
    return;
  }
  rvSetStatus("현재 엔진으로 재현하는 중... (한 판에 수 초 걸릴 수 있습니다)");
  const res = await fetch(`/api/replays/${encodeURIComponent(name)}`);
  if (!res.ok) {
    rvSetStatus(`불러오지 못했습니다: ${await res.text()}`);
    return;
  }
  const body = await res.json();
  if (!body.reproduction.ok) {
    const at = body.reproduction.mismatchAtEvent;
    rvSetStatus(`현재 엔진 버전으로 정확히 재현할 수 없는 리플레이입니다. ${body.reproduction.reason}${at !== null ? ` (이벤트 ${at}번)` : ""}`);
    return;
  }
  rv.data = body;
  const r = body.reproduction;
  rvSetStatus(`${r.playerCount === 4 ? "4마" : "산마"} · 시드 ${body.meta.gameSeed} · ${r.hands.length}국 · ${r.steps.length}수`);

  // 아래 자리: 사람이 둔 대국이면 그 사람, 아니면 동가(seat 0)
  const human = (body.meta.seats || []).find((s) => s.kind === "human");
  rv.anchor = human ? human.seat : 0;
  const anchor = rv$("rv-anchor");
  anchor.innerHTML = "";
  for (let seat = 0; seat < r.playerCount; seat++) {
    const opt = el("option", "", { value: String(seat) });
    opt.textContent = `아래: ${rvSeatName(seat)}`;
    if (seat === rv.anchor) opt.selected = true;
    anchor.appendChild(opt);
  }
  const hand = rv$("rv-hand");
  hand.innerHTML = "";
  for (const h of r.hands) {
    const opt = el("option", "", { value: String(h.firstStep) });
    opt.textContent = `${ROUND_WIND_KO[h.roundWind]}${h.roundHandNumber}국${h.honba ? ` ${h.honba}본장` : ""}`;
    hand.appendChild(opt);
  }
  rv$("rv-slider").max = String(r.steps.length - 1);
  currentCharacterNames = body.seatNames;
  for (const id of ["rv-nav", "rv-view"]) rv$(id).classList.remove("hidden");
  document.body.classList.add("rv-ready");
  rv.feed = [];
  rvGoTo(r.hands.length ? r.hands[0].firstStep : 0);
}

// --- 수 하나를 대국 화면의 view 모양으로 ---

/** 이 수(또는 그 앞에서 가장 가까운 수)의 작탁 상태. 첫 국 이전이나 게임 종료 이벤트는 table이 없을 수 있다. */
function rvTableAt(pos) {
  const steps = rv.data.reproduction.steps;
  for (let i = pos; i >= 0; i--) if (steps[i].table) return steps[i].table;
  return null;
}

/** PlayerView의 riichiDiscardIndexOf와 같다: 울려 간 패를 뺀 강에서 리치 선언패의 자리 (선언패가 울려 갔으면 null). */
function rvRiichiIndex(discards) {
  const declaredAt = discards.findIndex((d) => d.riichi);
  if (declaredAt === -1) return null;
  const before = discards.slice(0, declaredAt).filter((d) => !d.calledAway).length;
  const total = discards.filter((d) => !d.calledAway).length;
  return before < total ? before : null;
}

function rvBuildView(table, anchor, openHands, drawn) {
  const n = table.seats.length;
  const river = (s) => s.discards.filter((d) => !d.calledAway).map((d) => d.tile.kind);
  const own = table.seats[anchor];
  return {
    seat: anchor,
    concealedTiles: own.concealed,
    melds: own.melds,
    kitaTiles: own.kita,
    discards: river(own),
    riichiDiscardIndex: rvRiichiIndex(own.discards),
    riichi: own.riichi,
    seatWinds: table.seats.map((_, s) => ((s - table.dealer + n) % n) + 1),
    furiten: null,
    waits: [],
    opponents: table.seats
      .map((s, seat) => ({ s, seat }))
      .filter(({ seat }) => seat !== anchor)
      .map(({ s, seat }) => ({
        seat,
        discards: river(s),
        riichiDiscardIndex: rvRiichiIndex(s.discards),
        concealedCount: s.concealed.length,
        melds: s.melds,
        riichi: s.riichi,
        kitaCount: s.kita.length,
        ...(openHands ? { concealedTiles: s.concealed, drawnTileId: drawn && drawn.seat === seat ? drawn.tileId : undefined } : {}),
      })),
    doraIndicators: table.doraIndicators,
    scores: table.scores,
    dealerSeat: table.dealer,
    roundWind: table.roundWind,
    roundHandNumber: table.roundHandNumber,
    honba: table.honba,
    kyotaku: table.kyotaku,
  };
}

/** 쯔모 직후의 좌석과 그 패 (엔진은 뽑은 패를 손패 끝에 붙인다). 그 좌석의 손패에서 떼어 그린다. */
function rvDrawnAt(step, table) {
  const e = step.event;
  if (e.type !== "draw" || !table) return null;
  const last = table.seats[e.player].concealed.at(-1);
  return last ? { seat: e.player, tileId: last.id } : null;
}

function rvDescribe(e) {
  const name = rvSeatName;
  const tile = (kind, red) => koreanTileLabel(kind, red);
  switch (e.type) {
    case "hand_start":
      return `${ROUND_WIND_KO[e.roundWind]}${e.roundHandNumber}국 시작 (친: ${name(e.dealer)})`;
    case "deal":
      return "배패";
    case "dora_indicator_revealed":
      return `도라 표시패 공개: ${tile(e.indicator.kind, e.indicator.red)}`;
    case "draw":
      return `${name(e.player)}: ${e.source === "rinshan" ? "영상패 " : ""}쯔모`;
    case "discard":
      return `${name(e.player)}: ${tile(e.tile)} ${e.riichiDeclaration ? "리치 선언 타패" : e.tsumogiri ? "쯔모기리" : "타패"}`;
    case "call":
      return `${name(e.player)}: ${tile(e.kind)} ${REPLAY_CALL_KO[e.call] ?? e.call}`;
    case "kita":
      return `${name(e.player)}: 북 빼기`;
    case "riichi":
      return `${name(e.player)}: 리치 성립`;
    case "win":
      return `${name(e.player)}: ${e.isTsumo ? "쯔모" : `론 (${name(e.ronFrom)} 방총)`} · ${e.yakumanUnits > 0 ? "역만" : `${e.han}판 ${e.fu}부`} · ${formatPoints(e.points)}점`;
    case "exhaustive_draw":
      return `유국 (황패) · 텐파이: ${e.tenpaiPlayers.map(name).join(", ") || "없음"}`;
    case "abortive_draw":
      return `유국 · ${ABORTIVE_DRAW_KO[e.reason] ?? e.reason}`;
    case "hand_end":
      return "국 종료";
    case "game_end":
      return "게임 종료";
    default:
      return e.type;
  }
}

/** 효과음: 한 수씩 앞으로 갈 때만 대국과 같은 소리를 낸다 (건너뛰기/되감기는 조용히). */
function rvPlaySound(e) {
  const cue =
    e.type === "discard" ? { type: "discard" }
    : e.type === "kita" ? { type: "kita" }
    : e.type === "riichi" ? { type: "riichi" }
    : e.type === "hand_start" ? { type: "hand_start" }
    : e.type === "call" && e.call === "pon" ? { type: "pon" }
    : e.type === "call" && e.call.startsWith("kan") ? { type: "kan" }
    : e.type === "hand_end" ? { type: "hand_end", riichiSticksCollected: false }
    : null;
  if (cue) for (const key of AudioManager.keysForCue(cue)) AudioManager.play(key);
}

// --- 그리기 ---

function rvRender() {
  if (!rv.data) return;
  const r = rv.data.reproduction;
  const step = r.steps[rv.pos];
  const e = step.event;
  rv$("rv-slider").value = String(rv.pos);
  rv$("rv-position").textContent = `${rv.pos + 1} / ${r.steps.length}`;
  const hand = rvCurrentHand();
  if (hand) rv$("rv-hand").value = String(hand.firstStep);
  rv$("rv-anchor").value = String(rv.anchor);
  rv$("rv-open-hands").textContent = rv.openHands ? "손패: 전원 공개" : "손패: 아래 자리만";
  rv$("rv-open-hands").setAttribute("aria-pressed", String(rv.openHands));
  rv$("rv-ai-toggle").setAttribute("aria-pressed", String(rv.aiOpen));
  rv$("rv-ai-panel").classList.toggle("hidden", !rv.aiOpen);
  rvPlaceAiPanel();

  const table = rvTableAt(rv.pos);
  if (table) {
    const drawn = rvDrawnAt(step, step.table);
    const view = rvBuildView(table, rv.anchor, rv.openHands, drawn);
    const actor = typeof e.player === "number" ? e.player : null;
    renderTable(view, actor, { actorSeat: actor, latestDiscardSeat: e.type === "discard" ? e.player : null });
    renderMySeat(view, drawn && drawn.seat === rv.anchor ? { drawnTileId: drawn.tileId } : {});
  }

  // 지금 수 설명 (대국 화면의 행동 막대 자리)
  clearActionBar();
  const label = el("span", "section-label rv-event");
  label.textContent = rvDescribe(e);
  document.getElementById("action-bar").appendChild(label);
  placeActionBar();

  rvRenderFeed();
  rvRenderResult(e);
  rvRenderAi(step);
}

/** AI 패널은 조작 막대 바로 아래부터 (막대는 화면 폭에 따라 줄 수가 바뀐다) */
function rvPlaceAiPanel() {
  const bar = rv$("rv-bar");
  if (bar) rv$("rv-ai-panel").style.top = Math.round(bar.getBoundingClientRect().bottom + 6) + "px";
}

function rvCurrentHand() {
  let found = null;
  for (const h of rv.data.reproduction.hands) if (h.firstStep <= rv.pos) found = h;
  return found;
}

/** 왼쪽 위 최근 수 목록: 지금 수 직전까지 같은 국의 의미 있는 수 몇 개 (대국 화면의 최근 행동 목록과 같은 자리). */
function rvRenderFeed() {
  const steps = rv.data.reproduction.steps;
  const hand = rvCurrentHand();
  const items = [];
  const shown = new Set(["discard", "call", "kita", "riichi", "win", "exhaustive_draw", "abortive_draw"]);
  for (let i = rv.pos; i >= (hand ? hand.firstStep : 0) && items.length < FEED_MAX; i--) {
    const e = steps[i].event;
    if (shown.has(e.type)) items.unshift({ text: rvDescribe(e), win: e.type === "win" });
  }
  const box = document.getElementById("recent-feed");
  box.innerHTML = "";
  for (const item of items) {
    const row = el("div", "feed-item" + (item.win ? " is-win" : ""));
    row.textContent = item.text;
    box.appendChild(row);
  }
  box.classList.toggle("hidden", items.length === 0);
}

/** 국 결과/게임 종료: 대국과 같은 결과 창을 띄운다 (계속 버튼 대신 이어서 보기). 다른 수로 가면 닫힌다. */
function rvRenderResult(e) {
  const overlay = document.getElementById("hand-end-overlay");
  if (e.type !== "hand_end" && e.type !== "game_end") {
    overlay.classList.add("hidden");
    return;
  }
  const panel = document.getElementById("hand-end-panel");
  if (e.type === "hand_end") {
    const next = rv.data.reproduction.steps[rv.pos + 1];
    renderHandEndPanel(e, rv.anchor, !!next && next.event.type === "game_end");
  } else {
    panel.innerHTML = "";
    const h2 = el("h2");
    h2.textContent = "최종 결과";
    panel.appendChild(h2);
    const meta = el("div", "result-headline final-meta");
    meta.textContent = GAME_END_REASON_KO[e.reason] ?? e.reason;
    panel.appendChild(meta);
    // 엔진 computeFinalStandings와 같은 순서: 점수 높은 순, 같으면 처음 좌석 순
    const order = e.finalScores.map((score, player) => ({ player, score })).sort((a, b) => b.score - a.score || a.player - b.player);
    const standings = order.map((o, i) => ({ player: o.player, placement: i + 1, rawScore: o.score }));
    panel.appendChild(renderFinalStandings(standings, e, rv.anchor));
  }
  const btn = el("button", "continue-button");
  btn.textContent = rv.pos < rv.data.reproduction.steps.length - 1 ? "이어서 보기" : "닫기";
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (rv.pos < rv.data.reproduction.steps.length - 1) rvAct("next");
    else overlay.classList.add("hidden");
  });
  panel.insertBefore(btn, panel.firstChild.nextSibling);
  overlay.classList.remove("hidden");
}

// --- AI 판단 기록: 로그에 있는 필드만 보여준다. 캐릭터 고유 필드는 값이 있는 것만 원래 이름 그대로 나열한다. ---

const RV_DISCARD_SHOWN = new Set(["type", "handIndex", "player", "characterId", "chosenKind", "topCandidates"]);

function rvFmt(v) {
  return typeof v === "number" ? String(Math.round(v * 1000) / 1000) : v === undefined ? "" : String(v);
}

function rvKvList(entry, shown) {
  const extra = Object.entries(entry).filter(([k, v]) => !shown.has(k) && v !== null && v !== undefined && typeof v !== "object");
  if (!extra.length) return null;
  const dl = el("dl", "rv-kv");
  for (const [k, v] of extra) {
    const dt = el("dt");
    dt.textContent = k;
    const dd = el("dd");
    dd.textContent = rvFmt(v);
    dl.append(dt, dd);
  }
  return dl;
}

function rvText(tag, className, text) {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}

function rvRenderAiEntry(entry) {
  const box = el("div", "rv-ai-entry");
  const who = rvSeatName(entry.player);
  if (entry.type === "discard_decision") {
    box.appendChild(rvText("h3", "", `${who} · 타패 판단 → ${koreanTileLabel(entry.chosenKind)}`));
    const cols = ["kind", "score", "baselineScore", "shanten", "ukeireTileCount", "danger"];
    const labels = { kind: "후보", score: "점수", baselineScore: "기본 점수", shanten: "샹텐", ukeireTileCount: "유효패 장수", danger: "위험도" };
    const table = el("table", "rv-ai-table");
    const hr = el("tr");
    for (const c of cols) hr.appendChild(rvText("th", "", labels[c]));
    table.appendChild(hr);
    for (const c of entry.topCandidates) {
      const tr = el("tr", c.kind === entry.chosenKind ? "is-chosen" : "");
      for (const col of cols) tr.appendChild(rvText("td", "", col === "kind" ? koreanTileLabel(c.kind) : rvFmt(c[col])));
      table.appendChild(tr);
    }
    box.appendChild(table);
    const kv = rvKvList(entry, RV_DISCARD_SHOWN);
    if (kv) box.appendChild(kv);
  } else if (entry.type === "riichi_decision") {
    box.appendChild(rvText("h3", "", `${who} · 리치 판단 → ${entry.actualDecision === "riichi" ? "리치" : "다마"}`));
    const kv = rvKvList(entry, new Set(["type", "handIndex", "player", "characterId"]));
    if (kv) box.appendChild(kv);
  } else if (entry.type === "call_decision") {
    box.appendChild(rvText("h3", "", `${who} · ${REPLAY_CALL_KO[entry.callKind === "daiminkan" ? "kan_open" : entry.callKind] ?? entry.callKind} 판단 (${koreanTileLabel(entry.tile)}) → ${entry.actualDecision === "call" ? "울기" : "패스"}`));
    const kv = rvKvList(entry, new Set(["type", "handIndex", "player", "characterId"]));
    if (kv) box.appendChild(kv);
    if (entry.components) {
      const comp = rvKvList(entry.components, new Set());
      if (comp) {
        box.appendChild(rvText("div", "rv-ai-sub", "점수 구성 (components)"));
        box.appendChild(comp);
      }
    }
  } else {
    box.appendChild(rvText("h3", "", `${who} · ${entry.type}`));
  }
  return box;
}

function rvRenderAi(step) {
  if (!rv.aiOpen) return;
  const list = rv$("rv-ai");
  list.innerHTML = "";
  if (step.aiDecisions.length === 0) list.appendChild(rvText("p", "rv-ai-empty", "이 수 직전에 기록된 AI 판단이 없습니다."));
  for (const entry of step.aiDecisions) list.appendChild(rvRenderAiEntry(entry));
}

// --- 이동 / 재생 ---

function rvGoTo(i, { sound = false } = {}) {
  if (!rv.data) return;
  rv.pos = Math.max(0, Math.min(rv.data.reproduction.steps.length - 1, i));
  if (sound) rvPlaySound(rv.data.reproduction.steps[rv.pos].event);
  rvRender();
}

function rvStop() {
  if (rv.playTimer) clearTimeout(rv.playTimer);
  rv.playTimer = null;
  const btn = rv$("rv-play");
  if (btn) btn.textContent = "재생";
}

/** 자동 재생: 기본 유지 시간(속도 설정) × 그 수의 배수(rvHoldOf)만큼 머문 뒤 다음 수로. */
function rvPlay() {
  rv$("rv-play").textContent = "정지";
  const tick = () => {
    if (!rv.data || rv.pos >= rv.data.reproduction.steps.length - 1) return rvStop();
    rvGoTo(rv.pos + 1, { sound: true });
    const e = rv.data.reproduction.steps[rv.pos].event;
    rv.playTimer = setTimeout(tick, REPLAY_SPEEDS[rv.speed] * rvHoldOf(e));
  };
  rv.playTimer = setTimeout(tick, REPLAY_SPEEDS[rv.speed] * rvHoldOf(rv.data.reproduction.steps[rv.pos].event));
}

function rvAct(name) {
  if (!rv.data) return;
  const hand = rvCurrentHand();
  if (name === "play") {
    if (rv.playTimer) rvStop();
    else rvPlay();
    return;
  }
  rvStop();
  if (name === "prev") rvGoTo(rv.pos - 1);
  else if (name === "next") rvGoTo(rv.pos + 1, { sound: true });
  else if (name === "handStart" && hand) rvGoTo(rv.pos === hand.firstStep ? rv.pos - 1 : hand.firstStep);
  else if (name === "handEnd" && hand) rvGoTo(rv.pos === hand.lastStep ? rv.pos + 1 : hand.lastStep);
  else if (name === "result" && hand) {
    const next = hand.resultSteps.find((s) => s > rv.pos) ?? hand.resultSteps[0];
    if (next !== undefined) rvGoTo(next);
  }
}

async function startReplayMode() {
  rvLoadPrefs();
  rvBuildChrome();
  const params = new URLSearchParams(location.search);
  const wanted = params.get("replay") || "";
  const files = await rvLoadList(wanted);
  if (wanted && files.some((f) => f.name === wanted)) {
    await rvLoadReplay(wanted);
    // autoplay=1: 로비의 AI 관전이 방금 저장한 대국을 열 때. 재현이 끝나면 첫 국부터 자동 재생한다.
    if (params.get("autoplay") === "1" && rv.data && !rv.playTimer) rvPlay();
  } else if (wanted) {
    rvSetStatus("그 리플레이 파일을 찾을 수 없습니다. 목록에서 고르세요.");
  }
}

if (IS_REPLAY_MODE) startReplayMode();
