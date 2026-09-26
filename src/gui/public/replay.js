"use strict";

// 리플레이 뷰어. 서버가 현재 엔진으로 재현한 결과(/api/replays/<파일>)를 그대로 표시한다.
// 재현이 원본과 한 곳이라도 다르면 서버가 ok:false를 주고, 이 화면은 이유만 보여준다 (상태를 추측해 그리지 않는다).
// 패 이미지/이름 규칙은 app.js와 같다 (대국 화면 전역 상태와 섞지 않으려고 필요한 것만 둔다).

const SUIT_ASSET_PREFIX = { m: "Man", p: "Pin", s: "Sou" };
const HONOR_ASSET_NAME = ["Ton", "Nan", "Shaa", "Pei", "Haku", "Hatsu", "Chun"];
const HONOR_KO = ["동", "남", "서", "북", "백", "발", "중"];
const SUIT_KO = { m: "만", p: "통", s: "삭" };
const SUIT_ORDER = { m: 0, p: 1, s: 2, z: 3 };
const WIND_KO = ["", "동", "남", "서", "북"];
const MELD_KO = { pon: "퐁", chi: "치", daiminkan: "대명깡", ankan: "암깡", kakan: "가깡" };
const CALL_KO = { chi: "치", pon: "퐁", kan_open: "대명깡", kan_closed: "암깡", kan_added: "가깡" };
const ABORTIVE_KO = { nine_terminals: "구종구패", four_winds: "사풍자화", four_riichi: "사가입리", four_kans: "사깡산라" };

function parseKind(kind) {
  return { suit: kind[0], rank: Number(kind.slice(1)) };
}
function tileAsset(t) {
  const { suit, rank } = parseKind(t.kind);
  if (suit === "z") return `/assets/mahjong/regular/${HONOR_ASSET_NAME[rank - 1]}.svg`;
  if (rank === 5 && t.red) return `/assets/mahjong/regular/${SUIT_ASSET_PREFIX[suit]}5-Dora.svg`;
  return `/assets/mahjong/regular/${SUIT_ASSET_PREFIX[suit]}${rank}.svg`;
}
function tileName(kind, red) {
  const { suit, rank } = parseKind(kind);
  if (suit === "z") return HONOR_KO[rank - 1] ?? kind;
  return `${red ? "적" : ""}${rank}${SUIT_KO[suit] ?? suit}`;
}
function byDisplayOrder(a, b) {
  const pa = parseKind(a.kind);
  const pb = parseKind(b.kind);
  return (SUIT_ORDER[pa.suit] - SUIT_ORDER[pb.suit]) || pa.rank - pb.rank;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function tileImg(t, extraClass) {
  const img = el("img", "tile-img small" + (extraClass ? " " + extraClass : ""));
  img.src = tileAsset(t);
  img.alt = tileName(t.kind, t.red);
  img.title = img.alt;
  return img;
}
function points(n) {
  return n.toLocaleString("ko-KR");
}

let data = null; // 서버 응답
let pos = 0; // 현재 steps 위치
let playTimer = null;

const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $("rv-status").textContent = text;
}

async function loadList() {
  const res = await fetch("/api/replays");
  const files = res.ok ? await res.json() : [];
  const select = $("rv-file");
  select.innerHTML = "";
  const placeholder = el("option", "", files.length ? "리플레이를 고르세요" : "저장된 리플레이가 없습니다");
  placeholder.value = "";
  select.appendChild(placeholder);
  for (const f of files) {
    const opt = el("option", "", `${f.name} (${new Date(f.modified).toLocaleString("ko-KR")})`);
    opt.value = f.name;
    select.appendChild(opt);
  }
  const wanted = new URLSearchParams(location.search).get("file");
  if (wanted && files.some((f) => f.name === wanted)) {
    select.value = wanted;
    loadReplay(wanted);
  }
}

