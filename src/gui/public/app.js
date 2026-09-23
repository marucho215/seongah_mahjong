"use strict";

// --- Display-only tile helpers (mirrors src/cli/tileFormat.ts's logic; duplicated here
// deliberately - see the report's tech-direction note - rather than adding a bundler step
// to share one TS source between Node and the browser). Never touches engine notation. ---

function parseKind(kind) {
  return { suit: kind[0], rank: Number(kind.slice(1)) };
}

const SUIT_ASSET_PREFIX = { m: "Man", p: "Pin", s: "Sou" };
const HONOR_ASSET_NAME = ["Ton", "Nan", "Shaa", "Pei", "Haku", "Hatsu", "Chun"];
const HONOR_KO = ["동", "남", "서", "북", "백", "발", "중"];
const SUIT_KO = { m: "만", p: "통", s: "삭" };

/** TileKind (+ isRed) -> asset file path under /assets/mahjong/regular/. */
function tileAssetFor(kind, isRed) {
  const { suit, rank } = parseKind(kind);
  if (suit === "z") return `/assets/mahjong/regular/${HONOR_ASSET_NAME[rank - 1]}.svg`;
  const prefix = SUIT_ASSET_PREFIX[suit];
  if (rank === 5 && isRed) return `/assets/mahjong/regular/${prefix}5-Dora.svg`;
  return `/assets/mahjong/regular/${prefix}${rank}.svg`;
}

/** Same purely-cosmetic sort as compareTilesForDisplay in tileFormat.ts. */
const SUIT_ORDER = { m: 0, p: 1, s: 2, z: 3 };
function compareTilesForDisplay(a, b) {
  const pa = parseKind(a.kind);
  const pb = parseKind(b.kind);
  const d = (SUIT_ORDER[pa.suit] ?? 9) - (SUIT_ORDER[pb.suit] ?? 9);
  return d !== 0 ? d : pa.rank - pb.rank;
}

function koreanTileLabel(kind, isRed) {
  const { suit, rank } = parseKind(kind);
  if (suit === "z") return HONOR_KO[rank - 1] ?? kind;
  const base = `${rank}${SUIT_KO[suit] ?? suit}`;
  return isRed ? `적${base}` : base;
}

const REPLAY_MELD_LABEL = { pon: "퐁", chi: "치", daiminkan: "대명깡", ankan: "암깡", kakan: "가깡" };

