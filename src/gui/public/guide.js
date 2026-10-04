"use strict";

/* 마작 배우기 화면: 기초 규칙 + 역 도감. 내용은 yakuGuide.js의 데이터를 그대로 그린다 (app.js의 el/tileImg/translateYaku를 쓴다).
 * 열기: 막대의 "도감" 버튼, 로비의 "마작 배우기", 결과 화면의 역 이름, 키보드 G. 닫기: ×, 바깥, Esc. */

const guideState = { tab: "yaku", tag: "all", query: "", open: null };

function guideExample(example) {
  if (!example) return null;
  const box = el("div", "guide-example");
  const row = el("div", "guide-example-tiles");
  for (const group of example.groups) {
    const g = el("span", "guide-group");
    for (const kind of group) g.appendChild(tileImg({ kind }, { small: true }));
    row.appendChild(g);
  }
  box.appendChild(row);
  if (example.note) {
    const note = el("div", "guide-example-note");
    note.textContent = example.note;
    box.appendChild(note);
  }
  return box;
}

function guideYakuCard(entry) {
  const card = el("article", "guide-card" + (guideState.open === entry.id ? " is-open" : ""));
  card.dataset.yaku = entry.id;
  const head = el("button", "guide-card-head", { type: "button", "aria-expanded": String(guideState.open === entry.id) });
  const name = el("span", "guide-name");
  name.textContent = entry.name;
  const han = el("span", "guide-han" + (entry.tag === "yakuman" ? " is-yakuman" : ""));
  han.textContent = entry.han;
  const cond = el("span", "guide-cond");
  cond.textContent = entry.menzen;
  head.append(name, han, cond);
  head.addEventListener("click", () => {
    guideState.open = guideState.open === entry.id ? null : entry.id;
    renderGuide();
  });
  card.appendChild(head);
  const summary = el("p", "guide-summary");
  summary.textContent = entry.summary;
  card.appendChild(summary);
  if (guideState.open === entry.id) {
    if (entry.tips) {
      const tips = el("p", "guide-tips");
      tips.textContent = "팁: " + entry.tips;
      card.appendChild(tips);
    }
    const ex = guideExample(entry.example);
    if (ex) card.appendChild(ex);
  }
  return card;
}

function renderGuideBody(panel) {
  const body = el("div", "guide-body");
  if (guideState.tab === "basics") {
    const intro = el("p", "guide-intro");
    intro.textContent = "마작이 처음이어도 괜찮습니다. 아래 순서대로 읽고, 대국 중에는 메뉴의 '보조 ▾'에서 샹텐·유효패·예상 역 표시를 켜 보세요.";
    body.appendChild(intro);
    for (const section of GUIDE_BASICS) {
      const sec = el("section", "guide-section");
      const h = el("h3");
      h.textContent = section.title;
      sec.appendChild(h);
      for (const line of section.body) {
        const p = el("p");
        p.textContent = line;
        sec.appendChild(p);
      }
      const ex = guideExample(section.example);
      if (ex) sec.appendChild(ex);
      body.appendChild(sec);
    }
    return body;
  }
  // 역 탭: 분류 칩 + 검색 + 카드 목록
  const tools = el("div", "guide-tools");
  const chips = el("div", "guide-chips");
  for (const [tag, label] of [["all", "전체"], ...GUIDE_TAGS]) {
    const chip = el("button", "guide-chip" + (guideState.tag === tag ? " is-on" : ""), { type: "button" });
    chip.textContent = label;
    chip.addEventListener("click", () => {
      guideState.tag = tag;
      renderGuide();
    });
    chips.appendChild(chip);
  }
  const search = el("input", "guide-search", { type: "search", placeholder: "역 이름 검색", "aria-label": "역 이름 검색" });
  search.value = guideState.query;
  search.addEventListener("input", () => {
    guideState.query = search.value;
    renderGuide({ keepSearchFocus: true });
  });
  tools.append(chips, search);
  body.appendChild(tools);

  const q = guideState.query.trim();
  const list = YAKU_GUIDE.filter((e) => (guideState.tag === "all" || e.tag === guideState.tag) && (!q || e.name.includes(q) || e.summary.includes(q)));
  const grid = el("div", "guide-list");
  if (guideState.tag === "all" && !q) grid.appendChild(guideYakuCard(DORA_GUIDE));
  for (const entry of list) grid.appendChild(guideYakuCard(entry));
  if (list.length === 0) {
    const empty = el("p", "guide-empty");
    empty.textContent = "찾는 역이 없습니다.";
    grid.appendChild(empty);
  }
  body.appendChild(grid);
  return body;
}

