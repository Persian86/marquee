const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const Q=require('../public/js/playback-quality');
const read=p=>fs.readFileSync(p,'utf8');
const movie=(height=2160,width=3840)=>({id:1,type:'movie',path:'/media/movie.mp4',duration:120,
  probe:JSON.stringify({height,width,video_codec:'h264',pix_fmt:'yuv420p',format_name:'mp4',bitrate:6000000,audio:[{codec:'aac',channels:2}]})});
function moduleVM(file,mocks,extra='') {
 const ctx={module:{exports:{}},require:k=>{assert.ok(k in mocks,`Unexpected dependency ${k}`);return mocks[k];},Buffer,URL,console,Date,
   setTimeout:()=>({unref(){}}),setInterval:()=>({unref(){}}),setImmediate:()=>{}};
 vm.runInNewContext(read(file)+'\n'+extra,ctx);return ctx.module.exports;
}
function common(){return moduleVM('server/common.js',{'crypto':crypto,'./db':{db:{},refreshDups(){}},'../public/js/playback-quality':Q});}
function streamer(){return moduleVM('server/stream.js',{
 'fs':{mkdirSync(){},readdirSync:()=>[],existsSync:()=>false},'path':path,'crypto':crypto,
 'child_process':{execFileSync(){throw Error('No process allowed in unit test');},spawn(){throw Error('Unexpected transcode');}},
 './config':{TRANSCODE_DIR:'/unit-test',HWACCEL:'none',MAX_TRANSCODES:3},'../public/js/playback-quality':Q
},'module.exports.buildArgsForTest=buildArgs;');}
test('old Auto, lower quality, original and per-profile bandwidth preferences all resolve to fixed 1080p',()=>{
 const C=common();for(const max_quality of [null,'360','480','720','1080'])for(const requested of ['auto','original','360','720','1080',null])
  assert.equal(C.capQuality({max_quality},requested),'1080');
});
test('decode recovery keeps resolution fixed and terminates instead of silently stepping down',()=>{
 const state={mode:'direct',quality:Q.QUALITY};let next=Q.recovery(state);assert.equal(next.forceHls,true);Object.assign(state,next);
 next=Q.recovery(state);assert.equal(next.forceTranscode,true);Object.assign(state,next);
 assert.equal(Q.recovery(state),null);assert.equal(state.quality,'1080');
});
test('source resolution is not invented, including wide cinema and SD sources',()=>{
 assert.equal(Q.requiredHeight(movie()),1080);assert.equal(Q.requiredHeight(movie(720,1280)),720);
 assert.equal(Q.requiredHeight(movie(800,1920)),800);assert.equal(Q.requiredHeight({probe:'invalid'}),1080);
 assert.match(Q.label({sourceHeight:480,prepared:'1080'}),/^Source 480p/);assert.match(Q.label({sourceHeight:2160,transcoding:true}),/^1080p/);
});
test('4K direct play is rejected at fixed 1080, but an original SD source remains playable',()=>{
 const s=streamer();assert.equal(s.decide(movie(),'1080',{h264:true},0).mode,'hls');
 assert.equal(s.decide(movie(480,854),'1080',{h264:true},0).mode,'direct');
 assert.equal(s.decide({probe:'{}'},'1080',{h264:true},0).mode,'hls');
});
test('software and hardware encoders target 1080 while unknown metadata uses an aspect-preserving dynamic scale',()=>{
 const s=streamer();const opts={quality:'1080',dir:'/test',audioIndex:0,start:0,copyVideo:false,copyAudio:true};
 const args=s.buildArgsForTest(movie(),opts,false).args;assert.ok(args.includes('scale=1920:1080,format=yuv420p'));
 const unknown=s.buildArgsForTest({path:'/media/unknown',probe:'{}'},opts,false).args;
 assert.ok(unknown.includes("scale=-2:'min(1080,trunc(ih/2)*2)',format=yuv420p"));
});
function versions(rows=[]) {
 const writes=[];const db={prepare:sql=>({all:()=>rows,
 get:(...args)=>sql.startsWith('SELECT id, type')?{id:1,type:'movie'}:sql==='SELECT * FROM versions WHERE id = ?'?{id:8,quality:'1080'}:null,
 run:(...args)=>{writes.push({sql,args});return {lastInsertRowid:8};}})};
 const v=moduleVM('server/features/versions.js',{
 'fs':{mkdirSync(){},existsSync:()=>true},'path':path,'child_process':{spawn(){throw Error('Unexpected transcode');}},
 '../db':{db,getSetting:()=> '0'},'../config':{TRANSCODE_DIR:'/test',HWACCEL:'none'},'../../public/js/playback-quality':Q
 });return {v,writes};
}
test('an existing 720p prepared copy cannot replace a 1080p movie',()=>{
 const {v}=versions([{id:1,quality:'720',path:'/720'},{id:2,quality:'480',path:'/480'}]);
 assert.equal(v.bestReady(1,1080,1080),null);assert.equal(v.bestReady(1,1080,720).quality,'720');
});
test('the matching prepared copy is selected and stale/unknown quality labels are ignored',()=>{
 const {v}=versions([{id:1,quality:'720',path:'/720'},{id:2,quality:'1080',path:'/1080'},{id:3,quality:'bad',path:'/bad'}]);
 assert.equal(v.bestReady(1,1080,1080).quality,'1080');
});
test('new downloads and prepared-copy requests override old lower-quality preferences',()=>{
 const {v,writes}=versions();const result=v.request(1,'480','download');assert.equal(result.quality,'1080');
 const insert=writes.find(x=>x.sql.startsWith('INSERT INTO versions'));assert.equal(insert.args[1],'1080');
});
function cast(){const chosen=[];const media=movie();const c=moduleVM('server/features/cast.js',{
 'crypto':crypto,'fs':{existsSync:()=>true},'path':path,'child_process':{spawn(){throw Error('Unexpected transcode');}},
 '../db':{db:{},getSetting:()=> 'unit-test-secret'},'../stream':{},'./versions':{bestReady:(...a)=>{chosen.push(a);return null;}},
 '../../public/js/playback-quality':Q
 });return {c,chosen};}