async function loadReplay(name) {
  stopPlay();
  $("rv-main").classList.add("hidden");
  data = null;
  // 원본 파일 내려받기 (버그 제보용): 재현 가능 여부와 관계없이 고른 파일이면 보여준다
  const download = $("rv-download");
  download.classList.toggle("hidden", !name);
  if (name) download.href = `/api/replays/${encodeURIComponent(name)}?download=1`;
  if (!name) {
    setStatus("");
    return;
  }
  setStatus("현재 엔진으로 재현하는 중... (한 판에 수 초 걸릴 수 있습니다)");
  const res = await fetch(`/api/replays/${encodeURIComponent(name)}`);
  if (!res.ok) {
    setStatus(`불러오지 못했습니다: ${await res.text()}`);
    return;
  }
  const body = await res.json();
  if (!body.reproduction.ok) {
    const at = body.reproduction.mismatchAtEvent;
    setStatus(`현재 엔진 버전으로 정확히 재현할 수 없는 리플레이입니다. ${body.reproduction.reason}${at !== null ? ` (이벤트 ${at}번)` : ""}`);
    return;
  }
  data = body;
  const r = data.reproduction;
  setStatus(`${data.meta.rules.playerCount === 4 ? "4마" : "산마"} · 시드 ${data.meta.gameSeed} · ${r.hands.length}국 · ${r.steps.length}수`);
  $("rv-slider").max = String(r.steps.length - 1);
  renderHandNav();
  $("rv-main").classList.remove("hidden");
  goTo(r.hands.length ? r.hands[0].firstStep : 0);
}

function currentHand() {
  const hands = data.reproduction.hands;
  let found = null;
  for (const h of hands) if (h.firstStep <= pos) found = h;
  return found;
}

function renderHandNav() {
  const nav = $("rv-hands");
  nav.innerHTML = "";
  for (const h of data.reproduction.hands) {
    const btn = el("button", "rv-hand", `${WIND_KO[h.roundWind]}${h.roundHandNumber}국${h.honba ? ` ${h.honba}본장` : ""}`);
    btn.type = "button";
    btn.dataset.first = String(h.firstStep);
    btn.addEventListener("click", () => goTo(h.firstStep));
    nav.appendChild(btn);
  }
}

function seatName(seat) {
  return data.seatNames[seat] ?? `Seat ${seat}`;
}

function describeEvent(e) {
  switch (e.type) {
    case "hand_start":
      return `${WIND_KO[e.roundWind]}${e.roundHandNumber}국 시작 (친: ${seatName(e.dealer)})`;
    case "deal":
      return "배패";
    case "dora_indicator_revealed":
      return `도라 표시패 공개: ${tileName(e.indicator.kind, e.indicator.red)}`;
    case "draw":
      return `${seatName(e.player)}: ${e.source === "rinshan" ? "영상패 " : ""}쯔모`;
    case "discard":
      return `${seatName(e.player)}: ${tileName(e.tile)} ${e.riichiDeclaration ? "리치 선언 타패" : e.tsumogiri ? "쯔모기리" : "타패"}`;
    case "call":
      return `${seatName(e.player)}: ${tileName(e.kind)} ${CALL_KO[e.call] ?? e.call}`;
    case "kita":
      return `${seatName(e.player)}: 북 빼기`;
    case "riichi":
      return `${seatName(e.player)}: 리치 성립`;
    case "win":
      return `${seatName(e.player)}: ${e.isTsumo ? "쯔모" : `론 (${seatName(e.ronFrom)} 방총)`} · ${e.yakumanUnits > 0 ? "역만" : `${e.han}판 ${e.fu}부`} · ${points(e.points)}점`;
    case "exhaustive_draw":
      return `유국 (황패) · 텐파이: ${e.tenpaiPlayers.map(seatName).join(", ") || "없음"}`;
    case "abortive_draw":
      return `유국 · ${ABORTIVE_KO[e.reason] ?? e.reason}`;
    case "hand_end":
      return "국 종료";
    case "game_end":
      return "게임 종료";
    default:
      return e.type;
  }
}

function renderMeld(m) {
  const g = el("span", "rv-meld");
  g.appendChild(el("span", "rv-meld-label", MELD_KO[m.type] ?? m.type));
  for (const t of m.tiles) g.appendChild(tileImg(t));
  return g;
}

