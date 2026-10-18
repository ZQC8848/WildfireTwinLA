// 浏览器内的紧急联络调度器（公开网站没有后端时使用）。逐条对应 server/app/households.py 与 dispatch.py：
// - 每栋建筑一户合成住户：真实 OSM 街名 + 随机门牌、常见姓名、只用虚构号段 (949) 555-0100–0199；对外只发打码字段
// - 两条优先队列：外呼（编号线路，结束后保留话后整理）与短信（令牌桶限速）；未接听 3 分钟后重拨一次，再未接听就把短信提前
// - 优先级 = 预计到达时间（距离 ÷ 按风修正的蔓延速度，与模型到达时间取较早者），需要协助的住户提前 5 分钟
// 消息格式与后端 /ws/dispatch 一致（contact / dispatch_summary / dispatch_snapshot），前端面板无需区分来源。

// 不引用 webworker 类型库：它会改写全项目的全局类型；这里只需要 postMessage
const port = self as unknown as { postMessage(msg: unknown): void };

// ---------- 合成住户（households.py） ----------
const SEED = 2026;
const FICTIONAL_PREFIX = "+1949555";
const FIRST_EN = ["James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda", "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Daniel", "Lisa", "Matthew", "Nancy", "Mark", "Ashley", "Steven", "Kimberly", "Paul", "Emily", "Andrew", "Donna", "Kevin", "Michelle", "Brian", "Carol", "Ryan", "Amanda", "Jason", "Melissa", "Eric", "Stephanie", "Scott", "Rebecca", "Gregory", "Laura", "Megan", "Kyle", "Rachel", "Noah", "Olivia"];
const FIRST_ES = ["Jose", "Maria", "Juan", "Guadalupe", "Carlos", "Rosa", "Luis", "Ana", "Miguel", "Carmen", "Jorge", "Elena", "Pedro", "Sofia", "Alejandro", "Lucia", "Ricardo", "Isabel", "Fernando", "Gabriela", "Javier", "Teresa", "Manuel", "Patricia", "Diego", "Laura"];
const LAST_EN = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark", "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright", "Scott", "Hill", "Green", "Adams", "Baker", "Nelson", "Carter", "Mitchell", "Roberts", "Campbell", "Parker", "Evans", "Edwards", "Collins", "Stewart", "Morris", "Murphy", "Cook", "Rogers", "Morgan", "Cooper", "Peterson", "Reed", "Bailey", "Kim", "Nguyen", "Chen", "Patel", "Park", "Tran", "Wong"];
const LAST_ES = ["Garcia", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Perez", "Sanchez", "Ramirez", "Torres", "Flores", "Rivera", "Gomez", "Diaz", "Reyes", "Morales", "Cruz", "Ortiz", "Gutierrez", "Chavez", "Ramos", "Ruiz", "Mendoza", "Castillo"];
const CITIES: [string, [string, string]][] = [
  ["sjc", ["San Juan Capistrano", "92675"]],
  ["scl", ["San Clemente", "92672"]],
  ["ladera", ["Ladera Ranch", "92694"]],
  ["esencia", ["Rancho Mission Viejo", "92694"]],
];
const BUCKET = 16;

interface Household {
  id: string;
  buildingId: string;
  cell: number;
  x: number;
  y: number;
  address: string;
  city: string;
  owner: string;
  phone: string;
  language: string;
  vulnerable: boolean;
  communityId: string | null;
}

/** 确定性随机数（mulberry32） */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const maskName = (name: string) => {
  const i = name.indexOf(" ");
  if (i < 0) return name;
  const last = name.slice(i + 1);
  return `${name.slice(0, i)} ${last.slice(0, 1)}${"*".repeat(Math.max(3, last.length - 1))}`;
};
export const maskPhone = (e164: string) => {
  const d = e164.replace(/^\+1/, "");
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 8)}**`;
};
export const maskAddress = (address: string) => {
  const i = address.indexOf(" ");
  const number = address.slice(0, i);
  return `${number.slice(0, 2)}${"*".repeat(Math.max(1, number.length - 2))} ${address.slice(i + 1)}`;
};

type Segment = [number, number, number, number, string];

function segments(roads: { roads: number[][]; names?: (string | null)[] }) {
  const buckets = new Map<string, Segment[]>();
  const names = roads.names ?? [];
  roads.roads.forEach((road, r) => {
    const name = names[r];
    // 门牌不编在高速路（类别 0）上
    if (!name || road[0] === 0) return;
    const pts = road.slice(1);
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const seg: Segment = [pts[k], pts[k + 1], pts[k + 2], pts[k + 3], name];
      for (let bx = Math.floor(Math.min(seg[0], seg[2]) / BUCKET); bx <= Math.floor(Math.max(seg[0], seg[2]) / BUCKET); bx++)
        for (let by = Math.floor(Math.min(seg[1], seg[3]) / BUCKET); by <= Math.floor(Math.max(seg[1], seg[3]) / BUCKET); by++) {
          const key = `${bx},${by}`;
          let list = buckets.get(key);
          if (!list) buckets.set(key, (list = []));
          list.push(seg);
        }
    }
  });
  return buckets;
}

/** 最近的有名字的街道，以及房屋在街道哪一侧（叉积符号） */
function nearestStreet(buckets: Map<string, Segment[]>, x: number, y: number): [string, number] {
  const bx = Math.floor(x / BUCKET);
  const by = Math.floor(y / BUCKET);
  let best = Infinity;
  let name = "";
  let side = 1;
  for (const radius of [1, 2, 4]) {
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++)
        for (const [x0, y0, x1, y1, n] of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
          const vx = x1 - x0;
          const vy = y1 - y0;
          const len2 = vx * vx + vy * vy || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / len2));
          const d = Math.hypot(x - x0 - t * vx, y - y0 - t * vy);
          if (d < best) {
            best = d;
            name = n;
            side = vx * (y - y0) - vy * (x - x0) >= 0 ? 1 : -1;
          }
        }
    if (name) break;
  }
  return [name || "Ortega Highway", side];
}

async function loadHouseholds(base: string): Promise<{ households: Household[]; width: number; cellSize: number }> {
  const get = (name: string) => fetch(`${base}data/${name}`).then((r) => r.json());
  const [meta, buildings, roads, communities] = await Promise.all([get("grid.json"), get("buildings.json"), get("roads.json"), get("communities.json")]);
  const width: number = meta.width;
  const communityOf = new Map<number, string>();
  const centroids: [number, number, string][] = [];
  for (const c of communities as { id: string; cells: number[] }[]) {
    let sx = 0;
    let sy = 0;
    for (const cell of c.cells) {
      communityOf.set(cell, c.id);
      sx += cell % width;
      sy += Math.floor(cell / width);
    }
    if (c.cells.length) centroids.push([sx / c.cells.length, sy / c.cells.length, c.id]);
  }
  const buckets = segments(roads);
  const r = rng(SEED);
  const pick = <T>(list: T[]) => list[Math.floor(r() * list.length)];
  const households: Household[] = [];
  for (const b of buildings as { id: string | number; cell: number }[]) {
    const cell = Number(b.cell);
    const x = (cell % width) + 0.5;
    const y = Math.floor(cell / width) + 0.5;
    const community = communityOf.get(cell) ?? null;
    let nearest = community;
    if (!nearest && centroids.length) {
      let bestD = Infinity;
      for (const [cx, cy, id] of centroids) {
        const d = Math.hypot(cx - x, cy - y);
        if (d < bestD) {
          bestD = d;
          nearest = id;
        }
      }
    }
    const [city] = (CITIES.find(([prefix]) => nearest?.startsWith(prefix)) ?? CITIES[0])[1];
    const [street, side] = nearestStreet(buckets, x, y);
    // 门牌：街道一侧双号，另一侧单号
    let number = 100 + Math.floor(r() * 34899);
    if ((number % 2 === 1) === side > 0) number += 1;
    const spanish = r() < 0.25;
    const first = pick(spanish && r() < 0.8 ? FIRST_ES : FIRST_EN);
    const last = pick(spanish ? LAST_ES : LAST_EN);
    const phone = `${FICTIONAL_PREFIX}01${String(Math.floor(r() * 100)).padStart(2, "0")}`;
    const language = spanish && r() < 0.6 ? "es" : "en";
    households.push({ id: `hh-${b.id}`, buildingId: String(b.id), cell, x, y, address: `${number} ${street}`, city, owner: `${first} ${last}`, phone, language, vulnerable: r() < 0.08, communityId: community });
  }
  return { households, width, cellSize: meta.cellSize ?? 25 };
}

const publicHousehold = (h: Household) => ({
  id: h.id,
  buildingId: h.buildingId,
  cell: h.cell,
  owner: maskName(h.owner),
  phone: maskPhone(h.phone),
  address: `${maskAddress(h.address)}, ${h.city}`,
  language: h.language,
  vulnerable: h.vulnerable,
  communityId: h.communityId,
});

// ---------- 调度（dispatch.py） ----------
const CALL_ETA_MIN = 30;
const CALL_DISTANCE_M = 300;
const TEXT_ETA_MIN = 90;
const TEXT_DISTANCE_M = 1500;
const VULNERABLE_BONUS_MIN = 5;
const RETRY_AFTER_S = 180;
const WRAP_UP_S = 15;

interface Task {
  id: string;
  household: Household;
  channel: "call" | "text";
  status: string;
  etaMin: number;
  distanceM: number;
  attempt: number;
  readyAt: number;
  updatedAt: number;
  line: number | null;
}

const priority = (t: Task) => t.etaMin - (t.household.vulnerable ? VULNERABLE_BONUS_MIN : 0);
const publicTask = (t: Task) => ({
  id: t.id,
  channel: t.channel,
  status: t.status,
  attempt: t.attempt,
  line: t.line,
  etaMin: Math.round(t.etaMin * 10) / 10,
  distanceM: Math.round(t.distanceM),
  provider: "mock",
  updatedAt: t.updatedAt,
  household: publicHousehold(t.household),
});

class Dispatcher {
  active = false;
  demoSpeed = 10;
  callLines = 6;
  smsPerSecond = 25;
  private households: Household[] = [];
  private cellSize = 25;
  private loading: Promise<void> | null = null;
  private tasks = new Map<string, Task>();
  private lines: (string | null)[] = [];
  private gen = 0;
  private timers = new Set<number>();
  private intervals: number[] = [];
  private outcome = rng(7);
  private lastSummary = "";

  constructor(private base: string) {}

  private post(msg: object) {
    port.postMessage(msg);
  }

  private load() {
    this.loading ??= loadHouseholds(this.base).then((d) => {
      this.households = d.households;
      this.cellSize = d.cellSize;
    });
    return this.loading;
  }

  /** 真实秒数的等待；停止调度后 resolve(false)，调用方不再继续 */
  private wait(seconds: number, gen: number) {
    return new Promise<boolean>((resolve) => {
      const id = self.setTimeout(() => {
        this.timers.delete(id);
        resolve(gen === this.gen);
      }, seconds * 1000);
      this.timers.add(id);
    });
  }

  /** 按演示倍速缩短的等待（参数是通话里的秒数） */
  private sleep(callSeconds: number, gen: number) {
    return this.wait(callSeconds / this.demoSpeed, gen);
  }

  async start(demoSpeed?: number, callLines?: number) {
    if (demoSpeed) this.demoSpeed = Math.max(0.1, demoSpeed);
    if (callLines) this.callLines = Math.max(1, callLines);
    await this.load();
    if (!this.active) {
      this.active = true;
      this.lines = Array(this.callLines).fill(null);
      const gen = this.gen;
      this.intervals.push(self.setInterval(() => gen === this.gen && this.callLoop(), 100));
      let last = performance.now();
      let budget = 0;
      this.intervals.push(
        self.setInterval(() => {
          if (gen !== this.gen) return;
          const now = performance.now();
          budget = Math.min(this.smsPerSecond, budget + ((now - last) / 1000) * this.smsPerSecond);
          last = now;
          while (budget >= 1) {
            const task = this.next("text");
            if (!task) break;
            budget -= 1;
            this.runText(task, gen);
          }
        }, 50),
      );
      this.intervals.push(self.setInterval(() => gen === this.gen && this.postSummary(), 1000));
    }
    this.post({ type: "started", summary: this.summary() });
    this.post({ type: "dispatch_snapshot", ...this.snapshot() });
  }

  stop() {
    this.active = false;
    this.gen++;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.intervals.forEach((t) => clearInterval(t));
    this.intervals = [];
    this.tasks.clear();
    this.lines = Array(this.callLines).fill(null);
    this.lastSummary = "";
    this.post({ type: "dispatch_snapshot", ...this.snapshot() });
  }

  /** 重新估计到达时间；把新进入外呼区、短信区的住户加入队列，并更新排队任务的优先级 */
  updateFire(cells: number[], width: number, etas: Record<string, number>, windFromDeg?: number, windSpeedMs?: number) {
    if (!this.active || !cells.length) return 0;
    const reach = TEXT_DISTANCE_M / this.cellSize;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    // 燃烧格按 16 格分桶，房屋由近及远逐圈查找最近的燃烧格
    const fire = new Map<string, [number, number][]>();
    for (const c of cells) {
      const x = (c % width) + 0.5;
      const y = Math.floor(c / width) + 0.5;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      const key = `${Math.floor(x / BUCKET)},${Math.floor(y / BUCKET)}`;
      let list = fire.get(key);
      if (!list) fire.set(key, (list = []));
      list.push([x, y]);
    }
    let tx = 0;
    let tz = 0;
    let wind = 0;
    if (windFromDeg !== undefined && windSpeedMs) {
      // 风吹向的方向（网格坐标：x 向东，y 向南）
      tx = -Math.sin((windFromDeg * Math.PI) / 180);
      tz = Math.cos((windFromDeg * Math.PI) / 180);
      wind = windSpeedMs;
    }
    const maxRing = Math.ceil(reach / BUCKET) + 1;
    let created = 0;
    for (const h of this.households) {
      if (h.x < x0 - reach || h.x > x1 + reach || h.y < y0 - reach || h.y > y1 + reach) continue;
      const bx = Math.floor(h.x / BUCKET);
      const by = Math.floor(h.y / BUCKET);
      let best = Infinity;
      let vx = 0;
      let vy = 0;
      for (let ring = 0; ring <= maxRing; ring++) {
        for (let dx = -ring; dx <= ring; dx++)
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            for (const [fx, fy] of fire.get(`${bx + dx},${by + dy}`) ?? []) {
              const d2 = (h.x - fx) ** 2 + (h.y - fy) ** 2;
              if (d2 < best) {
                best = d2;
                vx = h.x - fx;
                vy = h.y - fy;
              }
            }
          }
        // 已找到，且下一圈不可能更近
        if (best < Infinity && Math.sqrt(best) < ring * BUCKET) break;
      }
      if (best === Infinity) continue;
      const dCells = Math.sqrt(best);
      const cosine = dCells > 1e-6 ? (vx * tx + vy * tz) / dCells : 0;
      // 基于距离的估计：上风每分钟 3 m，下风随风速加快
      const rate = 3 + 2.5 * wind * Math.max(cosine, 0);
      const distanceM = dCells * this.cellSize;
      const model = etas[h.buildingId];
      const eta = model !== undefined ? Math.min(distanceM / rate, model) : distanceM / rate;
      const inCall = eta <= CALL_ETA_MIN || distanceM <= CALL_DISTANCE_M;
      const inText = inCall || eta <= TEXT_ETA_MIN || distanceM <= TEXT_DISTANCE_M;
      if (inText) created += this.ensure(h, "text", eta, distanceM);
      if (inCall) created += this.ensure(h, "call", eta, distanceM);
    }
    return created;
  }

  private ensure(h: Household, channel: "call" | "text", eta: number, distanceM: number) {
    const id = `${channel}-${h.id}`;
    const existing = this.tasks.get(id);
    if (existing) {
      if (existing.status === "queued") {
        existing.etaMin = eta;
        existing.distanceM = distanceM;
      }
      return 0;
    }
    const task: Task = { id, household: h, channel, status: "queued", etaMin: eta, distanceM, attempt: 1, readyAt: 0, updatedAt: Date.now() / 1000, line: null };
    this.tasks.set(id, task);
    this.emit(task);
    return 1;
  }

  private next(channel: "call" | "text") {
    const now = performance.now();
    let best: Task | null = null;
    for (const t of this.tasks.values()) {
      if (t.channel !== channel || t.status !== "queued" || t.readyAt > now) continue;
      if (!best || priority(t) < priority(best)) best = t;
    }
    return best;
  }

  private callLoop() {
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i] !== null) continue;
      const task = this.next("call");
      if (!task) break;
      task.line = i + 1;
      this.lines[i] = task.id;
      task.status = "ringing";
      this.emit(task);
      void this.runCall(task, this.gen);
    }
  }

  private async runCall(task: Task, gen: number) {
    if (!(await this.sleep(8 + this.outcome() * 14, gen))) return;
    const roll = this.outcome();
    if (roll < 0.65) {
      task.status = "talking";
      this.emit(task);
      if (!(await this.sleep(30 + this.outcome() * 45, gen))) return;
      const help = task.household.vulnerable ? 0.25 : 0.06;
      task.status = this.outcome() < help ? "needs_help" : "confirmed";
      this.emit(task);
    } else if (roll < 0.95) {
      this.noAnswer(task);
    } else {
      task.status = "failed";
      this.emit(task);
    }
    // 话后整理：结果先留在线路上，再接下一通
    const line = (task.line ?? 0) - 1;
    if (!(await this.sleep(WRAP_UP_S, gen))) return;
    if (line >= 0 && this.lines[line] === task.id) this.lines[line] = null;
  }

  private noAnswer(task: Task) {
    if (task.attempt === 1) {
      // 3 分钟后重拨一次；期间短信作为备份
      task.attempt = 2;
      task.status = "queued";
      task.readyAt = performance.now() + ((RETRY_AFTER_S / this.demoSpeed) * 1000);
    } else {
      task.status = "no_answer";
    }
    this.emit(task);
    const text = this.tasks.get(`text-${task.household.id}`);
    if (text && text.status === "queued") text.etaMin = Math.min(text.etaMin, task.etaMin) - 30;
  }

  private async runText(task: Task, gen: number) {
    task.status = "sending";
    this.emit(task);
    if (!(await this.wait(0.3 + this.outcome() * 0.5, gen))) return;
    task.status = "sent";
    this.emit(task);
    if (!(await this.wait(1 + this.outcome() * 2, gen))) return;
    task.status = this.outcome() < 0.97 ? "delivered" : "failed";
    this.emit(task);
  }

  private emit(task: Task) {
    task.updatedAt = Date.now() / 1000;
    this.post({ type: "contact", task: publicTask(task) });
  }

  summary() {
    const c = { calling: 0, callQueued: 0, confirmed: 0, needsHelp: 0, noAnswer: 0, callFailed: 0, textQueued: 0, texting: 0, texted: 0, textFailed: 0 };
    const CALL: Record<string, keyof typeof c> = { ringing: "calling", talking: "calling", queued: "callQueued", confirmed: "confirmed", needs_help: "needsHelp", no_answer: "noAnswer", failed: "callFailed" };
    const TEXT: Record<string, keyof typeof c> = { queued: "textQueued", sending: "texting", sent: "texted", delivered: "texted", failed: "textFailed" };
    for (const t of this.tasks.values()) c[(t.channel === "call" ? CALL : TEXT)[t.status]]++;
    return { active: this.active, demoSpeed: this.demoSpeed, callLines: this.callLines, households: this.households.length, ...c };
  }

  private postSummary() {
    const s = this.summary();
    const key = JSON.stringify(s);
    if (key === this.lastSummary) return;
    this.lastSummary = key;
    this.post({ type: "dispatch_summary", ...s });
  }

  snapshot() {
    return { summary: this.summary(), tasks: [...this.tasks.values()].map(publicTask) };
  }
}

// ---------- 消息 ----------
let dispatcher: Dispatcher | null = null;
self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.cmd === "start") {
      dispatcher ??= new Dispatcher(m.base);
      await dispatcher.start(m.demoSpeed, m.callLines);
    } else if (m.cmd === "stop") {
      dispatcher?.stop();
    } else if (m.cmd === "fire") {
      dispatcher?.updateFire(m.cells, m.width, m.etas ?? {}, m.windFromDeg, m.windSpeedMs);
    }
  } catch (err) {
    port.postMessage({ type: "error", message: String(err) });
  }
};

export {};
