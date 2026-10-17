import type { Grid,GridMeta,Treatment } from './types.ts';
export function readGrid(meta:GridMeta,buffer:ArrayBuffer):Grid {
 if(meta.crs!=='EPSG:32611'||!Number.isInteger(meta.width)||!Number.isInteger(meta.height)||meta.width<1||meta.height<1||!(meta.cellSize>0)) throw Error('Invalid grid metadata');
 if(buffer.byteLength!==meta.width*meta.height*16) throw Error('Expected four little-endian float32 values per cell');
 const view=new DataView(buffer),data=new Float32Array(buffer.byteLength/4);
 for(let i=0;i<data.length;i++) { data[i]=view.getFloat32(i*4,true); if(!Number.isFinite(data[i])) throw Error('Nonfinite grid value'); }
 for(let i=0;i<data.length;i+=4) if(data[i+1]<0||data[i+1]>1||data[i+2]<0||data[i+2]>1||![0,1,2].includes(data[i+3])) throw Error('Invalid fuel, dryness or class');
 return {meta,data};
}
export const treatmentCode={break:1,burn:2,thin:3,zone0:4} as const;
export function treatmentMask(n:number,ts:Treatment[]):Uint8Array { const m=new Uint8Array(n); for(const t of ts) for(const c of t.cells) {if(c>=n) throw Error('Treatment out of bounds'); if(m[c]&&m[c]!==treatmentCode[t.type]) throw Error('Conflicting treatments'); m[c]=treatmentCode[t.type];} return m; }
export function neighbors(g:Grid,c:number):number[] {const {width:w,height:h}=g.meta,x=c%w,y=Math.floor(c/w),out:number[]=[];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if((dx||dy)&&x+dx>=0&&x+dx<w&&y+dy>=0&&y+dy<h)out.push((y+dy)*w+x+dx);return out;}
// Block diagonal corner cutting across nonburnable orthogonal neighbors.
export function canStep(g:Grid,u:number,v:number):boolean {const w=g.meta.width,dx=v%w-u%w,dy=Math.floor(v/w)-Math.floor(u/w);return !dx||!dy||!!(g.data[(u+dx)*4+3]&&g.data[(u+dy*w)*4+3]);}
export function downsample(g:Grid,factor:number):Grid {if(!Number.isInteger(factor)||factor<1||g.meta.width%factor||g.meta.height%factor)throw Error('Factor must divide dimensions');const w=g.meta.width/factor,h=g.meta.height/factor,data=new Float32Array(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){let classes=[0,0,0];for(let dy=0;dy<factor;dy++)for(let dx=0;dx<factor;dx++){const s=((y*factor+dy)*g.meta.width+x*factor+dx)*4,d=(y*w+x)*4;for(let k=0;k<3;k++)data[d+k]+=g.data[s+k]/(factor*factor);classes[g.data[s+3]]++;}data[(y*w+x)*4+3]=classes[2]?2:classes[1]?1:0;}return {meta:{...g.meta,width:w,height:h,cellSize:g.meta.cellSize*factor},data};}
export function remapCell(cell:number,sourceWidth:number,targetWidth:number,factor:number):number{return Math.floor(Math.floor(cell/sourceWidth)/factor)*targetWidth+Math.floor((cell%sourceWidth)/factor);}
export function upsampleMask(mask:Uint8Array,width:number,height:number,factor:number):Uint8Array {if(mask.length!==width*height||!Number.isInteger(factor)||factor<1)throw Error('Invalid mask or factor');const out=new Uint8Array(width*height*factor*factor);for(let y=0;y<height*factor;y++)for(let x=0;x<width*factor;x++)out[y*width*factor+x]=mask[Math.floor(y/factor)*width+Math.floor(x/factor)];return out;}
