import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const mode = process.env.AR_CAPTURE_MODE || "hidden";
const diagnosticDir = join(process.env.RUNNER_TEMP || tmpdir(), "peek-diagnostics", variant, mode);
mkdirSync(diagnosticDir,{recursive:true});
let app, source, proc, handedOff=false, windowID=0;
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
try {
  app = await launch(appPath,{data:join(scratch,"profile"),session:fixture,onboarded:true,js:"none",startTimeout:90000,...(mode==="visible"?{env:{ARDIA_BACKGROUND:null}}:{})});
  source = await app.page("/source");
  assert.equal(await app.eval("return ac.store.getState().settings.pageFrame;"),0);
  const warm = await open(false);
  assert.ok(warm.windowNumber>0);
  await close();
  await describe("source-ready");
  const raw = join(scratch,"window.mp4");
  proc = spawn(recorder,[String(warm.windowNumber),String(app.pid),raw,scratch],{stdio:"inherit"});
  const exited = new Promise((done,fail)=>{proc.once("error",fail); proc.once("exit",(code,signal)=>done({code,signal}));});
  await wait(()=>{assert.equal(proc.exitCode,null,"window recorder exited before capture");return existsSync(join(scratch,"started"));},"recorder start");
  const t0=Date.now();
  await sleep(1600);
  const shown=await open(true);
  assert.equal(shown.windowNumber,warm.windowNumber);
  await sleep(1200);
  const t=(Date.now()-t0)/1000;
  await sleep(2800);
  await close();
  await sleep(1200);
  writeFileSync(join(scratch,"stop"),"");
  const status=await exited;
  assert.equal(status.code,0);
  const meta=JSON.parse(readFileSync(join(scratch,"window.json")));
  const w=Math.round(meta.width),h=Math.round(meta.height);
  const readFrame = (sec) => execFileSync("ffmpeg",["-v","error","-ss",String(sec),"-i",raw,"-frames:v","1","-vf",`scale=${w}:${h}`,"-pix_fmt","rgb24","-f","rawvideo","-"],{maxBuffer:w*h*3+4096});
  const still=readFrame(t),first=readFrame(.5);
  assert.equal(still.length,w*h*3); assert.equal(first.length,w*h*3);
  const origin=shown.stageInWindow,rect=shown.geometry.rest;
  const sample=(frame,x,y)=>{
    const i=Math.round(x)+Math.round(y)*w; assert.ok(x>=0&&x<w&&y>=0&&y<h);
    return [...frame.subarray(i*3,i*3+3)];
  };
  const target=(c)=>Math.max(...c.map((v,i)=>Math.abs(v-[22,120,112][i])))<65 && c[1]-c[0]>48;
  const left=origin.x+rect.x,right=left+rect.width,bottom=origin.y+rect.y+rect.height;
  const inside=[left+rect.width/2,bottom-12];
  console.log(JSON.stringify({sampleTime:t,window:meta,origin,rect,first:sample(first,...inside),article:sample(still,...inside)}));
  assert.ok(target(sample(still,...inside)) && !target(sample(first,...inside)),"video must show the actual target page opening");
  assert.ok(Math.abs(rect.x-shown.geometry.card.x)<.01 && Math.abs(rect.y+rect.height-shown.geometry.card.y-shown.geometry.card.height)<.01,"zero-frame card geometry");
  const pixels=[sample(still,left+1.5,bottom-1.5),sample(still,right-1.5,bottom-1.5)];
  console.log(JSON.stringify({variant,window:warm.windowNumber,width:w,height:h,inside:sample(still,...inside),bottomCorners:pixels}));
  assert.deepEqual(pixels.map(target),Array(2).fill(variant==="before"),"both bottom corners must match the expected revision");
  execFileSync("ffmpeg",["-v","error","-y","-i",raw,"-an","-c:v","libx264","-crf","16","-pix_fmt","yuv420p","-movflags","+faststart",out]);
  handedOff=true;
} catch(e) {
  await describe("failure");
  if(windowID) {
    try{execFileSync("screencapture",["-x","-o","-l",String(windowID),join(diagnosticDir,"ardia-window.png")],{timeout:8000});}catch{}
  }
  throw e;
} finally {
  if (proc && proc.exitCode===null) { writeFileSync(join(scratch,"stop"),""); }
  if (!handedOff) console.error("Unverified outputs were excluded from the video artifact.");
  source?.close();
  if (app) await app.quit();
  await new Promise(done=>site.close(done));
}
