import {createCore} from './core.ts';
import type {Grid,CoreOptions,PlanRequest,WindField,WindScenario} from './types.ts';
export type WorkerRequest = {id:string;method:'init';grid:Grid;options?:Omit<CoreOptions,'allowed'|'cost'>}|{id:string;method:'computeArrival';ignitions:number[];wind:WindField;mask:Uint8Array}|{id:string;method:'planTreatments';req:PlanRequest}|{id:string;method:'evaluate';mask:Uint8Array;scenarios:WindScenario[]};
// Dedicated browser worker only. Functions cannot cross structured-clone boundaries.
const scope=globalThis as unknown as {onmessage:(e:MessageEvent<WorkerRequest>)=>void;postMessage:(v:unknown)=>void};
let core:ReturnType<typeof createCore>|undefined;
scope.onmessage=({data:r})=>{try{let result:unknown;if(r.method==='init'){core=createCore(r.grid,r.options);result={ready:true};}else{if(!core)throw Error('Initialize worker first');switch(r.method){case 'computeArrival':result=core.computeArrival(r.ignitions,r.wind,r.mask);break;case 'planTreatments':result=core.planTreatments(r.req);break;case 'evaluate':result=core.evaluate(r.mask,r.scenarios);}}scope.postMessage({id:r.id,result});}catch(e){scope.postMessage({id:r.id,error:e instanceof Error?e.message:String(e)});}};
