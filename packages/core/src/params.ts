// 蔓延模型参数，GPU 元胞自动机与 CPU Dijkstra 共用。数值由 Lucia 维护。

/** Alexandridis et al. (2008) 元胞自动机参数 */
export const SpreadParams = {
  ph: 0.58,
  c1: 0.045,
  c2: 0.131,
  a: 0.078,
  spot: {
    pBase: 0.02,
    /** 飞火距离均值（米）= distMeanPerWindMs × 风速（m/s） */
    distMeanPerWindMs: 40,
    samples: 4,
  },
  /** 每步对应的真实分钟数，待 Eaton 回放标定 */
  stepMinutes: 5,
};

export const TreatmentEffect = {
  break: { fuelMul: 0.05 },
  burn: { fuelMul: 0.3 },
  thin: { rosMul: 0.5 },
  zone0: { emberMul: 0.3 },
};
