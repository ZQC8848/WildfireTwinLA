import type {Grid,Treatment} from './types.ts';
import {neighbors,canStep} from './grid.ts';
// Node-split residual network; iterative augmenting paths avoid JS stack overflow.
// Topological lower-bound baseline: finite break treatments do NOT sever edges.
export function minCutBaseline(g:Grid,sources:number[],targets:number[],cost:(c:number)=>number,allowed:(c:number)=>boolean=()=>true):Treatment[] {
 const n=g.meta.width*g.meta.height,src=2*n,sink=src+1,N=sink+1,adj:{v:number;r:number;cap:number}[][]=Array.from({length:N},()=>[]),caps=new Float64Array(n),blocked=new Set([...sources,...targets]);
 let total=0;for(let c=0;c<n;c++){if(g.data[c*4+3]&&!blocked.has(c)&&allowed(c)){caps[c]=cost(c);if(!Number.isFinite(caps[c])||caps[c]<=0)throw Error('Invalid cut cost');total+=caps[c];}}
 const inf=total+1;function add(u:number,v:number,cap:number){adj[u].push({v,r:adj[v].length,cap});adj[v].push({v:u,r:adj[u].length-1,cap:0});}
 for(let c=0;c<n;c++)if(g.data[c*4+3]){add(2*c,2*c+1,caps[c]||inf);for(const v of neighbors(g,c))if(g.data[v*4+3]&&canStep(g,c,v))add(2*c+1,2*v,inf);}
 for(const c of sources){if(c<0||c>=n)throw Error('Invalid source');if(g.data[c*4+3])add(src,2*c,inf);}for(const c of targets){if(c<0||c>=n)throw Error('Invalid target');if(g.data[c*4+3])add(2*c+1,sink,inf);}
 let flow=0;let seen=new Uint8Array(N);while(true){const prev=new Int32Array(N).fill(-1),pe=new Int32Array(N),q=[src];seen=new Uint8Array(N);seen[src]=1;for(let h=0;h<q.length&&!seen[sink];h++){const u=q[h];for(let j=0;j<adj[u].length;j++){const e=adj[u][j];if(e.cap>1e-9&&!seen[e.v]){seen[e.v]=1;prev[e.v]=u;pe[e.v]=j;q.push(e.v);}}}if(!seen[sink])break;let amount=inf;for(let v=sink;v!==src;v=prev[v])amount=Math.min(amount,adj[prev[v]][pe[v]].cap);for(let v=sink;v!==src;v=prev[v]){const e=adj[prev[v]][pe[v]];e.cap-=amount;adj[v][e.r].cap+=amount;}flow+=amount;if(flow>=inf)throw Error('No finite admissible separating cut');}
 const cells:number[]=[];for(let c=0;c<n;c++)if(seen[2*c]&&!seen[2*c+1]&&caps[c])cells.push(c);return cells.length?[{type:'break',cells:Uint32Array.from(cells),cost:cells.reduce((s,c)=>s+caps[c],0),source:'mincut'}]:[];
}
