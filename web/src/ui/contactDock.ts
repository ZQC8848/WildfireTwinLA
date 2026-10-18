// 紧急联络面板：Respond 模式下固定在地图右侧，展开时把地图挤窄（--dock-w），收起后剩一条竖向标签。
// 自上而下：外呼与短信进度条、固定的外呼线路（每条线路一张卡，通话结束后先显示结果）、需要帮助、待执行队列。
// 只负责 DOM 与交互事件；数据由 main.ts 从 DispatchClient 整理后传入，只含打码后的字段。

import "./contactDock.css";
import type { DispatchSummary } from "../net/dispatch";

/** 面板显示用的联络任务 */
export interface ContactTaskView {
  buildingId: string;
  owner: string;
  phone: string;
  address: string;
  vulnerable: boolean;
  status: string;
  attempt: number;
  etaMin: number;
  /** 距上次状态变化的真实秒数 */
  ageS: number;
  /** 同上，按演示倍速换算成通话里的秒数 */
  elapsedS: number;
}

export interface ContactView {
  state: "off" | "starting" | "active" | "offline";
  summary: DispatchSummary | null;
  /** 每条线路当前的任务；空闲为 null */
  lines: (ContactTaskView | null)[];
  help: ContactTaskView[];
  queue: { call: ContactTaskView[]; text: ContactTaskView[] };
  queueTotals: { call: number; text: number };
}

export interface ContactDockHandlers {
  /** Start / Stop */
  onToggle(): void;
  onFocus(buildingId: string): void;
  /** 悬停在某户上（null 表示离开），用于在地图上标出这栋房子 */
  onHover(buildingId: string | null): void;
  /** 切换队列标签等需要立即重绘时 */
  onRefresh(): void;
}

/** 通话结束后，没有下一通电话接上时，结果在线路上保留的真实秒数 */
const RESULT_HOLD_S = 6;

const fmt = (n: number) => n.toLocaleString("en-US");
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtEtaShort = (m: number) => (m < 1 ? "now" : m < 60 ? `~${Math.round(m)} min` : `~${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
const fmtEtaText = (m: number) => (m < 1 ? "Fire at the home" : `Fire in ${fmtEtaShort(m)}`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const icon = (body: string, cls = "tool-icon") =>
  `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  phone: icon(`<path d="M5.2 2.5 3.4 3.1c-.9.4-1.3 1.4-1 2.3 1.4 4 4.2 6.8 8.2 8.2.9.3 1.9-.1 2.3-1l.6-1.8-2.8-1.6-1.3 1.2C7.9 9.6 6.4 8.1 5.6 6.6l1.2-1.3z"/>`),
  collapse: icon(`<path d="M6 4l4 4-4 4"/>`),
  check: icon(`<path d="M3.5 8.5l3 3 6-7"/>`, "ln-icon"),
  help: icon(`<circle cx="8" cy="8" r="6"/><path d="M8 4.8v4"/><path d="M8 11.2v.01"/>`, "ln-icon"),
  missed: icon(`<path d="M4 4l8 8M12 4l-8 8"/>`, "ln-icon"),
};

/** 线路卡的状态：样式类、文字、是否计时 */
function lineState(t: ContactTaskView | null): { cls: string; label: string; icon: string; live: boolean } | null {
  if (!t) return null;
  const live = t.status === "ringing" || t.status === "talking";
  if (!live && t.ageS > RESULT_HOLD_S) return null;
  switch (t.status) {
    case "ringing":
      return { cls: "ringing", label: "Ringing", icon: "", live };
    case "talking":
      return { cls: "talking", label: "On the call", icon: "", live };
    case "confirmed":
      return { cls: "done confirmed", label: "Confirmed safe", icon: ICONS.check, live };
    case "needs_help":
      return { cls: "done help", label: "Needs help", icon: ICONS.help, live };
    // 第一次未接听：任务回到队列，3 分钟后重拨
    case "queued":
      return { cls: "done missed", label: "No answer, retry later", icon: ICONS.missed, live };
    case "no_answer":
      return { cls: "done missed", label: "No answer, texted", icon: ICONS.missed, live };
    default:
      return { cls: "done missed", label: "Call failed, texted", icon: ICONS.missed, live };
  }
}

const tag = (t: ContactTaskView) => (t.vulnerable ? '<span class="ci-tag">Access needs</span>' : "");

