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
      zone.appendChild(el("div", "waits hidden"));
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
  plate.classList.toggle("is-actor", !!extras.actor);

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
function renderTable(view, turnSeat, emphasis) {
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
      actor: !!emphasis && emphasis.actorSeat === seat,
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
    if (emphasis && emphasis.latestDiscardSeat === seat) {
      const last = wrap.querySelector(".river-row:last-child > :last-child");
      if (last) last.classList.add("latest");
    }
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
    // 엔진이 알려준 legalTileIds에 없는 패(예: 쿠이카에로 지금 못 버리는 패)는 누를 수 없다.
    const legal = !(options && options.legalTileIds) || options.legalTileIds.includes(t.id);
    const clickable = !!(options && options.onTileClick) && legal;
    const img = tileImg(t, { clickable, riichiLegal });
    if (options && options.legalTileIds && !legal) {
      img.classList.add("not-legal");
      img.title = `${img.title} - 지금은 버릴 수 없습니다`;
    }
    if (clickable) img.addEventListener("click", () => options.onTileClick(t, riichiLegal));
    // 리치 전 미리보기: 리치 가능한 패에 마우스를 올리면 그 패를 버린 뒤의 대기패를 보여준다 (엔진이 계산한 값)
    const previewWaits = riichiLegal ? waitsForTile(options.riichiWaits, t.id) : null;
    if (previewWaits) {
      img.addEventListener("mouseenter", () => showWaits(zone, "리치하면 대기", previewWaits, view.furiten));
      img.addEventListener("mouseleave", () => showHandStatus(zone, view));
    }
    hand.appendChild(img);
  }
  showHandStatus(zone, view);
}

/** 샹텐 문구: 엔진이 계산한 view.handStatus.shanten을 그대로 읽는다 (-1 = 화료형). */
function shantenLabel(shanten) {
  if (shanten < 0) return "화료형";
  if (shanten === 0) return "텐파이";
  return `${shanten}샹텐`;
}

/** 내 손 상태 줄: 샹텐 + (텐파이면) 대기패/미확인 장수/후리텐. 리치 여부와 무관하며 모두 엔진 계산 결과다. */
function showHandStatus(zone, view) {
  const status = view.handStatus;
  if (!status) {
    showWaits(zone, "대기", view.waits, view.furiten);
    return;
  }
  showWaits(zone, "대기", status.tenpaiWaits, view.furiten, shantenLabel(status.shanten));
}

function waitsForTile(riichiWaits, tileId) {
  const entry = (riichiWaits || []).find((w) => w.tileId === tileId);
  return entry ? entry.waits : null;
}

/** 대기패 줄: "[샹텐] 대기: [패] [패]". 후리텐이면 원인과 함께 표시한다 (view.furiten, 엔진이 계산한 값).
 *  `status`(샹텐 문구)가 있으면 대기가 없어도 그 문구만 보여주고, 둘 다 없으면 숨긴다. */
function showWaits(zone, label, waits, furiten, status) {
  const box = zone.querySelector(".waits");
  box.innerHTML = "";
  const hasWaits = !!waits && waits.length > 0;
  if (!hasWaits && !status) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  if (status) {
    const s = el("span", "hand-status");
    s.textContent = status;
    box.appendChild(s);
  }
  if (!hasWaits) return;
  const text = el("span", "waits-label");
  text.textContent = label + ":";
  box.appendChild(text);
  // 각 대기패 + 아직 보이지 않은 장수 (엔진이 공개 정보만으로 센 추정치, 실제 남은 장수가 아니다)
  for (const wait of waits) {
    const item = el("span", "wait-item");
    item.title = `아직 보이지 않은 ${koreanTileLabel(wait.kind)}: 최대 ${wait.unseenCount}장 (공개된 패 기준 추정)`;
    item.appendChild(tileImg({ kind: wait.kind }, { small: true }));
    const n = el("span", "wait-count");
    n.textContent = "×" + wait.unseenCount;
    item.appendChild(n);
    box.appendChild(item);
  }
  if (furiten && furiten.active) {
    const causes = [];
    if (furiten.selfDiscard) causes.push("자기 버림패");
    if (furiten.temporary) causes.push("일시");
    if (furiten.riichi) causes.push("리치 후");
    const badge = el("span", "furiten-badge");
    badge.textContent = "후리텐" + (causes.length ? " (" + causes.join(", ") + ")" : "");
    box.appendChild(badge);
  }
}

/** Whose turn it currently is, from what the request itself says: my own actions are my turn;
 *  a ron/pon/daiminkan offer is on the seat that just discarded. */
function turnSeatOf(request) {
  if (request.type === "ron" || request.type === "chi") return request.fromSeat;
  if ((request.type === "call_pon" || request.type === "call_daiminkan") && request.fromPlayer !== undefined) return request.fromPlayer;
  return request.view.seat;
}

/** Only my own turn's requests have a just-drawn tile to set apart in the hand. */
function drawnTileIdFor(request) {
  const ownTurn = ["discard", "kita", "ankan", "kakan", "nine_terminals", "tsumo"].includes(request.type);
  const tiles = request.view.concealedTiles;
  return ownTurn && tiles.length > 0 ? tiles[tiles.length - 1].id : undefined;
}