const CALL_VERB = { call_pon: "퐁", call_daiminkan: "대명깡", ankan: "암깡", kakan: "가깡" };
function batchimIndex(text) {
  const code = text.charCodeAt(text.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return 0;
  return (code - 0xac00) % 28;
}
function josaEulReul(text) {
  return batchimIndex(text) !== 0 ? "을" : "를";
}
function josaRo(text) {
  const idx = batchimIndex(text);
  return idx !== 0 && idx !== 8 ? "으로" : "로";
}

// --- Result-screen display mappings (presentation-only; never fed back into the engine
// or the replay data - a hand_end event's own yaku.name / result.kind strings are untouched). ---

const YAKU_KO = {
  Riichi: "리치",
  "Double Riichi": "더블리치",
  Ippatsu: "일발",
  "Menzen Tsumo": "멘젠쯔모",
  Pinfu: "평화",
  Tanyao: "탕야오",
  Iipeikou: "일배구",
  Ryanpeikou: "량배구",
  Ittsuu: "일기통관",
  "Sanshoku Doujun": "삼색동순",
  "Sanshoku Doukou": "삼색동각",
  Chanta: "찬타",
  Junchan: "준찬타",
  Toitoi: "또이또이",
  Sanankou: "삼암각",
  Honitsu: "혼일색",
  Chinitsu: "청일색",
  Honroutou: "혼로또",
  Chinroutou: "친로또",
  Ryuuiisou: "녹일색",
  Tsuuiisou: "자일색",
  Chiitoitsu: "칠대자",
  Daisangen: "대삼원",
  Shousangen: "소삼원",
  Daisuushii: "대사희",
  Shousuushii: "소사희",
  Suuankou: "사암각",
  "Suuankou Tanki": "사암각 단기",
  Suukantsu: "사깡자",
  Sankantsu: "삼깡자",
  "Chuuren Poutou": "구련보등",
  "Junsei Chuuren Poutou": "순정 구련보등",
  "Kokushi Musou": "국사무쌍",
  "Kokushi Musou (13-wait)": "국사무쌍 (13면대기)",
  Tenhou: "천화",
  Chiihou: "지화",
  "Haitei Raoyue": "해저로월",
  "Houtei Raoyui": "하저로어",
  "Rinshan Kaihou": "영상개화",
  Chankan: "창깡",
  Dora: "도라",
  "Yakuhai (seat wind)": "역패 (자풍)",
  "Yakuhai (round wind)": "역패 (장풍)",
  "Yakuhai (North)": "역패 (북)",
};

/** Yaku names that reference a dragon TileKind directly, e.g. "Yakuhai (z5)" - built by
 *  src/yaku/yakuStandard.ts's `Yakuhai (${g.kind})`. Translated dynamically since the raw
 *  kind string (z5/z6/z7) isn't a fixed literal we can just look up above. */
function translateYaku(name) {
  if (YAKU_KO[name]) return YAKU_KO[name];
  const dragonMatch = /^Yakuhai \((z[567])\)$/.exec(name);
  if (dragonMatch) return `역패 (${koreanTileLabel(dragonMatch[1])})`;
  return name; // unknown/new yaku: fall back to the raw engine name rather than breaking
}

const ABORTIVE_DRAW_KO = {
  nine_terminals: "구종구패",
  four_winds: "사풍자화",
  four_riichi: "사가입리",
  four_kans: "사깡산라",
};

const ROUND_WIND_KO = ["", "동", "남", "서", "북"];

function formatPoints(n) {
  return n.toLocaleString("ko-KR");
}

function formatDelta(n) {
  if (n > 0) return `+${formatPoints(n)}`;
  if (n < 0) return formatPoints(n);
  return "±0";
}

// --- DOM helpers ---

function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function tileImg(tileRef, { small = false, clickable = false, riichiLegal = false } = {}) {
  const img = el("img", "tile-img" + (small ? " small" : ""));
  img.src = tileAssetFor(tileRef.kind, tileRef.red);
  img.alt = koreanTileLabel(tileRef.kind, tileRef.red);
  img.title = koreanTileLabel(tileRef.kind, tileRef.red);
  if (clickable) img.classList.add("clickable");
  if (riichiLegal) img.classList.add("riichi-legal");
  return img;
}

// --- Identity (character name) helper: server-supplied characterNames only, no
// hardcoded names in this file. A seat with no character profile falls back to a
// generic player label (for "me") or a bare seat number (dev-info fallback). ---

let currentCharacterNames = [];

function displayNameForSeat(seat, mySeat) {
  const name = currentCharacterNames[seat];
  if (name) return name;
  if (seat === mySeat) return "플레이어";
  return `Seat ${seat}`;
}

// --- Rendering: table ---
//
// The whole page is one table with four VISUAL positions (bottom/right/top/left). Seats are
// mapped onto positions relative to the local seat, so the same DOM serves 3 and 4 players:
// positions nobody sits in are simply hidden. Nothing here is specific to seat numbers.

const POSITIONS = ["bottom", "right", "top", "left"];
const RIVER_TURN_DEG = { bottom: 0, right: -90, top: 180, left: 90 };

/** Visual position of `seat` for the local player `mySeat` among `n` players: me at the
 *  bottom, the next seat in turn order on my right, the previous on my left, and (4 players
 *  only) the seat two away across the table. */
function positionOf(seat, mySeat, n) {
  const offset = (seat - mySeat + n) % n;
  if (offset === 0) return "bottom";
  if (offset === 1) return "right";
  if (offset === n - 1) return "left";
  return "top";
}

let tableBuilt = false;

function buildTableSkeleton() {
  if (tableBuilt) return;
  tableBuilt = true;
  const table = document.getElementById("table");

  for (const pos of ["top", "left", "right", "bottom"]) {
    const zone = el("div", "zone");
    zone.dataset.pos = pos;
    zone.id = "zone-" + pos;
    const info = el("div", "zone-info");
    info.appendChild(el("div", "nameplate"));
    info.appendChild(el("div", "melds"));
    if (pos === "bottom") info.appendChild(el("div", "kita"));
    if (pos === "bottom") {
      zone.appendChild(info);
      zone.appendChild(el("div", "tile-row hand"));
    } else {
      zone.appendChild(el("div", "hand-edge"));
      zone.appendChild(info);
    }
    table.appendChild(zone);
  }

  const board = el("div", "board");
  board.id = "board";
  for (const pos of POSITIONS) {
    const cell = el("div", "river-cell");
    cell.dataset.pos = pos;
    cell.appendChild(el("div", "river-wrap"));
    cell.appendChild(el("div", "stick"));
    board.appendChild(cell);
  }
  const center = el("div", "center");
  center.id = "center-info";
  center.appendChild(el("div", "center-main"));
  for (const pos of POSITIONS) {
    const slot = el("div", "score-slot");
    slot.dataset.pos = pos;
    center.appendChild(slot);
  }
  board.appendChild(center);
  table.appendChild(board);
}

function zoneEl(pos) {
  return document.getElementById("zone-" + pos);
}

function riverCellEl(pos) {
  return document.querySelector(`.river-cell[data-pos="${pos}"]`);
}

function scoreSlotEl(pos) {
  return document.querySelector(`.score-slot[data-pos="${pos}"]`);
}

const BACK_ASSET = "/assets/mahjong/regular/Back.svg";

/** A small tile drawn sideways (riichi declaration tile / called tile in a meld). */
function rotatedTileBox(tileRef) {
  const box = el("div", "rot-box");
  box.appendChild(tileImg(tileRef, { small: true }));
  return box;
}

function backTileImg() {
  const img = el("img", "tile-img small");
  img.src = BACK_ASSET;
  img.alt = "뒷면";
  return img;
}

/** Index (within a meld's tiles) of the sideways called tile, from where it was taken: the
 *  tile sits on the side of the player it came from - right (next seat), across (middle), or
 *  left (previous seat) - computed from the relative seat offset, never from seat numbers. */
function calledTileIndex(ownerSeat, fromSeat, playerCount, tileCount) {
  const offset = (fromSeat - ownerSeat + playerCount) % playerCount;
  if (offset === 1) return tileCount - 1;
  if (offset === playerCount - 1) return 0;
  return 1; // across (4-player only)
}

/** Meld as it sits on a real table: the called tile sideways on the side it came from, a
 *  kakan's added tile stacked on it, and a closed kan (ankan) with its outer two tiles face
 *  down. Display only - built from MeldSnapshot.type/tiles/fromPlayer. */
function renderMeldGroup(meld, ownerSeat, playerCount) {
  const group = el("div", "meld-group" + (meld.type === "ankan" ? " meld-concealed" : ""));
  const label = el("span", "meld-label");
  label.textContent = REPLAY_MELD_LABEL[meld.type] ?? meld.type;
  group.appendChild(label);

  if (meld.type === "ankan") {
    meld.tiles.forEach((t, i) => group.appendChild(i === 0 || i === meld.tiles.length - 1 ? backTileImg() : tileImg(t, { small: true })));
    return group;
  }
  if (meld.fromPlayer === undefined || ownerSeat === undefined) {
    for (const t of meld.tiles) group.appendChild(tileImg(t, { small: true }));
    return group;
  }

  if (meld.type === "kakan") {
    // 3 slots; the called slot holds the original called tile with the added tile stacked on it.
    const slotCount = meld.tiles.length - 1;
    const calledSlot = calledTileIndex(ownerSeat, meld.fromPlayer, playerCount, slotCount);
    const upright = meld.tiles.slice(2);
    let u = 0;
    for (let slot = 0; slot < slotCount; slot++) {
      if (slot === calledSlot) {
        const stack = el("div", "rot-stack");
        stack.appendChild(rotatedTileBox(meld.tiles[0]));
        stack.appendChild(rotatedTileBox(meld.tiles[1]));
        group.appendChild(stack);
      } else {
        group.appendChild(tileImg(upright[u++], { small: true }));
      }
    }
    return group;
  }

  const calledIdx = calledTileIndex(ownerSeat, meld.fromPlayer, playerCount, meld.tiles.length);
  meld.tiles.forEach((t, i) => group.appendChild(i === calledIdx ? rotatedTileBox(t) : tileImg(t, { small: true })));
  return group;
}

/** A discard river: rows of six in discard order, with the riichi declaration tile sideways. */
function buildRiver(kinds, riichiIndex) {
  const river = el("div", "river");
  for (let start = 0; start < kinds.length; start += 6) {
    const row = el("div", "river-row");
    kinds.slice(start, start + 6).forEach((kind, offset) => {
      const tileRef = { kind };
      row.appendChild(start + offset === riichiIndex ? rotatedTileBox(tileRef) : tileImg(tileRef, { small: true }));
    });
    river.appendChild(row);
  }
  return river;
}

/** Turns `inner` to face its seat: 0 (bottom), 180 (top), or a quarter turn (left 90 / right
 *  -90), where the wrapper takes the swapped size so the page layout is unaffected. Only the
 *  tiles turn - names, scores and buttons elsewhere are never rotated. */
function placeRotated(wrapper, inner, deg) {
  wrapper.innerHTML = "";
  wrapper.style.width = "";
  wrapper.style.height = "";
  wrapper.appendChild(inner);
  if (deg === 0) return;
  if (deg === 180) {
    inner.style.transform = "rotate(180deg)";
    return;
  }
  wrapper.classList.add("quarter");
  const w = inner.offsetWidth;
  const h = inner.offsetHeight;
  wrapper.style.width = h + "px";
  wrapper.style.height = w + "px";
  inner.style.transformOrigin = "top left";
  inner.style.transform = deg === -90 ? "translateY(" + w + "px) rotate(-90deg)" : "translateX(" + h + "px) rotate(90deg)";
}

/** Face-down tiles for an opponent's concealed hand along the table edge (count only). */
function renderHandEdge(container, count, pos) {
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const img = el("img", "back-tile");
    img.src = BACK_ASSET;
    img.alt = "";
    if (pos === "top") {
      container.appendChild(img);
    } else {
      // side seats: the same tile art turned a quarter turn inside a box of swapped size
      const box = el("div", "back-box");
      box.appendChild(img);
      container.appendChild(box);
    }
  }
}

