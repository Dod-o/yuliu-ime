import { AsyncLocalStorage } from 'node:async_hooks';
import process from 'node:process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../work/', import.meta.url));
mkdirSync(dir, { recursive: true });
const local = new AsyncLocalStorage<{id:number; phases:Record<string,number>; events:unknown[]}>();
let counter=0;
const round=(n:number)=>Math.round(n*100)/100;
export async function phase<T>(name:string, fn:()=>Promise<T>, info?:()=>unknown):Promise<T>{
 const trace=local.getStore(), start=performance.now();
 try{return await fn()}finally{if(trace){const ms=performance.now()-start;trace.phases[name]=(trace.phases[name]??0)+ms;trace.events.push({phase:name,ms:round(ms),...info?.() as object});}}
}
export function syncPhase<T>(name:string, fn:()=>T):T{
 const trace=local.getStore(),start=performance.now();
 try{return fn()}finally{if(trace)trace.phases[name]=(trace.phases[name]??0)+performance.now()-start;}
}
export async function trace<T>(kind:string, metadata:object, fn:()=>Promise<T>):Promise<T>{
 const parent=local.getStore()?.id;
 const state={id:++counter,phases:{} as Record<string,number>,events:[] as unknown[]};
 return local.run(state,async()=>{
 const start=performance.now(),cpu=process.cpuUsage();let error:string|undefined;
 try{return await fn()}catch(e){error=String(e);throw e}finally{
 const ms=performance.now()-start,usage=process.cpuUsage(cpu),memory=process.memoryUsage();
 const record={at:new Date().toISOString(),id:state.id,parent,kind,...metadata,total_ms:round(ms),phases_ms:Object.fromEntries(Object.entries(state.phases).map(([k,v])=>[k,round(v)])),events:state.events,cpu_ms:round((usage.user+usage.system)/1000),cpu_core_equivalent:round((usage.user+usage.system)/1000/ms),rss_mb:round(memory.rss/1048576),error};
 appendFileSync(dir+'performance.jsonl',JSON.stringify(record)+'\n');console.log('[perf]',JSON.stringify(record));
 }
 });
}
