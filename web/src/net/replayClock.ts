// 回放的时间约定（与后端回放文件一致，见 docs/norte-fire.md）：
// 事件的 offsetSeconds 按"1 秒 = 5 分钟真实时间"编排，播放时再除以倍速 speed。
// 因此回放中每秒墙钟对应 5 × speed 分钟的事件时间，模拟按这个节奏推进，火点与风才会落在正确的模拟时刻。

export const REPLAY_MINUTES_PER_SECOND = 5;