const WIND_KO = ["", "동", "남", "서", "북"];

/** Three visually separate groups: [turn marker, outside the plate] | [seat wind + dealer badge]
 *  | [name + score] (+ small notes). Turn and dealer are independent: either, both or neither. */
function renderNameplate(plate, seat, mySeat, view, extras) {
  plate.innerHTML = "";
  plate.classList.toggle("is-turn", extras.turn);

  const winds = el("span", "np-winds");
  const wind = el("span", "wind-badge");
  wind.textContent = WIND_KO[view.seatWinds[seat]] ?? "";
  wind.title = "자풍";
  winds.appendChild(wind);
  if (seat === view.dealerSeat) {
    const dealer = el("span", "dealer-badge");
    dealer.textContent = "친";
    dealer.title = "친(딜러)";
    winds.appendChild(dealer);
  }
  plate.appendChild(winds);

  const who = el("span", "np-who");
  const name = el("span", "np-name");
  name.textContent = displayNameForSeat(seat, mySeat);
  name.title = `Seat ${seat}`;
  who.appendChild(name);
  const score = el("span", "np-score");
  score.textContent = formatPoints(view.scores[seat] ?? 0);
  who.appendChild(score);
  plate.appendChild(who);

  if (extras.kitaCount > 0) {
    const kita = el("span", "np-note");
    kita.textContent = `북패 ×${extras.kitaCount}`;
    plate.appendChild(kita);
  }
  if (extras.furiten && extras.furiten.active) {
    // Furiten is shown exactly as the engine reports it (PlayerView.furiten) - never derived here.
    const f = el("span", "furiten-marker");
    f.textContent = "후리텐";
    f.title = [
      extras.furiten.selfDiscard && "자신의 버림패에 대기패가 있음 (영구)",
      extras.furiten.temporary && "론을 패스함 (다음 자기 쯔모까지)",
      extras.furiten.riichi && "리치 중 론을 패스함 (이번 국 내내)",
    ].filter(Boolean).join(" / ");
    plate.appendChild(f);
  }
}