function renderSeat(seatIndex, seat, table, event) {
  const row = el("div", "rv-seat");
  const actor = event && typeof event.player === "number" && event.player === seatIndex;
  if (actor) row.classList.add("is-actor");

  const head = el("div", "rv-seat-head");
  const wind = (seatIndex - table.dealer + data.reproduction.playerCount) % data.reproduction.playerCount + 1;
  head.appendChild(el("span", "rv-wind", WIND_KO[wind]));
  head.appendChild(el("span", "rv-name", seatName(seatIndex)));
  if (seatIndex === table.dealer) head.appendChild(el("span", "rv-badge", "친"));
  if (seat.riichi) head.appendChild(el("span", "rv-badge is-riichi", "리치"));
  head.appendChild(el("span", "rv-score", points(table.scores[seatIndex])));
  row.appendChild(head);

  const hand = el("div", "rv-hand-tiles");
  for (const t of [...seat.concealed].sort(byDisplayOrder)) hand.appendChild(tileImg(t));
  for (const m of seat.melds) hand.appendChild(renderMeld(m));
  if (seat.kita.length) {
    const kita = el("span", "rv-meld");
    kita.appendChild(el("span", "rv-meld-label", "북"));
    for (const t of seat.kita) kita.appendChild(tileImg(t));
    hand.appendChild(kita);
  }
  row.appendChild(hand);

  const river = el("div", "rv-river");
  seat.discards.forEach((d, i) => {
    const cls = [d.calledAway ? "is-called" : "", d.riichi ? "is-riichi" : "", event && event.type === "discard" && actor && i === seat.discards.length - 1 ? "is-latest" : ""].filter(Boolean).join(" ");
    const img = tileImg(d.tile, cls);
    if (d.calledAway) img.title += " (울림)";
    if (d.tsumogiri) img.title += " (쯔모기리)";
    river.appendChild(img);
  });
  row.appendChild(river);
  return row;
}

// --- AI 판단 기록: 로그에 있는 필드만 보여준다. 캐릭터 고유 필드는 값이 있는 것만 원래 이름 그대로 나열한다. ---

const DISCARD_SHOWN = new Set(["type", "handIndex", "player", "characterId", "chosenKind", "topCandidates"]);

function kvList(entry, shown) {
  const extra = Object.entries(entry).filter(([k, v]) => !shown.has(k) && v !== null && v !== undefined && typeof v !== "object");
  if (!extra.length) return null;
  const dl = el("dl", "rv-kv");
  for (const [k, v] of extra) {
    dl.appendChild(el("dt", "", k));
    dl.appendChild(el("dd", "", typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v)));
  }
  return dl;
}

function fmt(v) {
  return typeof v === "number" ? String(Math.round(v * 1000) / 1000) : v === undefined ? "" : String(v);
}

function renderAiEntry(entry) {
  const box = el("div", "rv-ai-entry");
  const who = `${seatName(entry.player)}`;
  if (entry.type === "discard_decision") {
    box.appendChild(el("h3", "", `${who} · 타패 판단 → ${tileName(entry.chosenKind)}`));
    const cols = ["kind", "score", "baselineScore", "shanten", "ukeireTileCount", "danger"];
    const labels = { kind: "후보", score: "점수", baselineScore: "기본 점수", shanten: "샹텐", ukeireTileCount: "유효패 장수", danger: "위험도" };
    const table = el("table", "rv-ai-table");
    const hr = el("tr");
    for (const c of cols) hr.appendChild(el("th", "", labels[c]));
    table.appendChild(hr);
    for (const c of entry.topCandidates) {
      const tr = el("tr", c.kind === entry.chosenKind ? "is-chosen" : "");
      for (const col of cols) tr.appendChild(el("td", "", col === "kind" ? tileName(c.kind) : fmt(c[col])));
      table.appendChild(tr);
    }
    box.appendChild(table);
    const kv = kvList(entry, DISCARD_SHOWN);
    if (kv) box.appendChild(kv);
  } else if (entry.type === "riichi_decision") {
    box.appendChild(el("h3", "", `${who} · 리치 판단 → ${entry.actualDecision === "riichi" ? "리치" : "다마"}`));
    const kv = kvList(entry, new Set(["type", "handIndex", "player", "characterId"]));
    if (kv) box.appendChild(kv);
  } else if (entry.type === "call_decision") {
    box.appendChild(el("h3", "", `${who} · ${CALL_KO[entry.callKind === "daiminkan" ? "kan_open" : entry.callKind]} 판단 (${tileName(entry.tile)}) → ${entry.actualDecision === "call" ? "울기" : "패스"}`));
    const kv = kvList(entry, new Set(["type", "handIndex", "player", "characterId"]));
    if (kv) box.appendChild(kv);
    if (entry.components) {
      const comp = kvList(entry.components, new Set());
      if (comp) {
        box.appendChild(el("div", "rv-ai-sub", "점수 구성 (components)"));
        box.appendChild(comp);
      }
    }
  } else {
    box.appendChild(el("h3", "", `${who} · ${entry.type}`));
  }
  return box;
}