export class ContactDock {
  readonly root: HTMLElement;
  open = false;
  private queueTab: "call" | "text" = "call";
  private lineEls: HTMLLIElement[] = [];
  private lineKeys: string[] = [];
  /** 各列表上次的 HTML，没变就不重建（避免悬停、点击中的元素被替换） */
  private html = new Map<string, string>();
  private hovered: string | null = null;
  private pinged: { id: string; until: number } | null = null;
  private q = <T extends Element>(sel: string) => this.root.querySelector<T>(sel)!;

  constructor(private handlers: ContactDockHandlers) {
    const root = document.createElement("aside");
    root.className = "dock";
    root.id = "contact-dock";
    root.setAttribute("aria-label", "Emergency contact");
    root.innerHTML = `
      <button class="dock-tab" id="dock-tab" aria-expanded="false" aria-controls="dock-body" title="Open emergency contact">
        ${ICONS.phone}
        <span class="dock-tab-label">Emergency contact</span>
        <span class="dock-badge" id="dock-tab-calling" title="On the line" hidden></span>
        <span class="dock-badge help" id="dock-tab-help" title="Needs help" hidden></span>
      </button>
      <div class="dock-body" id="dock-body">
        <header class="dock-head">
          <h2>Emergency contact</h2>
          <button class="btn btn-small" id="contact-toggle">Start</button>
          <button class="dock-close" id="dock-close" aria-label="Collapse the panel" title="Collapse">${ICONS.collapse}</button>
        </header>
        <p class="dock-note"><span class="dock-state" id="contact-state"></span><span id="contact-status"></span></p>
        <div class="dock-progress" id="contact-progress" hidden>
          <div class="prog">
            <div class="prog-head"><span>Calls</span><span class="figure" id="prog-call-n"></span></div>
            <div class="prog-bar" id="prog-call-bar"></div>
            <div class="prog-legend" id="prog-call-legend"></div>
          </div>
          <div class="prog">
            <div class="prog-head"><span>Texts</span><span class="figure" id="prog-text-n"></span></div>
            <div class="prog-bar" id="prog-text-bar"></div>
            <div class="prog-legend" id="prog-text-legend"></div>
          </div>
        </div>
        <section class="dock-block" id="lines-block" hidden>
          <h3 class="dock-sub">Lines<span class="dock-sub-note" id="lines-note"></span></h3>
          <ol class="lines" id="contact-lines"></ol>
        </section>
        <section class="dock-block" id="help-block" hidden>
          <h3 class="dock-sub help">Needs help<span class="dock-badge help" id="help-n"></span></h3>
          <ul class="contact-list" id="contact-help"></ul>
        </section>
        <section class="dock-block dock-queue" id="queue-block" hidden>
          <div class="queue-head">
            <h3 class="dock-sub">Queue</h3>
            <div class="segmented queue-tabs" id="queue-tabs" role="group" aria-label="Queue">
              <button data-q="call" aria-pressed="true">Calls <span id="q-call-n"></span></button><button data-q="text" aria-pressed="false">Texts <span id="q-text-n"></span></button>
            </div>
          </div>
          <ol class="contact-queue" id="contact-queue"></ol>
        </section>
        <p class="dock-note synthetic-note" title="Names, numbers and house numbers are generated. Numbers use the 555-01xx range reserved for fiction, so they never ring a real phone.">Synthetic residents · fictional 555-01xx numbers</p>
      </div>`;
    document.body.appendChild(root);
    this.root = root;

    this.q<HTMLButtonElement>("#dock-tab").addEventListener("click", () => this.setOpen(true));
    this.q<HTMLButtonElement>("#dock-close").addEventListener("click", () => this.setOpen(false));
    this.q<HTMLButtonElement>("#contact-toggle").addEventListener("click", () => this.handlers.onToggle());
    this.q<HTMLDivElement>("#queue-tabs").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-q]");
      if (!b) return;
      this.queueTab = b.dataset.q as "call" | "text";
      this.q<HTMLDivElement>("#queue-tabs")
        .querySelectorAll("button")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      this.handlers.onRefresh();
    });
    // 列表项：点击或回车让相机飞到这栋房子，悬停时在地图上标出它
    const body = this.q<HTMLDivElement>("#dock-body");
    const building = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>("[data-building]")?.dataset.building ?? null;
    body.addEventListener("click", (e) => {
      const id = building(e);
      if (id) this.handlers.onFocus(id);
    });
    body.addEventListener("keydown", (e) => {
      const id = (e as KeyboardEvent).key === "Enter" ? building(e) : null;
      if (id) this.handlers.onFocus(id);
    });
    body.addEventListener("pointerover", (e) => this.hover(building(e)));
    body.addEventListener("pointerleave", () => this.hover(null));
  }

  setOpen(open: boolean) {
    this.open = open;
    document.body.classList.toggle("dock-open", open);
    this.q<HTMLButtonElement>("#dock-tab").setAttribute("aria-expanded", String(open));
    if (!open) this.hover(null);
  }

  /** 从地图选中某户：展开面板，滚到这户并短暂高亮 */
  reveal(buildingId: string) {
    this.setOpen(true);
    this.pinged = { id: buildingId, until: performance.now() + 1600 };
    this.applyPing();
    this.root.querySelector(`[data-building="${CSS.escape(buildingId)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  render(view: ContactView) {
    const { state, summary } = view;
    const active = state === "active" && !!summary;
    const toggle = this.q<HTMLButtonElement>("#contact-toggle");
    toggle.textContent = state === "active" || state === "starting" ? "Stop" : "Start";
    toggle.disabled = state === "starting";
    const pill = this.q<HTMLSpanElement>("#contact-state");
    pill.dataset.state = state;
    pill.textContent = { off: "Off", starting: "Starting", active: "Live", offline: "Offline" }[state];
    this.q<HTMLSpanElement>("#contact-status").textContent = {
      off: "Calls the homes closest to the fire first and texts everyone nearby. Starts on its own when a fire is detected.",
      starting: "Loading the household directory…",
      active: "Nearest homes first; texts within 1.5 km.",
      offline: "Needs the backend (localhost:8010). Start it, then press Start.",
    }[state];

    // 收起时的标签：通话中与需要帮助的数量
    const calling = this.q<HTMLSpanElement>("#dock-tab-calling");
    calling.hidden = !active || !summary.calling;
    calling.textContent = String(summary?.calling ?? 0);
    const tabHelp = this.q<HTMLSpanElement>("#dock-tab-help");
    tabHelp.hidden = !active || !summary.needsHelp;
    tabHelp.textContent = String(summary?.needsHelp ?? 0);

    this.q<HTMLDivElement>("#contact-progress").hidden = !active;
    this.q<HTMLElement>("#lines-block").hidden = !active;
    if (active) {
      this.renderProgress(summary);
      this.renderLines(view.lines, summary);
    }

    const helpBlock = this.q<HTMLElement>("#help-block");
    helpBlock.hidden = !active || !view.help.length;
    this.q<HTMLSpanElement>("#help-n").textContent = String(summary?.needsHelp ?? 0);
    this.setHtml(
      "#contact-help",
      view.help
        .map(
          (t) => `<li class="contact-item help" data-building="${esc(t.buildingId)}" tabindex="0">
        <div class="ci-top"><span class="ci-name">${esc(t.owner)}${tag(t)}</span><span class="ci-phone">${esc(t.phone)}</span></div>
        <div class="ci-addr">${esc(t.address)}</div>
        <div class="ci-meta"><span class="ci-state">Asked for help</span><span>${fmtEtaText(t.etaMin)}</span></div>
      </li>`,
        )
        .join(""),
    );

    const showQueue = active && (view.queueTotals.call > 0 || view.queueTotals.text > 0);
    this.q<HTMLElement>("#queue-block").hidden = !showQueue;
    this.q<HTMLSpanElement>("#q-call-n").textContent = fmt(view.queueTotals.call);
    this.q<HTMLSpanElement>("#q-text-n").textContent = fmt(view.queueTotals.text);
    const items = showQueue ? view.queue[this.queueTab] : [];
    const total = view.queueTotals[this.queueTab];
    this.setHtml(
      "#contact-queue",
      items
        .map(
          (t, i) =>
            `<li data-building="${esc(t.buildingId)}" tabindex="0"><span class="q-rank">${i + 1}</span><span class="q-main"><span class="q-addr">${esc(t.address)}</span><span class="q-owner">${esc(t.owner)}${tag(t)}${t.attempt > 1 ? '<span class="ci-tag quiet">Retry</span>' : ""}</span></span><span class="q-eta">${fmtEtaShort(t.etaMin)}</span></li>`,
        )
        .join("") + (total > items.length ? `<li class="q-more">${fmt(total - items.length)} more</li>` : ""),
    );
    this.applyPing();
  }

  /** 两根进度条：外呼按结果分段，短信按发送状态分段；排队部分是空槽 */
  private renderProgress(s: DispatchSummary) {
    const seg = (n: number, cls: string) => (n > 0 ? `<i class="seg ${cls}" style="flex-grow:${n}"></i>` : "");
    const item = (n: number, cls: string, label: string) => `<span><i class="dot ${cls}"></i>${label}<b>${fmt(n)}</b></span>`;
    const missed = s.noAnswer + s.callFailed;
    const callDone = s.confirmed + s.needsHelp + missed;
    const callTotal = callDone + s.calling + s.callQueued;
    this.q<HTMLSpanElement>("#prog-call-n").textContent = `${fmt(callDone)} of ${fmt(callTotal)} done`;
    this.setHtml("#prog-call-bar", seg(s.confirmed, "c-safe") + seg(s.needsHelp, "c-help") + seg(missed, "c-missed") + seg(s.calling, "c-live") + seg(s.callQueued, "rest"));
    // 排队数量在队列标签上，通话中的数量在线路标题上，这里只列结果
    this.setHtml("#prog-call-legend", item(s.confirmed, "c-safe", "Safe") + item(s.needsHelp, "c-help", "Needs help") + item(missed, "c-missed", "No answer"));
    const textDone = s.texted + s.textFailed;
    const textTotal = textDone + s.texting + s.textQueued;
    this.q<HTMLSpanElement>("#prog-text-n").textContent = `${fmt(textDone)} of ${fmt(textTotal)} sent`;
    this.setHtml("#prog-text-bar", seg(s.texted, "c-sent") + seg(s.textFailed, "c-failed") + seg(s.texting, "c-sending") + seg(s.textQueued, "rest"));
    this.setHtml("#prog-text-legend", item(s.texted, "c-sent", "Sent") + item(s.textFailed, "c-failed", "Failed"));
  }

  /** 固定数量的线路卡：同一条线路始终在同一位置；只有换人或换状态时才重建卡片，计时单独更新 */
  private renderLines(lines: (ContactTaskView | null)[], s: DispatchSummary) {
    this.q<HTMLSpanElement>("#lines-note").textContent = `${s.calling} of ${s.callLines} busy · demo ×${s.demoSpeed}`;
    const list = this.q<HTMLOListElement>("#contact-lines");
    while (this.lineEls.length < lines.length) {
      const li = document.createElement("li");
      list.appendChild(li);
      this.lineEls.push(li);
      this.lineKeys.push("");
    }
    while (this.lineEls.length > lines.length) {
      this.lineEls.pop()!.remove();
      this.lineKeys.pop();
    }
    lines.forEach((t, i) => {
      const li = this.lineEls[i];
      const st = lineState(t);
      const key = t && st ? `${t.buildingId}|${st.cls}` : "idle";
      if (key !== this.lineKeys[i]) {
        this.lineKeys[i] = key;
        const num = `<span class="ln-num">${i + 1}</span>`;
        if (!t || !st) {
          li.className = "line idle";
          li.removeAttribute("data-building");
          li.removeAttribute("tabindex");
          li.innerHTML = `${num}<span class="ln-free">Line free</span>`;
        } else {
          li.className = `line ${st.cls}`;
          li.dataset.building = t.buildingId;
          li.tabIndex = 0;
          li.innerHTML = `${num}<div class="ln-body">
            <div class="ln-top"><span class="ln-name">${esc(t.owner)}</span><span class="ln-state">${st.icon}${st.label}${st.live ? ' <span class="ln-clock"></span>' : ""}</span></div>
            <div class="ln-mid"><span class="ln-addr">${esc(t.address)}</span>${tag(t)}</div>
            <div class="ln-meta"><span class="ln-phone">${esc(t.phone)}</span><span class="ln-eta">${fmtEtaText(t.etaMin)}</span></div>
          </div>`;
        }
      }
      const clock = li.querySelector<HTMLSpanElement>(".ln-clock");
      if (clock && t) clock.textContent = fmtClock(t.elapsedS);
    });
  }

  private setHtml(sel: string, html: string) {
    if (this.html.get(sel) === html) return;
    this.html.set(sel, html);
    this.q<HTMLElement>(sel).innerHTML = html;
  }

  private hover(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.handlers.onHover(id);
  }

  private applyPing() {
    const p = this.pinged && performance.now() < this.pinged.until ? this.pinged.id : null;
    if (!p) this.pinged = null;
    this.root.querySelectorAll<HTMLElement>("[data-building]").forEach((el) => el.classList.toggle("pinged", el.dataset.building === p));
  }
}