function renderCenter(view, n, turnSeat) {
  const main = document.querySelector("#center-info .center-main");
  main.innerHTML = "";
  const round = el("div", "round-line");
  round.textContent = `${ROUND_WIND_KO[view.roundWind] ?? view.roundWind}${view.roundHandNumber}국`;
  round.title = "장풍 · 국";
  main.appendChild(round);
  const chips = el("div", "chip-row");
  for (const [label, value] of [["본장", view.honba], ["공탁", "×" + view.kyotaku]]) {
    const chip = el("span", "chip");
    chip.textContent = `${label} ${value}`;
    chips.appendChild(chip);
  }
  main.appendChild(chips);
  const dora = el("div", "dora-row");
  const label = el("span", "section-label");
  label.textContent = "도라";
  dora.appendChild(label);
  for (const t of view.doraIndicators) dora.appendChild(tileImg(t, { small: true }));
  main.appendChild(dora);

  for (let seat = 0; seat < n; seat++) {
    const slot = scoreSlotEl(positionOf(seat, view.seat, n));
    slot.textContent = formatPoints(view.scores[seat] ?? 0);
    slot.classList.toggle("is-turn", seat === turnSeat);
  }
}

/** Renders everything on the table except my own concealed hand (see renderMySeat). */
function renderTable(view, turnSeat) {
  buildTableSkeleton();
  const n = view.scores.length;
  const table = document.getElementById("table");
  table.dataset.players = String(n);

  const seatOfPos = {};
  for (let seat = 0; seat < n; seat++) seatOfPos[positionOf(seat, view.seat, n)] = seat;
  for (const pos of POSITIONS) {
    const active = pos in seatOfPos;
    zoneEl(pos).classList.toggle("hidden", !active);
    riverCellEl(pos).classList.toggle("hidden", !active);
    scoreSlotEl(pos).classList.toggle("hidden", !active);
  }

  renderCenter(view, n, turnSeat);

  for (const pos of POSITIONS) {
    if (!(pos in seatOfPos)) continue;
    const seat = seatOfPos[pos];
    const isMe = seat === view.seat;
    const data = isMe
      ? { discards: view.discards, riichiDiscardIndex: view.riichiDiscardIndex, melds: view.melds, riichi: view.riichi, kitaCount: 0, concealedCount: 0 }
      : view.opponents.find((o) => o.seat === seat);
    const zone = zoneEl(pos);

    renderNameplate(zone.querySelector(".nameplate"), seat, view.seat, view, {
      turn: seat === turnSeat,
      kitaCount: isMe ? 0 : data.kitaCount,
      furiten: isMe ? view.furiten : null,
    });

    const melds = zone.querySelector(".melds");
    melds.innerHTML = "";
    for (const m of data.melds) melds.appendChild(renderMeldGroup(m, seat, n));

    if (!isMe) renderHandEdge(zone.querySelector(".hand-edge"), data.concealedCount, pos);

    const cell = riverCellEl(pos);
    const wrap = cell.querySelector(".river-wrap");
    wrap.classList.remove("quarter");
    cell.querySelector(".stick").classList.toggle("on", data.riichi);
    placeRotated(wrap, buildRiver(data.discards, data.riichiDiscardIndex), RIVER_TURN_DEG[pos]);
  }
}