function renderGuide(opts = {}) {
  let overlay = document.getElementById("guide-overlay");
  if (!overlay) return;
  const panel = overlay.querySelector(".guide-panel");
  const scroll = panel.querySelector(".guide-body")?.scrollTop ?? 0;
  panel.innerHTML = "";
  const head = el("div", "guide-head");
  const title = el("h2");
  title.textContent = "마작 배우기";
  const tabs = el("div", "guide-tabs", { role: "tablist" });
  for (const [id, label] of [["basics", "기초 규칙"], ["yaku", "역 도감"]]) {
    const tab = el("button", "guide-tab" + (guideState.tab === id ? " is-on" : ""), { type: "button", role: "tab", "aria-selected": String(guideState.tab === id) });
    tab.textContent = label;
    tab.addEventListener("click", () => {
      guideState.tab = id;
      renderGuide();
    });
    tabs.appendChild(tab);
  }
  const close = el("button", "guide-close", { type: "button", "aria-label": "닫기" });
  close.textContent = "×";
  close.addEventListener("click", closeGuide);
  head.append(title, tabs, close);
  panel.appendChild(head);
  const body = renderGuideBody(panel);
  panel.appendChild(body);
  body.scrollTop = scroll;
  if (opts.keepSearchFocus) {
    const input = panel.querySelector(".guide-search");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  if (opts.scrollToOpen && guideState.open) panel.querySelector(`[data-yaku="${CSS.escape(guideState.open)}"]`)?.scrollIntoView({ block: "center" });
}

/** 도감을 연다. `yaku`: 엔진 역 이름(예: "Tanyao")이면 그 역 카드를 펼쳐 보여 준다. `tab`: "basics" | "yaku". */
function openGuide({ yaku, tab } = {}) {
  let overlay = document.getElementById("guide-overlay");
  if (!overlay) {
    overlay = el("div", "overlay guide-overlay");
    overlay.id = "guide-overlay";
    overlay.appendChild(el("div", "overlay-panel guide-panel", { role: "dialog", "aria-modal": "true", "aria-label": "마작 배우기" }));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeGuide();
    });
    document.body.appendChild(overlay);
  }
  overlay.classList.remove("hidden");
  if (yaku) {
    const id = GUIDE_BY_ID[yaku] ? yaku : /^Yakuhai \(z[567]\)$/.test(yaku) ? yaku : null;
    if (id) {
      guideState.tab = "yaku";
      guideState.tag = "all";
      guideState.query = "";
      guideState.open = id;
    }
  } else if (tab) {
    guideState.tab = tab;
  }
  renderGuide({ scrollToOpen: !!yaku });
}

function closeGuide() {
  document.getElementById("guide-overlay")?.classList.add("hidden");
}

document.addEventListener("keydown", (e) => {
  const overlay = document.getElementById("guide-overlay");
  const isOpen = overlay && !overlay.classList.contains("hidden");
  if (isOpen && e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeGuide();
  }
}, true);

for (const btn of document.querySelectorAll(".guide-toggle")) {
  btn.addEventListener("click", () => {
    openGuide({ tab: "yaku" });
    btn.blur();
  });
}