function render() {
  const r = data.reproduction;
  const step = r.steps[pos];
  $("rv-slider").value = String(pos);
  $("rv-position").textContent = `${pos + 1} / ${r.steps.length}`;
  $("rv-event").textContent = describeEvent(step.event);

  const hand = currentHand();
  for (const btn of $("rv-hands").children) btn.classList.toggle("is-current", !!hand && btn.dataset.first === String(hand.firstStep));

  const table = step.table;
  const seatsBox = $("rv-seats");
  seatsBox.innerHTML = "";
  if (table) {
    $("rv-round").innerHTML = "";
    const round = el("div", "rv-round-line", `${WIND_KO[table.roundWind]}${table.roundHandNumber}국 · ${table.honba}본장 · 공탁 ${table.kyotaku}`);
    $("rv-round").appendChild(round);
    const dora = el("div", "rv-dora");
    dora.appendChild(el("span", "rv-meld-label", "도라 표시패"));
    for (const t of table.doraIndicators) dora.appendChild(tileImg(t));
    $("rv-round").appendChild(dora);
    table.seats.forEach((seat, i) => seatsBox.appendChild(renderSeat(i, seat, table, step.event)));
  }

  const ai = $("rv-ai");
  ai.innerHTML = "";
  if (step.aiDecisions.length === 0) ai.appendChild(el("p", "rv-ai-empty", "이 수 직전에 기록된 AI 판단이 없습니다."));
  for (const entry of step.aiDecisions) ai.appendChild(renderAiEntry(entry));
}

function goTo(i) {
  if (!data) return;
  pos = Math.max(0, Math.min(data.reproduction.steps.length - 1, i));
  render();
}

function stopPlay() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  $("rv-play").textContent = "재생";
}

function togglePlay() {
  if (playTimer) return stopPlay();
  $("rv-play").textContent = "정지";
  playTimer = setInterval(() => {
    if (!data || pos >= data.reproduction.steps.length - 1) return stopPlay();
    goTo(pos + 1);
  }, 450);
}

function act(name) {
  if (!data) return;
  const hand = currentHand();
  if (name !== "play") stopPlay();
  if (name === "prev") goTo(pos - 1);
  else if (name === "next") goTo(pos + 1);
  else if (name === "play") togglePlay();
  else if (name === "handStart" && hand) goTo(pos === hand.firstStep ? pos - 1 : hand.firstStep);
  else if (name === "handEnd" && hand) goTo(pos === hand.lastStep ? pos + 1 : hand.lastStep);
  else if (name === "result" && hand) {
    const next = hand.resultSteps.find((s) => s > pos) ?? hand.resultSteps[0];
    if (next !== undefined) goTo(next);
  }
}

document.querySelectorAll(".rv-controls button").forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));
$("rv-slider").addEventListener("input", () => {
  stopPlay();
  goTo(Number($("rv-slider").value));
});
$("rv-file").addEventListener("change", () => {
  const name = $("rv-file").value;
  history.replaceState(null, "", name ? `?file=${encodeURIComponent(name)}` : location.pathname);
  loadReplay(name);
});
document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === "ArrowLeft") act("prev");
  if (e.key === "ArrowRight") act("next");
});

loadList();