/** My concealed hand (sorted, with the just-drawn tile set apart) and my extracted kita. */
function renderMySeat(view, options) {
  const zone = zoneEl("bottom");

  const kita = zone.querySelector(".kita");
  kita.innerHTML = "";
  if (view.kitaTiles.length > 0) {
    const label = el("span", "section-label");
    label.textContent = "북:";
    kita.appendChild(label);
    for (const t of view.kitaTiles) kita.appendChild(tileImg(t, { small: true }));
  }

  const hand = zone.querySelector(".hand");
  hand.innerHTML = "";
  const drawnId = options && options.drawnTileId;
  const sorted = [...view.concealedTiles].sort(compareTilesForDisplay);
  let currentSuit = null;
  for (const t of sorted) {
    const suit = parseKind(t.kind).suit;
    if (currentSuit !== null && suit !== currentSuit) hand.appendChild(el("div", "suit-gap"));
    currentSuit = suit;
    if (drawnId !== undefined && t.id === drawnId) hand.appendChild(el("div", "drawn-gap"));
    const riichiLegal = !!(options && options.riichiLegalTileIds && options.riichiLegalTileIds.includes(t.id));
    const img = tileImg(t, { clickable: !!(options && options.onTileClick), riichiLegal });
    if (options && options.onTileClick) img.addEventListener("click", () => options.onTileClick(t, riichiLegal));
    hand.appendChild(img);
  }
}

/** Whose turn it currently is, from what the request itself says: my own actions are my turn;
 *  a ron/pon/daiminkan offer is on the seat that just discarded. */
function turnSeatOf(request) {
  if (request.type === "ron") return request.fromSeat;
  if ((request.type === "call_pon" || request.type === "call_daiminkan") && request.fromPlayer !== undefined) return request.fromPlayer;
  return request.view.seat;
}

/** Only my own turn's requests have a just-drawn tile to set apart in the hand. */
function drawnTileIdFor(request) {
  const ownTurn = ["discard", "kita", "ankan", "kakan", "nine_terminals"].includes(request.type);
  const tiles = request.view.concealedTiles;
  return ownTurn && tiles.length > 0 ? tiles[tiles.length - 1].id : undefined;
}

function clearActionBar() {
  document.getElementById("action-bar").innerHTML = "";
}

function addActionButton(label, onClick) {
  const bar = document.getElementById("action-bar");
  const btn = el("button");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  bar.appendChild(btn);
  return btn;
}

// --- Networking ---

