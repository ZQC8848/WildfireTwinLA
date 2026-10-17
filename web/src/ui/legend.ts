import { LAYERS, type LayerId } from "../scene/layers";

export class Legend {
  readonly el = document.createElement("div");

  constructor(parent: HTMLElement) {
    this.el.className = "legend";
    parent.appendChild(this.el);
  }

  show(id: LayerId, elevRange: [number, number]) {
    const def = LAYERS[id];
    let body = "";
    if (def.ramp) {
      const labels = id === "elevation" ? [`${Math.round(elevRange[0])} m`, `${Math.round(elevRange[1])} m`] : def.rampLabels!;
      body = `<div class="ramp" style="background:linear-gradient(90deg,${def.ramp.join(",")})"></div>
        <div class="ramp-labels"><span>${labels[0]}</span><span>${labels[1]}</span></div>`;
    } else if (def.swatches) {
      body = def.swatches
        .map((s) => `<div class="swatch"><i style="background:${s.color}"></i>${s.label}</div>`)
        .join("");
    }
    this.el.innerHTML = `<div class="legend-title">${def.label}</div>${body}`;
  }
}
