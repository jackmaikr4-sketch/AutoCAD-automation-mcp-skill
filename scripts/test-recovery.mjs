import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),run=Date.now(),events=[];
const client=new Client({name:'recovery-acceptance',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/server.mjs')],stderr:'inherit'}));
async function call(name,args={},failure=false){const r=await client.callTool({name,arguments:args},undefined,{timeout:600000});let result;try{result=JSON.parse(r.content[0].text)}catch{result={text:r.content[0].text}}events.push({name,args,result,ok:!r.isError,expectedFailure:failure});await fs.writeFile(path.join(root,'artifacts/recovery-tests.json'),JSON.stringify(events,null,2));assert.equal(!!r.isError,failure,JSON.stringify(result));console.log(name,failure?'EXPECTED REJECTION':'OK');return result;}
let recording=false;
try{
 const manifest=await client.listTools();await fs.writeFile(path.join(root,'docs/tool-manifest.json'),JSON.stringify(manifest,null,2));
 await call('connect_autocad');await call('start_recording',{path:path.join(root,'artifacts',`06-recovery-${run}.mp4`)});recording=true;await call('create_new_drawing');
 const p=await call('draw_polyline',{points:[[0,0,0],[20,0,0],[20,10,0],[0,10,0]]});assert.equal(p.entities[0].closed,false);
 const repair=await call('repair_entity',{handle:p.handles[0],action:'close_polyline'});assert.equal(repair.closed,true);assert.ok(repair.checkpoint.path);
 const ex=await call('extrude_3d',{handle:p.handles[0],height:5,direction:[0,0,2]});assert.ok(Math.abs(ex.entities[0].volume-1000)<1e-7);
 await call('draw_circle',{center:[40,0,0],radius:5,normal:[0,0,1]});await call('draw_circle',{center:[40,0,0],radius:5,normal:[0,1,0]});
 const l=await call('draw_line',{start:[50,0,0],end:[70,0,0]});await call('draw_line',{start:[50,0,0],end:[70,0,0]});
 const before=await call('inspect_drawing');assert.equal(before.confirmed_duplicates.length,1);await call('delete_entities',{handles:before.confirmed_duplicates.map(d=>d.duplicate)});assert.equal((await call('inspect_drawing')).confirmed_duplicates.length,0);
 const count=(await call('get_entity_count')).count;
 await call('create_3d_box',{origin:[0,0,0],length:-1,width:2,height:3},true);
 await call('delete_entities',{handles:[l.handles[0],'7FFFFFFF']},true);assert.equal((await call('get_entity_count')).count,count);await call('get_entity_properties',{handle:l.handles[0]});
 await call('save_drawing',{path:'D:/forbidden-test.dwg'},true);
 const second=await call('draw_line',{start:[50,0,0],end:[50,20,0]});await call('chamfer_geometry',{first:l.handles[0],second:second.handles[0],corner:[100,0,0],keep_first:[70,0,0],keep_second:[50,20,0],distance:1},true);
 const plan=await call('create_modeling_plan',{request:'Failure and no-replay verification',assumptions:[],steps:[{id:'fail',tool:'create_3d_box',args:{origin:[0,0,0],length:-1,width:2,height:3}},{id:'never',tool:'draw_circle',args:{center:[0,0,0],radius:100}}]});
 await call('execute_modeling_plan',{planId:plan.planId},true);const receipt=await call('get_modeling_plan',{planId:plan.planId});assert.equal(receipt.status,'failed');assert.equal(receipt.events[0].status,'failed');assert.ok(receipt.checkpoint.path);assert.equal(receipt.results.never,undefined);await call('execute_modeling_plan',{planId:plan.planId},true);
 const cp=await call('create_modeling_plan',{request:'Cancel between steps',assumptions:[],steps:Array.from({length:30},(_,i)=>({id:'s'+i,tool:'get_entity_count',args:{}}))});
 const running=call('execute_modeling_plan',{planId:cp.planId});await new Promise(r=>setTimeout(r,1000));await call('cancel_task');const stopped=await running;assert.equal(stopped.status,'cancelled');assert.ok(Object.keys(stopped.results).length<30);
 await call('export_dwg',{path:path.join(root,'output',`recovery-${run}.dwg`)});await call('disconnect_autocad');await call('connect_autocad');
 await call('set_view',{view:'isometric',target:[35,5,0],height:100});await call('screenshot',{path:path.join(root,'artifacts/recovery-view.png')});
 await call('stop_recording');recording=false;console.log('RECOVERY ACCEPTANCE PASSED',events.length);
}finally{if(recording)await call('stop_recording');await client.close();}
