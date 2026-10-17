import type {Grid,Wind,WindField} from './types.ts';
import {SpreadParams as P,TreatmentEffect as E,PlanningParams as R} from './params.ts';
export function windAt(g:Grid,c:number,field:WindField):Wind {if('speedMs' in field)return field;const {width:w,height:h,samples}=field;if(w<1||h<1||samples.length!==w*h)throw Error('Invalid wind field');const x=(c%g.meta.width)/Math.max(1,g.meta.width-1)*(w-1),y=Math.floor(c/g.meta.width)/Math.max(1,g.meta.height-1)*(h-1),x0=Math.floor(x),y0=Math.floor(y);let east=0,north=0;for(let j=0;j<2;j++)for(let i=0;i<2;i++){const s=samples[Math.min(h-1,y0+j)*w+Math.min(w-1,x0+i)],weight=(i?x-x0:1-x+x0)*(j?y-y0:1-y+y0),d=s.dirFromDeg*Math.PI/180;east-=weight*s.speedMs*Math.sin(d);north-=weight*s.speedMs*Math.cos(d);}return {speedMs:Math.hypot(east,north),dirFromDeg:(Math.atan2(-east,-north)*180/Math.PI+360)%360};}
// Directional surface ROS proxy, m/min. Not a full Rothermel implementation.
// CA probability is not a speed; this explicit mapping needs empirical calibration.
export function edgeMinutes(g:Grid,u:number,v:number,wind:WindField,mask:Uint8Array):number {
 const d=g.data,o=v*4;if(d[o+3]===0||d[u*4+3]===0)return Infinity;
 const w=g.meta.width,dx=v%w-u%w,dy=Math.floor(v/w)-Math.floor(u/w),dist=g.meta.cellSize*Math.hypot(dx,dy),s=windAt(g,v,wind);
 if(!Number.isFinite(s.speedMs)||s.speedMs<0||!Number.isFinite(s.dirFromDeg))throw Error('Invalid wind');
 const theta=s.dirFromDeg*Math.PI/180,cos=(-Math.sin(theta)*dx+Math.cos(theta)*dy)/Math.hypot(dx,dy),slope=Math.atan2(d[o]-d[u*4],dist)*180/Math.PI;
 const fuel=d[o+1]*(mask[v]===1?E.break.fuelMul:mask[v]===2?E.burn.fuelMul:1);
 if(fuel<=0)return Infinity;
 const ros=R.baseRosMPerMinute*fuel*(.25+.75*d[o+2])*Math.exp(Math.max(-20,Math.min(20,P.c1*s.speedMs+P.c2*s.speedMs*(cos-1)+P.a*slope)))*(mask[v]===3?E.thin.rosMul:1)*(5/P.stepMinutes);
 return dist/Math.max(R.minRos,Math.min(R.maxRos,ros));
}
