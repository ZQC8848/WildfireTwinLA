// Proposed shared contract: review with A and B before merging.
export interface GridMeta { width:number; height:number; cellSize:number; crs:"EPSG:32611"; originUTM:[number,number]; bboxLonLat:[number,number,number,number] }
export interface Grid { meta:GridMeta; data:Float32Array }
export interface Building { id:string; cell:number; weight:number; polygonLonLat?:number[][] }
export interface Wind { speedMs:number; dirFromDeg:number }
// Row-major samples, north to south. Interpolation uses velocity components.
export type WindField = Wind | { width:number; height:number; samples:Wind[] };
export interface WindScenario { id:string; probability:number; wind:WindField; ignitions:number[]; horizonMinutes:number }
export type TreatmentType = "break" | "burn" | "thin" | "zone0";
export interface Treatment { type:TreatmentType; cells:Uint32Array; cost:number; source:"user"|"greedy"|"mincut" }
export interface Metrics { buildingsThreatened:number; burnedAreaHa:number; cost:number; lossPerDollar:number }
export interface PlanRequest { budget:number; fixed:Treatment[]; scenarios:WindScenario[] }
export interface CoreOptions { buildings?:Building[]; allowed?:(type:TreatmentType,cell:number)=>boolean; cost?:(type:TreatmentType,cell:number)=>number; stripLength?:number; maxIterations?:number }
