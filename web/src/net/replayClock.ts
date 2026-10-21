// 回放的时间约定（与后端回放文件一致，见 docs/norte-fire.md）：
// 事件的 offsetSeconds 按"1 秒 = 5 分钟真实时间"编排，播放时再除以倍速 speed。
// 因此回放中每秒墙钟对应 5 × speed 分钟的事件时间，模拟按这个节奏推进，火点与风才会落在正确的模拟时刻。
// 回放文件可以在 snapshot 事件里声明后段快进：fastAfterMinutes（自第一个事件起）之后，时钟快 fastFactor 倍。
// Norte 回放在第一天火势被压住后快进，几秒内播完之后两天的官方通报。

export const REPLAY_MINUTES_PER_SECOND = 5;

export interface ReplayClock {
  fastAfterMinutes: number;
  fastFactor: number;
}

export const UNIFORM_CLOCK: ReplayClock = { fastAfterMinutes: Infinity, fastFactor: 1 };

/** 事件时间（自第一个事件起的分钟）→ 回放秒（倍速 1），与回放文件的 offsetSeconds 一致 */
export function replayOffset(minutes: number, clock: ReplayClock): number {
  const slow = Math.min(minutes, clock.fastAfterMinutes);
  const fast = Math.max(0, minutes - clock.fastAfterMinutes);
  return slow / REPLAY_MINUTES_PER_SECOND + fast / (REPLAY_MINUTES_PER_SECOND * clock.fastFactor);
}

/** 回放秒（倍速 1）→ 事件时间（分钟），replayOffset 的反函数 */
export function replayMinutesAt(offset: number, clock: ReplayClock): number {
  const edge = clock.fastAfterMinutes / REPLAY_MINUTES_PER_SECOND;
  if (offset <= edge) return offset * REPLAY_MINUTES_PER_SECOND;
  return clock.fastAfterMinutes + (offset - edge) * REPLAY_MINUTES_PER_SECOND * clock.fastFactor;
}