async function sendResponse(response) {
  await fetch("/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  });
}

function renderDiscardRequest(request) {
  renderTable(request.view, turnSeatOf(request));

  const drawnId = drawnTileIdFor(request);

  renderMySeat(request.view, {
    drawnTileId: drawnId,
    riichiLegalTileIds: request.riichiLegalTileIds,
    onTileClick: (tile, riichiLegal) => {
      let declareRiichi = false;
      if (riichiLegal) {
        const tileName = koreanTileLabel(tile.kind, tile.red);
        declareRiichi = window.confirm(`${tileName}${josaEulReul(tileName)} 버리면서 리치를 선언할까요?\n(취소를 누르면 그냥 버립니다)`);
      }
      sendResponse({ type: "discard", tileId: tile.id, declareRiichi });
    },
  });

  clearActionBar();
  const label = el("span", "section-label");
  label.textContent = "버릴 패를 클릭하세요" + (request.riichiLegalTileIds.length > 0 ? " (노란 테두리 = 리치 가능)" : "");
  document.getElementById("action-bar").appendChild(label);
}

function renderCallRequest(request) {
  renderTable(request.view, turnSeatOf(request));
  const drawnId = drawnTileIdFor(request);
  renderMySeat(request.view, { drawnTileId: drawnId });

  clearActionBar();
  let promptText;
  if (request.type === "kita") {
    promptText = "북을 빼시겠습니까?";
  } else {
    const tileName = koreanTileLabel(request.tileKind);
    const verb = CALL_VERB[request.type];
    const fromClause = request.fromPlayer !== undefined
      ? ` (${displayNameForSeat(request.fromPlayer, request.view.seat)} 버림패)`
      : "";
    const josa = request.type === "call_pon" || request.type === "call_daiminkan" ? josaEulReul(tileName) : josaRo(tileName);
    promptText = `${tileName}${josa} ${verb} 하시겠습니까?${fromClause}`;
  }
  const label = el("span", "section-label");
  label.textContent = promptText;
  document.getElementById("action-bar").appendChild(label);
  addActionButton("예", () => sendResponse({ type: request.type, declare: true }));
  addActionButton("아니오", () => sendResponse({ type: request.type, declare: false }));
}

function renderNineTerminalsRequest(request) {
  renderTable(request.view, turnSeatOf(request));
  const drawnId = drawnTileIdFor(request);
  renderMySeat(request.view, { drawnTileId: drawnId });

  clearActionBar();
  const label = el("span", "section-label");
  label.textContent = `구종구패: 요구패가 ${request.distinctTerminalKinds}종 있습니다. 유국을 선언하시겠습니까?`;
  document.getElementById("action-bar").appendChild(label);
  addActionButton("유국 선언", () => sendResponse({ type: "nine_terminals", declare: true }));
  addActionButton("계속 진행", () => sendResponse({ type: "nine_terminals", declare: false }));
}

const RON_CONTEXT_KO = {
  discard: "버림패",
  riichi_discard: "리치 선언패",
  kita: "뽑은 북",
  chankan: "창깡",
  kokushi_ankan: "국사무쌍 암깡",
};

function renderRonRequest(request) {
  renderTable(request.view, turnSeatOf(request));
  const drawnId = drawnTileIdFor(request);
  renderMySeat(request.view, { drawnTileId: drawnId });

  clearActionBar();
  const bar = document.getElementById("action-bar");
  const preview = request.preview;
  const info = el("span", "ron-preview");
  const tileName = koreanTileLabel(request.winningTile.kind, request.winningTile.red);
  const from = displayNameForSeat(request.fromSeat, request.view.seat);
  const score = preview.yakumanUnits > 0
    ? (preview.yakumanUnits === 1 ? "역만" : `역만 x${preview.yakumanUnits}`)
    : `${preview.han}판 ${preview.fu}부`;
  info.appendChild(tileImg(request.winningTile, { small: true }));
  const text = el("span");
  text.textContent =
    `론 가능! ${from}의 ${RON_CONTEXT_KO[request.context] ?? request.context} ${tileName} - ${score} ${formatPoints(preview.totalPoints)}점 (` +
    preview.yaku.map((y) => `${translateYaku(y.name)} ${y.han}`).join(", ") + ")";
  info.appendChild(text);
  bar.appendChild(info);
  const ronBtn = addActionButton("론", () => sendResponse({ type: "ron", declare: true }));
  ronBtn.classList.add("ron-button");
  const passBtn = addActionButton("패스", () => sendResponse({ type: "ron", declare: false }));
  passBtn.title = "패스하면 후리텐이 됩니다";
}

// --- Hand-end result screen (human-readable overlay; raw JSON stays available only via
// the collapsed debug toggle and the browser/server console, never as the primary display). ---

function methodLabel(method) {
  return method === "tsumo" ? "쯔모" : "론";
}

function renderYakuList(yaku) {
  const list = el("ul", "yaku-list");
  for (const hit of yaku) {
    const li = el("li");
    const name = el("span");
    name.textContent = translateYaku(hit.name);
    const han = el("span");
    han.textContent = `${hit.han}판`;
    li.appendChild(name);
    li.appendChild(han);
    list.appendChild(li);
  }
  return list;
}

function renderScoreChanges(before, after, mySeat) {
  const wrap = el("div", "score-changes");
  const title = el("div", "section-label");
  title.textContent = "점수 변화";
  wrap.appendChild(title);
  for (let seat = 0; seat < after.length; seat++) {
    const delta = after[seat] - (before ? before[seat] : after[seat]);
    const row = el("div", "row");
    const name = el("span");
    name.textContent = displayNameForSeat(seat, mySeat);
    const value = el("span");
    const deltaText = before ? ` (${formatDelta(delta)})` : "";
    value.textContent = before
      ? `${formatPoints(before[seat])} → ${formatPoints(after[seat])}${deltaText}`
      : formatPoints(after[seat]);
    if (delta > 0) value.classList.add("delta-pos");
    if (delta < 0) value.classList.add("delta-neg");
    row.appendChild(name);
    row.appendChild(value);
    wrap.appendChild(row);
  }
  return wrap;
}

function nextHandLine(result) {
  if (!result) return null;
  const line = el("div", "next-hand");
  // Same wind and hand number as this hand = the dealer stays (연장): only the honba grows.
  const repeats = result.nextRoundWind === result.roundWind && result.nextRoundHandNumber === result.roundHandNumber;
  const round = `${ROUND_WIND_KO[result.nextRoundWind] ?? result.nextRoundWind}${result.nextRoundHandNumber}국`;
  line.textContent = `다음: ${round} ${result.honbaAfter}본장${repeats ? " (친 연장)" : ""}`;
  return line;
}

/** `isFinalHand`: true when this hand ended the game - suppresses the "다음: 동X국" line,
 *  since renderGameEnd() appends the actual final-standings section instead. */
function renderHandEndPanel(handEndEvent, mySeat, isFinalHand) {
  const panel = document.getElementById("hand-end-panel");
  panel.innerHTML = "";
  const result = handEndEvent.result;

  if (!result) {
    // Historical/Schema-v1-only records without the additive `result` snapshot: nothing
    // human-readable to build, fall back to the minimal scores/next-dealer fields.
    const h2 = el("h2");
    h2.textContent = "한 판이 끝났습니다";
    panel.appendChild(h2);
    panel.appendChild(renderScoreChanges(null, handEndEvent.scores, mySeat));
    panel.appendChild(document.createElement("hr"));
    return;
  }

  if (result.kind === "agari") {
    const h2 = el("h2");
    h2.textContent = "화료!";
    panel.appendChild(h2);

    for (const win of result.winners) {
      const headline = el("div", "result-headline");
      const winnerName = displayNameForSeat(win.winnerSeat, mySeat);
      const methodText = win.method === "ron" && win.loserSeat !== null
        ? `${methodLabel(win.method)} (${displayNameForSeat(win.loserSeat, mySeat)} 방총)`
        : methodLabel(win.method);
      headline.textContent = `${winnerName} · ${methodText}`;
      panel.appendChild(headline);

      // Prefer the Schema v2 snapshot's winningTile (carries `red`) when present; the base
      // AuditableWinResult.winningTile has no red-five flag, so a plain win still renders
      // correctly, just without the red-five distinction on this one tile.
      const winningTileRef = win.snapshot ? win.snapshot.winningTile : win.winningTile;
      const tileRow = el("div", "tile-row small win-tile-row");
      tileRow.appendChild(tileImg(winningTileRef, { small: true }));
      panel.appendChild(tileRow);

      const scoreLine = el("div", "result-headline");
      scoreLine.textContent = win.yakumanUnits > 0
        ? (win.yakumanUnits === 1 ? "역만" : `역만 x${win.yakumanUnits}`) + ` · ${formatPoints(win.totalPoints)}점`
        : `${win.han}판 ${win.fu}부 · ${formatPoints(win.totalPoints)}점`;
      panel.appendChild(scoreLine);

      panel.appendChild(renderYakuList(win.yaku));
    }

    panel.appendChild(renderScoreChanges(result.scoresBeforeSettlement, result.scoresAfterSettlement, mySeat));
    const next = isFinalHand ? null : nextHandLine(result);
    if (next) panel.appendChild(next);
  } else if (result.kind === "exhaustive_draw") {
    const h2 = el("h2");
    h2.textContent = "유국 (황패)";
    panel.appendChild(h2);

    const tenpai = el("div", "result-headline");
    tenpai.textContent = result.tenpaiSeats.length > 0
      ? `텐파이: ${result.tenpaiSeats.map((s) => displayNameForSeat(s, mySeat)).join(", ")}`
      : "텐파이 없음";
    panel.appendChild(tenpai);
    const noten = el("div", "result-headline");
    noten.textContent = result.notenSeats.length > 0
      ? `노텐: ${result.notenSeats.map((s) => displayNameForSeat(s, mySeat)).join(", ")}`
      : "노텐 없음";
    panel.appendChild(noten);
    if (result.nagashiManganSeats.length > 0) {
      const nagashi = el("div", "result-headline");
      nagashi.textContent = `유국만관: ${result.nagashiManganSeats.map((s) => displayNameForSeat(s, mySeat)).join(", ")}`;
      panel.appendChild(nagashi);
    }

    panel.appendChild(renderScoreChanges(result.scoresBeforeSettlement, result.scoresAfterSettlement, mySeat));
    const next = isFinalHand ? null : nextHandLine(result);
    if (next) panel.appendChild(next);
  } else if (result.kind === "abortive_draw") {
    const h2 = el("h2");
    h2.textContent = "유국";
    panel.appendChild(h2);
    const reason = el("div", "result-headline");
    reason.textContent = ABORTIVE_DRAW_KO[result.reason] ?? result.reason;
    panel.appendChild(reason);

    panel.appendChild(renderScoreChanges(result.scoresBeforeSettlement, result.scoresAfterSettlement, mySeat));
    const next = isFinalHand ? null : nextHandLine(result);
    if (next) panel.appendChild(next);
  }

  const toggle = el("div", "debug-toggle");
  toggle.textContent = "▸ 디버그: raw JSON 보기";
  const json = el("pre", "debug-json hidden");
  json.textContent = JSON.stringify(handEndEvent, null, 2);
  toggle.addEventListener("click", () => json.classList.toggle("hidden"));
  panel.appendChild(toggle);
  panel.appendChild(json);
}

async function postContinue() {
  await fetch("/continue", { method: "POST" });
}

function renderHandEnd(handEndEvent, mySeat) {
  console.log("[debug] hand_end event:", handEndEvent);
  renderHandEndPanel(handEndEvent, mySeat, false);
  const panel = document.getElementById("hand-end-panel");
  const continueBtn = el("button", "continue-button");
  continueBtn.textContent = "다음 국 시작";
  continueBtn.addEventListener("click", () => {
    continueBtn.disabled = true; // guards a double-click; server-side continueToNextHand() also rejects a second call
    postContinue();
  });
  panel.insertBefore(continueBtn, panel.firstChild.nextSibling); // right under the "화료!"/"유국" headline
  document.getElementById("hand-end-overlay").classList.remove("hidden");
  clearActionBar();
}

const GAME_END_REASON_KO = {
  length: "정규 국수 종료",
  extension_end: "연장 종료",
  tobi: "파산 (토비) 종료",
};

function renderGameEndExtra(gameEndEvent, mySeat) {
  const panel = document.getElementById("hand-end-panel");

  const hr = document.createElement("hr");
  panel.appendChild(hr);

  const h2 = el("h2");
  h2.textContent = "게임 종료";
  panel.appendChild(h2);

  const reason = el("div", "result-headline");
  reason.textContent = GAME_END_REASON_KO[gameEndEvent.reason] ?? gameEndEvent.reason;
  panel.appendChild(reason);

  const standings = [...gameEndEvent.finalScores.keys()].sort(
    (a, b) => gameEndEvent.finalScores[b] - gameEndEvent.finalScores[a]
  );
  const list = el("div", "score-changes");
  standings.forEach((seat, i) => {
    const row = el("div", "row");
    const name = el("span");
    name.textContent = `${i + 1}위 ${displayNameForSeat(seat, mySeat)}`;
    const value = el("span");
    value.textContent = formatPoints(gameEndEvent.finalScores[seat]);
    row.appendChild(name);
    row.appendChild(value);
    list.appendChild(row);
  });
  panel.appendChild(list);
}

function renderGameEnd(gameEndEvent, handEndEvent, mySeat) {
  console.log("[debug] game_end event:", gameEndEvent);
  if (handEndEvent) renderHandEndPanel(handEndEvent, mySeat, true);
  else document.getElementById("hand-end-panel").innerHTML = "";
  renderGameEndExtra(gameEndEvent, mySeat);
  document.getElementById("hand-end-overlay").classList.remove("hidden");
  clearActionBar();
}

// The human seat number, remembered from the last decision request - no more decision
// requests arrive once a hand or the game has ended, so hand_end/game_end can't read
// view.seat directly.
let lastKnownMySeat = 0;

function handleMessage(msg) {
  currentCharacterNames = msg.characterNames ?? [];
  if (msg.type === "game_end") {
    renderGameEnd(msg.event, msg.handEvent, lastKnownMySeat);
    return;
  }
  if (msg.type === "hand_end") {
    renderHandEnd(msg.event, lastKnownMySeat);
    return;
  }
  document.getElementById("hand-end-overlay").classList.add("hidden");
  const request = msg.request;
  lastKnownMySeat = request.view.seat;
  if (request.type === "discard") renderDiscardRequest(request);
  else if (request.type === "ron") renderRonRequest(request);
  else if (request.type === "nine_terminals") renderNineTerminalsRequest(request);
  else renderCallRequest(request);
}

const events = new EventSource("/events");
events.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