function clearActionBar() {
  document.getElementById("action-bar").innerHTML = "";
}

/** kind: "confirm"(기본) 또는 "cancel" - 눌렀을 때 나는 UI 소리를 정한다. */
function addActionButton(label, onClick, kind = "confirm") {
  const bar = document.getElementById("action-bar");
  const btn = el("button");
  btn.textContent = label;
  btn.addEventListener("click", () => {
    AudioManager.play(kind === "cancel" ? "ui.cancel" : "ui.confirm");
    onClick();
  });
  bar.appendChild(btn);
  return btn;
}

// --- Networking ---

// 응답을 보낸 뒤 서버의 다음 메시지가 올 때까지는 더블클릭 등으로 또 보내지 않는다.
let awaitingServer = false;

function showActionError(text) {
  const bar = document.getElementById("action-bar");
  const note = el("span", "action-error");
  note.textContent = text;
  bar.appendChild(note);
  placeActionBar();
}

async function sendResponse(response) {
  if (awaitingServer) return;
  awaitingServer = true;
  try {
    const res = await fetch("/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    });
    if (!res.ok) {
      // 거절된 응답은 게임 상태를 바꾸지 않으므로 다시 시도할 수 있게 풀어 준다.
      awaitingServer = false;
      showActionError(`응답이 거절되었습니다: ${await res.text()}`);
    }
  } catch (err) {
    awaitingServer = false;
    showActionError("서버에 연결하지 못했습니다. 새로고침 후 다시 시도해 주세요.");
  }
}

function renderDiscardRequest(request) {
  renderTable(request.view, turnSeatOf(request));

  const drawnId = drawnTileIdFor(request);

  renderMySeat(request.view, {
    drawnTileId: drawnId,
    riichiLegalTileIds: request.riichiLegalTileIds,
    riichiWaits: request.riichiWaits,
    legalTileIds: request.legalTileIds,
    onTileClick: (tile, riichiLegal) => {
      let declareRiichi = false;
      if (riichiLegal) {
        const tileName = koreanTileLabel(tile.kind, tile.red);
        const waits = waitsForTile(request.riichiWaits, tile.id);
        const waitText = waits && waits.length ? "\n대기: " + waits.map((w) => `${koreanTileLabel(w.kind)} ×${w.unseenCount}`).join(" / ") : "";
        declareRiichi = window.confirm(`${tileName}${josaEulReul(tileName)} 버리면서 리치를 선언할까요?${waitText}\n(취소를 누르면 그냥 버립니다)`);
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
  addActionButton("아니오", () => sendResponse({ type: request.type, declare: false }), "cancel");
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
  addActionButton("계속 진행", () => sendResponse({ type: "nine_terminals", declare: false }), "cancel");
}

const RON_CONTEXT_KO = {
  discard: "버림패",
  riichi_discard: "리치 선언패",
  kita: "뽑은 북",
  chankan: "창깡",
  kokushi_ankan: "국사무쌍 암깡",
};

/** 치: 엔진이 준 options를 그대로 타일 그림으로 보여준다 (조합은 계산하지 않는다). 버림패는 강조 표시. */
function renderChiRequest(request) {
  renderTable(request.view, turnSeatOf(request), { actorSeat: null, latestDiscardSeat: request.fromSeat });
  renderMySeat(request.view, {});

  clearActionBar();
  const bar = document.getElementById("action-bar");
  const label = el("span", "section-label");
  const called = koreanTileLabel(request.discardedTile.kind, request.discardedTile.red);
  label.textContent = `${called}${josaEulReul(called)} 치하시겠습니까? (${displayNameForSeat(request.fromSeat, request.view.seat)} 버림패)`;
  bar.appendChild(label);

  for (const option of request.options) {
    const btn = el("button", "chi-option");
    let calledMarked = false;
    for (const kind of option.sequence) {
      const isCalled = !calledMarked && kind === request.discardedTile.kind;
      if (isCalled) calledMarked = true;
      const img = tileImg(isCalled ? request.discardedTile : { kind }, { small: true });
      if (isCalled) img.classList.add("called-tile");
      btn.appendChild(img);
    }
    btn.title = option.sequence.map((kind) => koreanTileLabel(kind)).join(" ");
    btn.addEventListener("click", () => {
      AudioManager.play("ui.confirm");
      sendResponse({ type: "chi", optionId: option.id });
    });
    bar.appendChild(btn);
  }
  addActionButton("넘기기", () => sendResponse({ type: "chi", optionId: null }), "cancel");
}

/** 쯔모: 화료 가능 여부와 점수는 엔진이 준 preview를 그대로 보여준다. 넘기면 바로 버릴 패 선택으로 이어진다. */
function renderTsumoRequest(request) {
  renderTable(request.view, request.view.seat);
  renderMySeat(request.view, { drawnTileId: drawnTileIdFor(request) });

  clearActionBar();
  const bar = document.getElementById("action-bar");
  const preview = request.preview;
  const info = el("span", "ron-preview");
  info.appendChild(tileImg(request.winningTile, { small: true }));
  const text = el("span");
  const score = preview.yakumanUnits > 0
    ? (preview.yakumanUnits === 1 ? "역만" : `역만 x${preview.yakumanUnits}`)
    : `${preview.han}판 ${preview.fu}부`;
  text.textContent =
    `쯔모할 수 있습니다 - ${score} ${formatPoints(preview.totalPoints)}점 (` +
    preview.yaku.map((y) => `${translateYaku(y.name)} ${y.han}`).join(", ") + ")";
  info.appendChild(text);
  bar.appendChild(info);
  const btn = addActionButton("쯔모", () => sendResponse({ type: "tsumo", declare: true }));
  btn.classList.add("ron-button");
  addActionButton("넘기기", () => sendResponse({ type: "tsumo", declare: false }), "cancel");
}

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
  const passBtn = addActionButton("패스", () => sendResponse({ type: "ron", declare: false }), "cancel");
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

// --- 화료 결과 상세: hand_end.result의 엔진 값(스냅샷, 도라 내역, 판/부/점수)을 그대로 표시한다. 새로 계산하지 않는다. ---

/** 엔진 basePoints(score.ts)에 붙는 등급 이름. 판수로 추정하지 않고 엔진이 정한 기본점 값에만 대응한다. */
const LIMIT_NAME_BY_BASE = { 2000: "만관", 3000: "하네만", 4000: "배만", 6000: "삼배만" };

function limitNameOf(win) {
  if (win.yakumanUnits > 0) return win.yakumanUnits === 1 ? "역만" : `${win.yakumanUnits}배 역만`;
  return LIMIT_NAME_BY_BASE[win.basePoints] ?? null;
}

/** 도라 출처별 판수 (doraBreakdown.sources의 matchedTileIds 수). 표도라와 깡도라는 "도라"로 합친다. */
const DORA_SOURCE_LABEL = { omote: "도라", kan: "도라", aka: "아카도라", ura: "우라도라", kita: "북도라" };
const DORA_SOURCE_ORDER = ["도라", "아카도라", "우라도라", "북도라"];

function doraLines(breakdown) {
  const han = {};
  for (const src of breakdown.sources) {
    const label = DORA_SOURCE_LABEL[src.type];
    if (!label) continue;
    han[label] = (han[label] ?? 0) + src.matchedTileIds.length;
  }
  return DORA_SOURCE_ORDER.filter((label) => han[label] > 0).map((label) => ({ name: label, han: han[label] }));
}

/** 역 목록. 도라 내역이 있으면 "Dora" 한 줄을 출처별 줄로 나눈다 (합계는 엔진 기록상 같다). */
function renderWinYakuList(win) {
  if (!win.doraBreakdown) return renderYakuList(win.yaku);
  const rows = [];
  for (const hit of win.yaku) {
    if (hit.name === "Dora") rows.push(...doraLines(win.doraBreakdown).map((d) => ({ label: d.name, han: d.han })));
    else rows.push({ label: translateYaku(hit.name), han: hit.han });
  }
  const list = el("ul", "yaku-list");
  for (const row of rows) {
    const li = el("li");
    const name = el("span");
    name.textContent = row.label;
    const han = el("span");
    han.textContent = `${row.han}판`;
    li.append(name, han);
    list.appendChild(li);
  }
  return list;
}

/** 화료 순간의 손패: 손패(정렬) · 화료패(떼어서) · 멘츠 · 북. 쯔모면 스냅샷 손패에 화료패가 들어 있으므로 id로 뺀다. */
function renderWinningHand(win, playerCount) {
  const snap = win.snapshot;
  const row = el("div", "win-hand");
  const concealed = snap.concealedTiles.filter((t) => t.id !== snap.winningTile.id).sort(compareTilesForDisplay);
  const tiles = el("div", "win-hand-tiles");
  for (const t of concealed) tiles.appendChild(tileImg(t, { small: true }));
  const winTile = el("div", "win-hand-agari");
  winTile.appendChild(tileImg(snap.winningTile, { small: true }));
  row.append(tiles, winTile);
  for (const m of snap.melds) row.appendChild(renderMeldGroup(m, win.winnerSeat, playerCount));
  if (snap.kitaTiles.length > 0) {
    const kita = el("div", "win-hand-kita");
    const label = el("span", "meld-label");
    label.textContent = "북";
    kita.appendChild(label);
    for (const t of snap.kitaTiles) kita.appendChild(tileImg(t, { small: true }));
    row.appendChild(kita);
  }
  return row;
}

/** 도라 표시패 줄 (표도라+깡도라, 우라도라). 도라 내역이 없는 옛 기록이면 null. */
function renderDoraIndicators(win) {
  if (!win.doraBreakdown) return null;
  const groups = [
    ["도라 표시패", win.doraBreakdown.sources.filter((s) => s.type === "omote" || s.type === "kan")],
    ["우라도라 표시패", win.doraBreakdown.sources.filter((s) => s.type === "ura")],
  ];
  const wrap = el("div", "win-dora");
  for (const [label, sources] of groups) {
    if (sources.length === 0) continue;
    const line = el("div", "win-dora-line");
    const text = el("span", "section-label");
    text.textContent = label;
    line.appendChild(text);
    for (const s of sources) line.appendChild(tileImg(s.indicator, { small: true }));
    wrap.appendChild(line);
  }
  return wrap.childElementCount > 0 ? wrap : null;
}

/** 한 화료의 표시 구획들 (위에서 아래로 읽는 순서). */
function renderWinDetail(win, mySeat, playerCount) {
  const sections = [];

  const headline = el("div", "result-headline win-headline");
  const who = el("span", "win-who");
  who.textContent = displayNameForSeat(win.winnerSeat, mySeat);
  headline.appendChild(who);
  if (win.isDealer) {
    const dealer = el("span", "win-dealer");
    dealer.textContent = "친";
    headline.appendChild(dealer);
  }
  const how = el("span", "win-method");
  how.textContent = win.method === "ron" && win.loserSeat !== null
    ? ` · ${methodLabel(win.method)} (${displayNameForSeat(win.loserSeat, mySeat)} 방총)`
    : ` · ${methodLabel(win.method)}`;
  headline.appendChild(how);
  sections.push(headline);

  if (win.snapshot) {
    sections.push(renderWinningHand(win, playerCount));
  } else {
    // 스냅샷이 없는 옛 기록: 화료패 한 장만 보여준다 (빨간 5 구분 없음)
    const tileRow = el("div", "tile-row small win-tile-row");
    tileRow.appendChild(tileImg(win.winningTile, { small: true }));
    sections.push(tileRow);
  }

  const dora = renderDoraIndicators(win);
  if (dora) sections.push(dora);

  sections.push(renderWinYakuList(win));

  const score = el("div", "win-score");
  const limit = limitNameOf(win);
  const parts = [];
  if (win.yakumanUnits === 0) parts.push(limit ? `${win.han}판` : `${win.han}판 ${win.fu}부`);
  if (limit) parts.push(limit);
  const detail = el("span", "win-score-detail");
  detail.textContent = parts.join(" · ");
  const points = el("span", "win-score-points");
  points.textContent = `${formatPoints(win.totalPoints)}점`;
  score.append(detail, points);
  sections.push(score);

  return sections;
}

/** 본장/공탁 줄 (있을 때만). 값은 hand_end.result의 엔진 기록 그대로다. */
function renderHonbaKyotaku(result, mySeat) {
  const parts = [];
  if (result.honbaBefore > 0) parts.push(`${result.honbaBefore}본장`);
  if (result.kyotakuAwarded > 0 && result.kyotakuRecipient !== null) {
    parts.push(`공탁 ${formatPoints(result.kyotakuAwarded)}점 → ${displayNameForSeat(result.kyotakuRecipient, mySeat)}`);
  }
  if (parts.length === 0) return null;
  const line = el("div", "win-extras");
  line.textContent = parts.join(" · ");
  return line;
}

/** 결과 패널의 구획을 위에서부터 짧은 간격으로 차례로 보여준다 (전체 1초 이내). 패널을 누르면 바로 전부 보인다.
 *  이후에 끼워 넣는 버튼(다음 국 시작 등)은 대상이 아니라 처음부터 보인다. */
const REVEAL_STEP_MS = 80;
const REVEAL_MAX_ITEMS = 10;

function startResultReveal(panel) {
  panel.classList.remove("reveal-done");
  panel.classList.add("revealing");
  [...panel.children].forEach((child, i) => {
    child.classList.add("reveal");
    child.style.setProperty("--reveal-delay", `${Math.min(i, REVEAL_MAX_ITEMS) * REVEAL_STEP_MS}ms`);
  });
  panel.onclick = () => panel.classList.add("reveal-done");
}

/** `isFinalHand`: true when this hand ended the game - suppresses the "다음: 동X국" line,
 *  since the game-end flow shows the final-result step (renderFinalResultStep) next instead. */
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

    const playerCount = result.scoresAfterSettlement.length;
    for (const win of result.winners) {
      for (const section of renderWinDetail(win, mySeat, playerCount)) panel.appendChild(section);
    }
    const extras = renderHonbaKyotaku(result, mySeat);
    if (extras) panel.appendChild(extras);

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
  startResultReveal(panel);
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
    AudioManager.play("ui.confirm");
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

const MODE_KO = { sanma: "산마", yonma: "4마" };

function formatPt(points) {
  const text = Math.abs(points).toFixed(1);
  if (points > 0) return `+${text}`;
  if (points < 0) return `-${text}`;
  return "±0.0";
}

/** 게임 종료 상태: 마지막 국 결과를 먼저 보여주고, "최종 결과 보기"로 최종 결과 화면에 넘어간다. */
let gameEndState = null;

function renderGameEnd(msg, mySeat) {
  console.log("[debug] game_end event:", msg.event);
  gameEndState = { msg, mySeat, pending: false, error: "" };
  if (msg.handEvent) renderFinalHandStep();
  else renderFinalResultStep();
  document.getElementById("hand-end-overlay").classList.remove("hidden");
  clearActionBar();
}

function renderFinalHandStep() {
  const { msg, mySeat } = gameEndState;
  renderHandEndPanel(msg.handEvent, mySeat, true);
  const panel = document.getElementById("hand-end-panel");
  const btn = el("button", "continue-button");
  btn.textContent = "최종 결과 보기";
  btn.addEventListener("click", () => {
    AudioManager.play("ui.confirm");
    renderFinalResultStep();
  });
  panel.insertBefore(btn, panel.firstChild.nextSibling);
}

function renderFinalStandings(standings, gameEndEvent, mySeat) {
  const table = el("table", "final-standings");
  const thead = el("thead");
  const headRow = el("tr");
  for (const [text, cls] of [["순위", "col-rank"], ["이름", "col-name"], ["점수", "col-score"], ["pt", "col-pt"]]) {
    const th = el("th", cls, { scope: "col" });
    th.textContent = text;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  const tbody = el("tbody");
  for (const s of standings) {
    const tr = el("tr", s.player === mySeat ? "is-me" : "");
    const rank = el("td", "col-rank");
    rank.textContent = `${s.placement}위`;
    const name = el("td", "col-name");
    name.textContent = displayNameForSeat(s.player, mySeat);
    if (gameEndEvent.eliminatedPlayers.includes(s.player)) {
      const badge = el("span", "standing-badge");
      badge.textContent = "토비";
      name.appendChild(badge);
    }
    const score = el("td", "col-score");
    score.textContent = formatPoints(s.rawScore);
    const pt = el("td", "col-pt");
    pt.textContent = formatPt(s.points);
    tr.append(rank, name, score, pt);
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  return table;
}

async function restartGame(body) {
  if (gameEndState.pending) return;
  AudioManager.play("ui.confirm");
  gameEndState.pending = true;
  gameEndState.error = "";
  renderFinalResultStep();
  try {
    const res = await fetch("/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    // 성공하면 서버가 새 게임의 첫 상태를 보내며 이 화면이 닫힌다.
  } catch (err) {
    gameEndState.pending = false;
    gameEndState.error = err instanceof Error ? err.message : String(err);
    renderFinalResultStep();
  }
}

function renderFinalResultStep() {
  const { msg, mySeat, pending, error } = gameEndState;
  const panel = document.getElementById("hand-end-panel");
  panel.innerHTML = "";

  const h2 = el("h2");
  h2.textContent = "최종 결과";
  panel.appendChild(h2);

  const meta = el("div", "result-headline final-meta");
  const parts = [GAME_END_REASON_KO[msg.event.reason] ?? msg.event.reason];
  if (msg.gameConfig) parts.unshift(MODE_KO[msg.gameConfig.mode] ?? msg.gameConfig.mode);
  meta.textContent = parts.join(" · ");
  panel.appendChild(meta);

  panel.appendChild(renderFinalStandings(msg.standings, msg.event, mySeat));

  if (msg.gameConfig) {
    const seed = el("div", "final-seed");
    const label = el("span", "final-seed-label");
    label.textContent = "시드";
    const value = el("code");
    value.textContent = msg.gameConfig.seed;
    seed.append(label, value);
    panel.appendChild(seed);
  }

  if (msg.canStartNewGame && msg.gameConfig) {
    const cfg = msg.gameConfig;
    const actions = el("div", "final-actions");
    const same = el("button", "continue-button");
    same.textContent = pending ? "시작하는 중..." : "같은 설정으로 다시";
    same.title = "같은 모드와 상대, 새 시드";
    same.addEventListener("click", () => restartGame({ mode: cfg.mode, opponents: cfg.opponents, saveReplays: cfg.saveReplays }));
    const sameSeed = el("button", "secondary-button");
    sameSeed.textContent = "같은 시드로 다시";
    sameSeed.title = "같은 모드와 상대, 같은 시드";
    sameSeed.addEventListener("click", () => restartGame({ mode: cfg.mode, opponents: cfg.opponents, seed: cfg.seed, saveReplays: cfg.saveReplays }));
    const change = el("button", "secondary-button");
    change.textContent = "설정 바꾸기";
    change.addEventListener("click", () => {
      AudioManager.play("ui.confirm");
      gameEndState.pending = true;
      renderFinalResultStep();
      fetch("/setup", { method: "POST" });
    });
    for (const b of [same, sameSeed, change]) b.disabled = pending;
    actions.append(same, sameSeed, change);
    panel.appendChild(actions);
    if (error) {
      const err = el("p", "final-error", { role: "alert" });
      err.textContent = error;
      panel.appendChild(err);
    }
  }

  if (msg.handEvent) {
    const back = el("button", "link-button");
    back.textContent = "마지막 국 결과 다시 보기";
    back.addEventListener("click", renderFinalHandStep);
    panel.appendChild(back);
  }
}

// The human seat number, remembered from the last decision request - no more decision
// requests arrive once a hand or the game has ended, so hand_end/game_end can't read
// view.seat directly.
let lastKnownMySeat = 0;

/** 행동창을 내 손패 위 이름표 줄 바로 위에 붙인다 - 시선 이동이 짧도록 실제 위치를 측정해 맞춘다. */
function placeActionBar() {
  const info = document.querySelector("#zone-bottom .zone-info");
  const bar = document.getElementById("action-bar");
  if (!info || !bar) return;
  bar.style.bottom = Math.max(0, window.innerHeight - info.getBoundingClientRect().top + 6) + "px";
}

window.addEventListener("resize", placeActionBar);
AudioManager.mountControls();

// --- AI 진행 속도: 서버가 이미 계산된 AI 장면을 보내는 간격만 바꾼다 (게임 진행/결과와 무관).
// 선택값은 이 브라우저에만 저장하고, 접속할 때 서버에 알린다. ---

const SPEED_STORAGE_KEY = "seongah.playbackSpeed";
const SPEED_VALUES = ["slow", "normal", "fast", "instant"];

function loadSpeed() {
  try {
    const v = localStorage.getItem(SPEED_STORAGE_KEY);
    return SPEED_VALUES.includes(v) ? v : null;
  } catch {
    return null;
  }
}

function saveSpeed(v) {
  try {
    localStorage.setItem(SPEED_STORAGE_KEY, v);
  } catch {
    // 저장소를 못 쓰는 환경이면 이번 접속에서만 유지된다
  }
}

function postSpeed(v) {
  fetch("/speed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speed: v }) });
}

function mountSpeedControl() {
  const select = document.querySelector("#audio-controls .speed-select");
  if (!select) return;
  const stored = loadSpeed();
  select.value = stored ?? "normal";
  if (stored) postSpeed(stored);
  select.addEventListener("change", () => {
    saveSpeed(select.value);
    postSpeed(select.value);
  });
}

mountSpeedControl();

function handleMessage(msg) {
  handleMessageBody(msg);
  // 접속 직후 메시지의 cueBase 이하는 과거 신호라 재생하지 않는다.
  AudioManager.setBase(msg.cueBase);
  AudioManager.enqueueCues(msg.cues);
}

// --- 시작 화면 (대국 설정): 모드, 상대 좌석, 시드를 고른다. 캐릭터 정보는 서버의 roster를 그대로 쓴다.
// 카드는 이름 · 플레이 경향 한 줄 · 짧은 태그만으로 완성된 형태다. roster 항목의 portrait는 선택 필드로, 아직 어느
// 캐릭터에도 없으며 이 화면은 그 필드를 읽지 않는다 (초상화가 제공되면 카드 레이아웃을 그때 확장한다).

const SORT_OPTIONS = [
  ["registered", "등록순"],
  ["name", "이름순"],
];

const MODE_OPTIONS = [
  ["sanma", "산마", "3인"],
  ["yonma", "4마", "4인"],
];

let setupState = null;

/** 상대 좌석 i(0부터, seat i+1)의 자리 이름: 다음 차례가 하가, 이전 차례가 상가, 4인의 맞은편이 대면. */
function opponentSeatLabel(index, playerCount) {
  const seat = index + 1;
  if (seat === 1) return "하가";
  if (seat === playerCount - 1) return "상가";
  return "대면";
}

function initSetupState(msg) {
  const keepUi = setupState ? { activeSlot: 0, sort: setupState.sort } : { activeSlot: 0, sort: "registered" };
  setupState = {
    roster: msg.roster,
    playerCounts: msg.playerCounts,
    mode: msg.defaults.mode,
    opponents: { sanma: [...msg.defaults.opponents.sanma], yonma: [...msg.defaults.opponents.yonma] },
    seed: msg.defaults.seed,
    saveReplays: msg.defaults.saveReplays,
    pending: false,
    error: "",
    ...keepUi,
  };
}

function rosterEntry(characterId) {
  return setupState.roster.find((c) => c.characterId === characterId) ?? null;
}

function currentOpponents() {
  return setupState.opponents[setupState.mode];
}

/** 활성 좌석에 캐릭터를 앉힌다. 이미 다른 좌석에 있으면 두 좌석을 맞바꾼다. */
function assignToActiveSlot(characterId) {
  const opponents = currentOpponents();
  const slot = setupState.activeSlot;
  const existing = opponents.indexOf(characterId);
  if (existing === slot) return;
  if (existing >= 0) opponents[existing] = opponents[slot];
  opponents[slot] = characterId;
}

function randomizeOpponents() {
  const pool = setupState.roster.map((c) => c.characterId);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  setupState.opponents[setupState.mode] = pool.slice(0, currentOpponents().length);
}

function sortedRoster() {
  const list = [...setupState.roster];
  const key = setupState.sort;
  if (key === "name") list.sort((a, b) => a.displayName.localeCompare(b.displayName, "ko"));
  return list;
}

function renderSetupModeGroup() {
  const group = el("div", "setup-segmented", { role: "radiogroup", "aria-label": "규칙" });
  for (const [mode, label, sub] of MODE_OPTIONS) {
    const btn = el("button", "setup-segment", { type: "button", role: "radio", "aria-checked": String(setupState.mode === mode) });
    const main = el("span", "segment-main");
    main.textContent = label;
    const small = el("span", "segment-sub");
    small.textContent = sub;
    btn.append(main, small);
    btn.addEventListener("click", () => {
      if (setupState.mode === mode) return;
      setupState.mode = mode;
      setupState.activeSlot = 0;
      renderSetup();
    });
    group.appendChild(btn);
  }
  return group;
}

function renderSetupSeats() {
  const list = el("ol", "setup-seats");
  const me = el("li", "setup-seat is-me");
  const meWhere = el("span", "seat-where");
  meWhere.textContent = "나";
  const meName = el("span", "seat-name");
  meName.textContent = "플레이어";
  me.append(meWhere, meName);
  list.appendChild(me);

  const opponents = currentOpponents();
  const n = setupState.playerCounts[setupState.mode];
  opponents.forEach((id, i) => {
    const entry = rosterEntry(id);
    const li = el("li");
    const btn = el("button", "setup-seat" + (i === setupState.activeSlot ? " is-active" : ""), { type: "button", "aria-pressed": String(i === setupState.activeSlot) });
    const where = el("span", "seat-where");
    where.textContent = opponentSeatLabel(i, n);
    const name = el("span", "seat-name");
    name.textContent = entry ? entry.displayName : id;
    const tagLine = el("span", "seat-tags");
    tagLine.textContent = entry ? entry.tags.join(" · ") : "";
    btn.append(where, name, tagLine);
    btn.addEventListener("click", () => {
      setupState.activeSlot = i;
      renderSetup();
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
  return list;
}

function renderCharacterCard(entry) {
  const opponents = currentOpponents();
  const n = setupState.playerCounts[setupState.mode];
  const seatIndex = opponents.indexOf(entry.characterId);
  const card = el("button", "character-card" + (seatIndex >= 0 ? " is-seated" : ""), { type: "button" });

  const head = el("div", "card-head");
  const name = el("span", "card-name");
  name.textContent = entry.displayName;
  head.appendChild(name);
  if (seatIndex >= 0) {
    const tag = el("span", "card-seat");
    tag.textContent = opponentSeatLabel(seatIndex, n);
    head.appendChild(tag);
  }
  const summary = el("p", "card-summary");
  summary.textContent = entry.summary;

  const tags = el("ul", "card-tags");
  for (const text of entry.tags) {
    const li = el("li");
    li.textContent = text;
    tags.appendChild(li);
  }

  card.append(head);
  if (entry.summary) card.appendChild(summary);
  if (entry.tags.length > 0) card.appendChild(tags);
  card.setAttribute("aria-label", `${entry.displayName}. ${entry.summary} ${entry.tags.join(", ")}`);
  card.addEventListener("click", () => {
    assignToActiveSlot(entry.characterId);
    renderSetup();
  });
  return card;
}

function setupSection(title, ...children) {
  const section = el("section", "setup-section");
  const h = el("h2", "setup-heading");
  h.textContent = title;
  section.append(h, ...children);
  return section;
}

function renderSetup() {
  const root = document.getElementById("setup-screen");
  const scrollTop = root.querySelector(".setup-roster-list")?.scrollTop ?? 0;
  root.innerHTML = "";

  const layout = el("div", "setup-layout");

  // 왼쪽(좁은 화면에서는 위): 규칙, 좌석, 옵션, 시작
  const side = el("aside", "setup-side");
  const header = el("header", "setup-header");
  const h1 = el("h1");
  h1.textContent = "새 대국";
  const lead = el("p", "setup-lead");
  lead.textContent = "좌석을 고르고 캐릭터를 눌러 앉힙니다. 같은 캐릭터는 한 좌석에만 앉을 수 있습니다.";
  header.append(h1, lead);
  side.appendChild(header);

  side.appendChild(setupSection("규칙", renderSetupModeGroup()));

  const randomBtn = el("button", "setup-link-button", { type: "button" });
  randomBtn.textContent = "무작위로 채우기";
  randomBtn.addEventListener("click", () => {
    randomizeOpponents();
    renderSetup();
  });
  side.appendChild(setupSection("좌석", renderSetupSeats(), randomBtn));

  const seedLabel = el("label", "setup-field");
  const seedText = el("span", "field-label");
  seedText.textContent = "시드";
  const seedInput = el("input", "setup-input", { type: "text", maxlength: "100", placeholder: "비워 두면 무작위", spellcheck: "false" });
  seedInput.value = setupState.seed;
  seedInput.addEventListener("input", () => (setupState.seed = seedInput.value));
  seedLabel.append(seedText, seedInput);

  const replayLabel = el("label", "setup-check");
  const replayInput = el("input", "", { type: "checkbox" });
  replayInput.checked = setupState.saveReplays;
  replayInput.addEventListener("change", () => (setupState.saveReplays = replayInput.checked));
  const replayText = el("span");
  replayText.textContent = "게임이 끝나면 리플레이 저장";
  replayLabel.append(replayInput, replayText);
  side.appendChild(setupSection("옵션", seedLabel, replayLabel));

  const start = el("button", "setup-start", { type: "button" });
  start.textContent = setupState.pending ? "시작하는 중..." : "대국 시작";
  start.disabled = setupState.pending;
  start.addEventListener("click", startGameFromSetup);
  side.appendChild(start);
  if (setupState.error) {
    const err = el("p", "setup-error", { role: "alert" });
    err.textContent = setupState.error;
    side.appendChild(err);
  }

  // 오른쪽: 캐릭터 목록
  const rosterPane = el("section", "setup-roster");
  const rosterHead = el("div", "setup-roster-head");
  const rh = el("h2", "setup-heading");
  const n = setupState.playerCounts[setupState.mode];
  rh.textContent = `캐릭터 ${setupState.roster.length}명`;
  const target = el("span", "setup-roster-target");
  target.textContent = `${opponentSeatLabel(setupState.activeSlot, n)} 좌석에 앉힐 캐릭터`;
  const sort = el("select", "setup-select", { "aria-label": "정렬" });
  for (const [value, label] of SORT_OPTIONS) {
    const opt = el("option", "", { value });
    opt.textContent = label;
    if (value === setupState.sort) opt.selected = true;
    sort.appendChild(opt);
  }
  sort.addEventListener("change", () => {
    setupState.sort = sort.value;
    renderSetup();
  });
  const titleWrap = el("div", "setup-roster-title");
  titleWrap.append(rh, target);
  rosterHead.append(titleWrap, sort);

  const grid = el("div", "setup-roster-list");
  for (const entry of sortedRoster()) grid.appendChild(renderCharacterCard(entry));
  rosterPane.append(rosterHead, grid);

  layout.append(side, rosterPane);
  root.appendChild(layout);
  grid.scrollTop = scrollTop;
}

async function startGameFromSetup() {
  if (!setupState || setupState.pending) return;
  AudioManager.play("ui.confirm");
  setupState.pending = true;
  setupState.error = "";
  renderSetup();
  const body = {
    mode: setupState.mode,
    opponents: currentOpponents(),
    seed: setupState.seed,
    saveReplays: setupState.saveReplays,
  };
  try {
    const res = await fetch("/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    // 성공하면 서버가 첫 상태를 보내며, 그 메시지가 시작 화면을 닫는다.
  } catch (err) {
    setupState.pending = false;
    setupState.error = err instanceof Error ? err.message : String(err);
    renderSetup();
  }
}

function showSetup(msg) {
  initSetupState(msg);
  document.body.classList.add("is-setup");
  document.getElementById("hand-end-overlay").classList.add("hidden");
  document.getElementById("setup-screen").classList.remove("hidden");
  clearActionBar();
  clearRecentFeed();
  AudioManager.reset(); // 다음 게임의 효과음 seq는 1부터 다시 시작한다
  renderSetup();
}

function hideSetup() {
  if (!document.body.classList.contains("is-setup")) return;
  document.body.classList.remove("is-setup");
  document.getElementById("setup-screen").classList.add("hidden");
  if (setupState) setupState.pending = false;
}

const FEED_TEXT = { discard: "타패", chi: "치", pon: "퐁", kan: "깡", kita: "북 빼기", riichi: "리치", ron: "론", tsumo: "쯔모" };
const FEED_MAX = 5;
let recentFeed = [];

function pushRecentFeed(actions, mySeat) {
  for (const a of actions) {
    const who = displayNameForSeat(a.seat, mySeat);
    const what = a.action === "discard" ? `${koreanTileLabel(a.tile)} 타패` : a.tile ? `${koreanTileLabel(a.tile)} ${FEED_TEXT[a.action]}` : FEED_TEXT[a.action];
    recentFeed.push({ text: `${who}: ${what}`, win: a.action === "ron" || a.action === "tsumo" });
  }
  recentFeed = recentFeed.slice(-FEED_MAX);
  const box = document.getElementById("recent-feed");
  box.innerHTML = "";
  for (const item of recentFeed) {
    const row = el("div", "feed-item" + (item.win ? " is-win" : ""));
    row.textContent = item.text;
    box.appendChild(row);
  }
  box.classList.toggle("hidden", recentFeed.length === 0);
}

function clearRecentFeed() {
  recentFeed = [];
  const box = document.getElementById("recent-feed");
  box.innerHTML = "";
  box.classList.add("hidden");
}

function handleMessageBody(msg) {
  awaitingServer = false; // 서버가 새 상태를 보냈으니 다음 응답을 보낼 수 있다
  if (msg.type === "setup") {
    showSetup(msg);
    return;
  }
  hideSetup();
  currentCharacterNames = msg.characterNames ?? [];
  if (msg.type === "hand_end" || msg.type === "game_end") clearRecentFeed();
  if (msg.type === "watch") {
    // AI 턴 진행 장면: 판을 그리되 행동창은 비운다 (아직 내가 할 일이 없다)
    document.getElementById("hand-end-overlay").classList.add("hidden");
    lastKnownMySeat = msg.view.seat;
    const calledAway = msg.actions.some((a) => a.action === "pon" || a.action === "kan");
    renderTable(msg.view, msg.actor, { actorSeat: msg.actor, latestDiscardSeat: calledAway ? null : msg.latestDiscardSeat });
    pushRecentFeed(msg.actions, msg.view.seat);
    renderMySeat(msg.view, {});
    clearActionBar();
    const label = el("span", "section-label");
    label.textContent = "상대 차례 진행 중...";
    document.getElementById("action-bar").appendChild(label);
    placeActionBar();
    awaitingServer = true; // 재생이 끝나 새 요청이 오기 전에는 응답을 보내지 않는다
    return;
  }
  if (msg.type === "game_end") {
    renderGameEnd(msg, lastKnownMySeat);
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
  else if (request.type === "chi") renderChiRequest(request);
  else if (request.type === "tsumo") renderTsumoRequest(request);
  else renderCallRequest(request);
  placeActionBar();
}

const events = new EventSource("/events");
events.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
