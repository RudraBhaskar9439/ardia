import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [appPath, recorder, out, variant] = process.argv.slice(2);
assert.ok(["before", "after"].includes(variant));
const { launch, session, sleep } = await import(pathToFileURL(resolve("scripts/lib/instance.mjs")));
const scratch = mkdtempSync(join(tmpdir(), "peek-window-"));
const style = "<meta charset=utf-8><style>*{box-sizing:border-box}html,body{margin:0;height:100%}body{display:grid;place-content:center;font:22px -apple-system,sans-serif}h1{font-size:32px}a{color:#184f71}p{margin:0}</style>";
const site = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/source") res.end(style + '<body style="background:#e7edf1;color:#183849"><main><h1>Reading list</h1><a id="link" href="/article" target="_blank">Open the field notes</a></main>');
  else if (req.url === "/article") res.end(style + '<body style="background:#167870;color:white"><main><h1>Field notes</h1><p>Coastal walking routes</p></main>');
  else { res.statusCode = 404; res.end(); }
});
await new Promise(done => site.listen(0, "127.0.0.1", done));
const base = "http://127.0.0.1:" + site.address().port;
const fixture = session({windows:[{id:"w1",frame:[20,30,1000,640]}], tabs:[{id:"a",url:base+"/source"}], settings:{pageFrame:0,addressBar:"toolbar",newTabLinksOpenIn:"peek"}});
const raw = join(scratch,"window.mp4");
const held = join(scratch,"held.png");
const mode = process.env.AR_CAPTURE_MODE || "hidden";
const diagnosticDir = join(process.env.RUNNER_TEMP || tmpdir(), "peek-diagnostics", variant, mode);
mkdirSync(diagnosticDir,{recursive:true});
let app, source, proc, exited, handedOff=false, windowID=0;
let route="click";
async function wait(test, name, timeout = 16000) {
  const end = Date.now()+timeout;
  do { const value = await test(); if (value) return value; await sleep(100); } while (Date.now()<end);
  throw new Error(name+" timed out");
}
async function states() {
  return app.eval('return globalThis.expo.modules.ArdiaPeekStage.devState("w1");');
}
async function opened() {
  const all=await states();
  return all.filter(s=>!s.detached && s.phase==="open").sort((a,b)=>b.generation-a.generation)[0];
}
async function describe(label) {
  if (!app) return;
  const data={label};
  const probes={
    windows:()=>app.windows(),
    stages:async()=>(await states()).map(s=>({generation:s.generation,phase:s.phase,events:s.events?.map(e=>e.event).slice(-10),detached:s.detached,windowNumber:s.windowNumber,geometry:s.geometry,origin:s.stageInWindow})),
    state:()=>app.eval('const s=ac.store.getState();const w=s.windows.w1;return {peek:s.peeks.a,active:w.activeTabIds[w.profileId],tabs:w.tabIds.map(id=>({id,url:s.tabs[id]?.url})),frame:s.settings.pageFrame};'),
    pages:async()=>(await app.targets()).filter(t=>t.type==="page"&&t.url.startsWith(base)).map(t=>({title:t.title,url:t.url})),
  };
  for (const [name,fn] of Object.entries(probes)) { try { data[name]=await fn(); } catch(e){data[name]={error:e.message};} }
  console.log(JSON.stringify(data));
  writeFileSync(join(diagnosticDir,label+".json"),JSON.stringify(data,null,2));
}
async function open(film) {
  const link=await source.eval('(()=>{const a=document.querySelector("#link"),r=a.getBoundingClientRect();return {url:a.href,x:r.x+r.width/2,y:r.y+r.height/2}})()');
  assert.equal(link.url,base+"/article");
  let stage;
  if (route==="click") {
    const {x,y}=link;
    await source.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
    await source.send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x,y});
    await source.send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x,y});
    try { stage=await wait(opened,"link click opening Peek",2600); }
    catch { await describe(film?"recorded-click-fallback":"warmup-click-fallback"); route="openPeek"; }
  }
  if (!stage) {
    await app.eval('const s=ac.store.getState(); if (s.peeks.a) s.closePeek("a"); for(const id of s.windows.w1.tabIds.filter(id=>id!=="a"))s.closeTab(id);s.activate("a");return true;');
    await sleep(450);
    const coord={x:link.x,y:link.y};
    await app.eval('return ac.store.getState().openPeek("a",'+JSON.stringify(link.url)+','+JSON.stringify(coord)+');');
    stage=await wait(opened,"native openPeek opening Peek",12000);
  }
  const article=await app.page(t=>t.url===base+"/article");
  try {
    await wait(()=>article.eval('document.readyState==="complete" && document.querySelector("h1")?.textContent==="Field notes"'),"real article page");
  } finally { article.close(); }
  assert.ok(stage.geometry?.rest?.width>0 && stage.windowNumber>0);
  windowID=stage.windowNumber;
  console.log(JSON.stringify({opening:route,window:windowID,generation:stage.generation,phase:stage.phase}));
  return stage;
}
async function close() {
  await app.eval('ac.store.getState().closePeek("a"); return true;');
  await wait(()=>app.eval('return !ac.store.getState().peeks.a;'),"Peek close");
  await sleep(400);
}
function exportMovie(raw, out, t, meta, left, right, bottom) {
  const movieSize=JSON.parse(execFileSync("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",raw])).streams[0];
  const {width,height}=movieSize;
  const scaleX=width/meta.width,scaleY=height/meta.height;
  const even=v=>2*Math.floor(v/2);
  const tile=even(Math.min(width*.45,height*.67)), patch=even(68*scaleX), header=even(height*.09);
  const gap=even(width/2)-tile;
  const x=edge=>Math.max(0,Math.min(width-patch,even(edge*scaleX-patch/2)));
  const y=Math.max(0,Math.min(height-patch,even(bottom*scaleY-patch/2)));
  const strip=join(scratch,"labels.png"),still=join(scratch,"held-movie-frame.png");
  execFileSync(recorder,["--labels",strip,String(width),String(header)]);
  execFileSync("ffmpeg",["-v","error","-y","-ss",String(t),"-i",raw,"-frames:v","1",still]);
  const crop=edge=>"crop="+patch+":"+patch+":"+x(edge)+":"+y+",scale="+tile+":"+tile+":flags=neighbor,setsar=1";
  const filter=[
    "[0:v]setpts=PTS-STARTPTS,setsar=1,format=yuv420p[full]",
    "[1:v]split=2[l][r]",
    "[l]"+crop(left)+"[left]",
    "[r]"+crop(right)+"[right]",
    "[left]pad="+(tile+gap)+":"+tile+":0:0:color=0x131a20[spaced]",
    "[spaced][right]hstack,pad="+width+":"+tile+":(ow-iw)/2:0:color=0x131a20[patches]",
    "[2:v][patches]vstack,pad="+width+":"+height+":0:(oh-ih)/2:color=0x131a20,format=yuv420p,setsar=1[detail]",
    "[full][detail]concat=n=2:v=1:a=0[v]"
  ].join(";");
  execFileSync("ffmpeg",["-v","error","-y","-i",raw,"-loop","1","-framerate","30","-t","2.5","-i",still,"-loop","1","-framerate","30","-t","2.5","-i",strip,
    "-filter_complex",filter,"-map","[v]","-an","-r","30","-c:v","libx264","-crf","16","-pix_fmt","yuv420p","-movflags","+faststart",out]);
}
try {
  app = await launch(appPath,{data:join(scratch,"profile"),session:fixture,onboarded:true,js:"none",startTimeout:90000,...(mode==="visible"?{env:{ARDIA_BACKGROUND:null}}:{})});
  source = await app.page("/source");
  await wait(()=>source.eval('document.readyState==="complete" && !!document.querySelector("#link")'),"source link ready");
  assert.equal(await app.eval("return ac.store.getState().settings.pageFrame;"),0);
  const warm = await open(false);
  assert.ok(warm.windowNumber>0);
  await sleep(1200);
  execFileSync(recorder,[String(warm.windowNumber),String(app.pid),held,"--still"],{timeout:10000});
  await close();
  await describe("source-ready");
  proc = spawn(recorder,[String(warm.windowNumber),String(app.pid),raw,scratch],{stdio:"inherit"});
  exited = new Promise((done,fail)=>{proc.once("error",fail); proc.once("exit",(code,signal)=>done({code,signal}));});
  await wait(()=>{assert.equal(proc.exitCode,null,"window recorder exited before capture");return existsSync(join(scratch,"started"));},"recorder start");
  const t0=Date.now();
  await sleep(1600);
  const shown=await open(true);
  assert.equal(shown.windowNumber,warm.windowNumber);
  assert.deepEqual(shown.geometry.rest,warm.geometry.rest);
  assert.deepEqual(shown.stageInWindow,warm.stageInWindow);
  await sleep(1200);
  const t=(Date.now()-t0)/1000;
  await sleep(2800);
  await close();
  await sleep(500);
  const tClosed=(Date.now()-t0)/1000;
  await sleep(1200);
  writeFileSync(join(scratch,"stop"),"");
  const status=await exited;
  assert.equal(status.code,0);
  const meta=JSON.parse(readFileSync(join(scratch,"window.json")));
  const w=Math.round(meta.width),h=Math.round(meta.height);
  const readFrame = (sec) => execFileSync("ffmpeg",["-v","error","-ss",String(sec),"-i",raw,"-frames:v","1","-vf",`scale=${w}:${h}`,"-pix_fmt","rgb24","-f","rawvideo","-"],{maxBuffer:w*h*3+4096});
  const still=readFrame(t),first=readFrame(.5),last=readFrame(tClosed);
  for(const frame of [first,still,last]) assert.equal(frame.length,w*h*3);
  const origin=shown.stageInWindow,rect=shown.geometry.rest;
  const sample=(frame,x,y)=>{
    const i=Math.round(x)+Math.round(y)*w; assert.ok(x>=0&&x<w&&y>=0&&y<h);
    return [...frame.subarray(i*3,i*3+3)];
  };
  const target=(c)=>Math.max(...c.map((v,i)=>Math.abs(v-[22,120,112][i])))<65 && c[1]-c[0]>48;
  const left=origin.x+rect.x,right=left+rect.width,bottom=origin.y+rect.y+rect.height;
  const inside=[left+rect.width/2,bottom-12];
  console.log(JSON.stringify({sampleTime:t,window:meta,origin,rect,first:sample(first,...inside),article:sample(still,...inside)}));
  assert.ok(target(sample(still,...inside)) && !target(sample(first,...inside)) && !target(sample(last,...inside)),"the recording must show the target page opening and closing");
  assert.ok(Math.abs(rect.x-shown.geometry.card.x)<.01 && Math.abs(rect.y+rect.height-shown.geometry.card.y-shown.geometry.card.height)<.01,"zero-frame card geometry");
  const dim=JSON.parse(execFileSync("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",held])).streams[0];
  const sx=dim.width/meta.width,sy=dim.height/meta.height;
  assert.ok(Math.abs(sx-sy)<.02 && sx>=.99,"native screenshot scale");
  const rgb=execFileSync("ffmpeg",["-v","error","-i",held,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"],{maxBuffer:dim.width*dim.height*3+4096});
  assert.equal(rgb.length,dim.width*dim.height*3);
  const at=(x,y)=>{
    const i=Math.floor(x*sx),j=Math.floor(y*sy);
    assert.ok(i>=0&&i<dim.width&&j>=0&&j<dim.height);
    return [...rgb.subarray(3*(j*dim.width+i),3*(j*dim.width+i)+3)];
  };
  const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
  const median=a=>a.slice().sort((v,w)=>v-w)[Math.floor(a.length/2)];
  const center=colors=>[0,1,2].map(k=>median(colors.map(c=>c[k])));
  const measure=(edge,direction)=>{
    const p=(dx,dy)=>at(edge+direction*dx,bottom-dy);
    const inside=center([p(12,8),p(14,10),p(16,12),p(20,8),p(24,10)]);
    const outside=center([p(-2,-2),p(-3,-1),p(-1,-3),p(-4,0),p(0,-4)]);
    assert.ok(distance(inside,outside)>20,"the same-frame references must be distinguishable");
    assert.ok(target(inside),"inside reference must be the fixture page");
    const samples=[];
    for (let i=Math.floor((edge-5)*sx);i<=Math.ceil((edge+5)*sx);i++)
      for (let j=Math.floor((bottom-5)*sy);j<=Math.ceil(bottom*sy);j++) {
        const x=(i+.5)/sx,y=(j+.5)/sy,dx=(x-edge)*direction,dy=bottom-y;
        if(dx<1||dy<1||dx+dy>5.05) continue;
        const color=at(x,y);
        const straight=center([p(18,dy),p(24,dy),p(dx,18),p(dx,24),inside]);
        const dIn=distance(color,straight),dOut=distance(color,outside);
        samples.push({column:i,row:j,dx,dy,color,straight,score:(dOut-dIn)/(dIn+dOut||1)});
      }
    assert.ok(samples.length>=3,"enough distinct native corner pixels");
    return {inside,outside,score:median(samples.map(p=>p.score)),samples};
  };
  const corners=[measure(left,1),measure(right,-1)];
  const info={variant,window:windowID,dim,origin,rect,t,tClosed,corners};
  writeFileSync(join(diagnosticDir,"native-corners.json"),JSON.stringify(info,null,2));
  console.log(JSON.stringify({variant,sampleCount:corners.map(c=>c.samples.length),scores:corners.map(c=>c.score),inside:corners.map(c=>c.inside),outside:corners.map(c=>c.outside)}));
  assert.deepEqual(corners.map(c=>Math.sign(c.score)),Array(2).fill(variant==="before"?1:-1),"lossless native corners must favor the matching reference");
  exportMovie(raw,out,t,meta,left,right,bottom);
  handedOff=true;
} catch(e) {
  await describe("failure");
  if(windowID) {
    try{execFileSync("screencapture",["-x","-o","-l",String(windowID),join(diagnosticDir,"ardia-window.png")],{timeout:8000});}catch{}
  }
  throw e;
} finally {
  if (proc && proc.exitCode===null) { writeFileSync(join(scratch,"stop"),""); }
  if (!handedOff) {
    if (exited && proc?.exitCode===null) await Promise.race([exited,sleep(9000)]).catch(()=>{});
    if (existsSync(held)) copyFileSync(held,join(diagnosticDir,"held-native-window.png"));
    if (existsSync(raw)) copyFileSync(raw,join(diagnosticDir,"unverified-window.mp4"));
    console.error("Diagnostic captures are separate from verified video.");
  }
  source?.close();
  if (app) await app.quit();
  await new Promise(done=>site.close(done));
}
