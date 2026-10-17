import type {Grid,CoreOptions,WindField,WindScenario,PlanRequest,Treatment,TreatmentType,Metrics} from './types.ts';
import {PlanningParams} from './params.ts';
import {treatmentMask,treatmentCode} from './grid.ts';
import {shortestPaths,pathFlow} from './dijkstra.ts';
import {minCutBaseline} from './mincut.ts';
export function createCore(grid:Grid,options:CoreOptions={}) {
 const n=grid.meta.width*grid.meta.height,buildings=options.buildings??[],cost=options.cost??((type:TreatmentType)=>PlanningParams.costPerCell[type]);
 for(const b of buildings)if(!Number.isInteger(b.cell)||b.cell<0||b.cell>=n||!Number.isFinite(b.weight)||b.weight<0)throw Error('Invalid building');
 const allowed=(type:TreatmentType,c:number)=>(type==='zone0'?grid.data[c*4+3]===2:grid.data[c*4+3]===1)&&(options.allowed?.(type,c)??true);
 function cellCost(type:TreatmentType,c:number){const v=cost(type,c);if(!Number.isFinite(v)||v<=0)throw Error('Cost must be finite and positive');return v;}
 function scenarios(s:WindScenario[]){if(!s.length||s.some(x=>!Number.isFinite(x.probability)||x.probability<0||!Number.isFinite(x.horizonMinutes)||x.horizonMinutes<0)||s.reduce((a,x)=>a+x.probability,0)<=0)throw Error('Invalid scenarios');const sum=s.reduce((a,x)=>a+x.probability,0);return s.map(x=>({...x,probability:x.probability/sum}));}
 function computeArrival(ignitions:number[],wind:WindField,mask:Uint8Array):Float32Array{return Float32Array.from(shortestPaths(grid,ignitions,wind,mask).arrival);}
 function loss(mask:Uint8Array,ss:WindScenario[]){let weighted=0,threatened=0,area=0;for(const s of ss){const a=shortestPaths(grid,s.ignitions,s.wind,mask).arrival;for(const b of buildings)if(a[b.cell]<=s.horizonMinutes){weighted+=s.probability*b.weight;threatened+=s.probability;}for(let c=0;c<n;c++)if(a[c]<=s.horizonMinutes)area+=s.probability*grid.meta.cellSize**2/10000;}return {weighted,threatened,area};}
 function evaluate(mask:Uint8Array,s:WindScenario[]):Metrics {const ss=scenarios(s),after=loss(mask,ss),before=loss(new Uint8Array(n),ss);let total=0;const names:TreatmentType[]=['break','burn','thin','zone0'];for(let c=0;c<n;c++)if(mask[c])total+=cellCost(names[mask[c]-1],c);return {buildingsThreatened:after.threatened,burnedAreaHa:after.area,cost:total,lossPerDollar:total?(before.weighted-after.weighted)/total:0};}
 function planTreatments(req:PlanRequest):Treatment[] {
 if(!Number.isFinite(req.budget)||req.budget<0)throw Error('Invalid budget');const ss=scenarios(req.scenarios),out=req.fixed.map(t=>({...t,cells:t.cells.slice()}));let mask=treatmentMask(n,out),spent=0;
 for(let c=0;c<n;c++)if(mask[c]){const type=(['break','burn','thin','zone0'] as TreatmentType[])[mask[c]-1];if(!allowed(type,c))throw Error('Fixed treatment prohibited');spent+=cellCost(type,c);}if(spent>req.budget)throw Error('Fixed treatments exceed budget');
 for(let iteration=0;iteration<(options.maxIterations??20);iteration++){
 const flow=new Float64Array(n);let tree:Int32Array|undefined;for(const s of ss){const p=shortestPaths(grid,s.ignitions,s.wind,mask),f=pathFlow(p.parent,p.order,buildings.filter(b=>p.arrival[b.cell]<=s.horizonMinutes));tree??=p.parent;for(let c=0;c<n;c++)flow[c]+=s.probability*f[c];}
 const ranked=Array.from({length:n},(_,c)=>c).filter(c=>!mask[c]&&flow[c]>0).sort((a,b)=>flow[b]/cellCost('break',b)-flow[a]/cellCost('break',a)).slice(0,24);
 const before=loss(mask,ss).weighted;let best:Treatment|undefined,bestScore=0;
 for(const c of ranked)for(const type of ['break','burn','thin'] as TreatmentType[]){const p=tree![c],w=grid.meta.width,dx=p<0?0:c%w-p%w,dy=p<0?1:Math.floor(c/w)-Math.floor(p/w),sx=dy===0?0:-Math.sign(dy),sy=dx===0?0:Math.sign(dx),cells:number[]=[];
 const half=Math.floor((options.stripLength??5)/2);for(let k=-half;k<=half;k++){const x=c%w+k*sx,y=Math.floor(c/w)+k*sy,v=y*w+x;if(x>=0&&x<w&&y>=0&&y<grid.meta.height&&!mask[v]&&allowed(type,v))cells.push(v);}const unique=[...new Set(cells)],price=unique.reduce((a,v)=>a+cellCost(type,v),0);if(!price||spent+price>req.budget)continue;
 const candidate=mask.slice();for(const v of unique)candidate[v]=treatmentCode[type];const gain=before-loss(candidate,ss).weighted,score=gain/price;if(score>bestScore){bestScore=score;best={type,cells:Uint32Array.from(unique),cost:price,source:'greedy'};}}
 if(!best)break;out.push(best);spent+=best.cost;mask=treatmentMask(n,out);
 }return out;
 }
 function planMinCut(ignitions:number[]){return minCutBaseline(grid,ignitions,buildings.map(b=>b.cell),c=>cellCost('break',c),c=>allowed('break',c));}
 return {computeArrival,planTreatments,evaluate,planMinCut};
}