test('Chromecast and native cast links carry 1080 even when an old client asks for 480',()=>{
 const {c,chosen}=cast();const result=c.prepare(movie(),{quality:'480',base:'http://media.test'});
 const token=result.url.split('/cast/')[1].split('/')[0];const payload=JSON.parse(Buffer.from(token.split('.')[0],'base64url'));
 assert.equal(payload.q,'1080');assert.equal(chosen[0][1],1080);assert.equal(chosen[0][2],1080);
});
function playRoute(item,allowed={ok:true}) {
 const code=read('server/routes/core.js');const start=code.indexOf("r.post('/play/:id'");const end=code.indexOf('// Can this profile',start);
 const s=streamer(),seen={};let handler;
 const stream={...s,listSubtitles:()=>[],audioTracks:()=>[],startSession:(row,opts)=>{seen.stream=opts;return{id:'s',start:0};},sessions:new Map()};
 vm.runInNewContext(code.slice(start,end),{r:{post:(p,h)=>handler=h},getVisibleItem:()=>item,activity:{check:()=>allowed,startPlay:()=> 'play'},
 fs:{existsSync:()=>true},C:common(),subtitles:{configured:()=>false},stream,
 versions:{bestReady:(...args)=>{seen.prepared=args;return null;}},chaptersOf:()=>[],hdrOf:()=>false});
 const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;}};
 handler({profile:{id:1,max_quality:'480'},params:{id:1},body:{quality:'720'},headers:{},ip:'test'},res);return{seen,res};
}
test('the real play route enforces 1080 before choosing a stream or a prepared copy',()=>{
 const {seen,res}=playRoute(movie());assert.equal(res.body.quality,'1080');assert.equal(res.body.maxQuality,'1080');
 assert.equal(res.body.qualityPolicy,'fixed-1080');assert.equal(seen.stream.quality,'1080');assert.equal(seen.prepared[2],1080);
});
test('the quality policy does not bypass library visibility or screen-time checks',()=>{
 assert.equal(playRoute(null).res.code,404);const result=playRoute(movie(),{ok:false,message:'Time is up',reason:'limit'});
 assert.equal(result.res.code,403);assert.equal(result.seen.stream,undefined);
});
const ffmpeg=process.env.FFMPEG || 'ffmpeg';const available=spawnSync(ffmpeg,['-version'],{encoding:'utf8'}).status===0;
test('the actual FFmpeg filter produces 1080 from 4K and preserves SD without upscaling',{skip:!available},()=>{
 for(const [size,width,height] of [['3840x2160',1920,1080],['854x480',854,480]]){
  const result=spawnSync(ffmpeg,['-hide_banner','-f','lavfi','-i',`testsrc2=size=${size}:rate=1`,'-vf',Q.scaleFilter({probe:'{}'}),'-frames:v','1','-f','null','-'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stderr,new RegExp(`wrapped_avframe[^\\n]*${width}x${height}`));
 }
});
