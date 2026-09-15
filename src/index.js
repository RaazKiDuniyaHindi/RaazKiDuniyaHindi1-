import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import { Client } from '@gradio/client';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(__dirname,'..');
const app=express();
const upload=multer({dest:path.join(root,'uploads')});
const jobs=new Map();

const SPACE='FrameAI4687/Omni-Video-Factory';
const SPACE_URL='https://frameai4687-omni-video-factory.hf.space';

fs.mkdirSync(path.join(root,'uploads'),{recursive:true});
fs.mkdirSync(path.join(root,'renders'),{recursive:true});

app.use(express.json({limit:'5mb'}));
app.use(express.static(root));
app.use('/renders',express.static(path.join(root,'renders')));
app.get('/',(q,r)=>r.sendFile(path.join(root,'index.html')));

let cp,ap;

async function client(){
  if(!cp)cp=Client.connect(
    SPACE,
    process.env.HF_TOKEN?{token:process.env.HF_TOKEN}:undefined
  );
  return cp;
}

async function api(){
  if(!ap)ap=client().then(x=>x.view_api(true));
  return ap;
}

function split(s){
  return s.replace(/\s+/g,' ').trim()
    .split(/(?<=[.!?।])\s+/)
    .filter(Boolean).slice(0,4);
}

function endpoint(a){
  const x=[
    ...Object.entries(a?.named_endpoints||{}),
    ...Object.entries(a?.unnamed_endpoints||{})
  ];
  return x.find(([n,v])=>{
    const s=JSON.stringify(v).toLowerCase();
    return s.includes('scene count')&&
      s.includes('seconds per scene')&&
      s.includes('aspect ratio')&&
      s.includes('base prompt');
  });
}

function makeInputs(info,o){
  return (info.parameters||[]).map(p=>{
    const n=String(p.label||p.name||'').toLowerCase();

    if(n.includes('scene count'))return o.count;
    if(n.includes('seconds per scene'))return 3;
    if(n.includes('resolution'))return 384;
    if(n.includes('aspect ratio'))return o.ratio;
    if(n.includes('base prompt'))return o.base;

    for(let i=1;i<=4;i++)
      if(n.includes('scene '+i)||n.startsWith('s'+i))
        return o.sc[i-1]||'';

    return null;
  });
}

function video(v,seen=new Set()){
  if(!v)return null;

  if(typeof v==='string'){
    if(/^https?:\/\//i.test(v))return v;
    if(/\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(v))
      return SPACE_URL+'/gradio_api/file='+encodeURIComponent(v);
    return null;
  }

  if(typeof v!=='object'||seen.has(v))return null;
  seen.add(v);

  if(Array.isArray(v))
    for(const x of v){
      const u=video(x,seen);
      if(u)return u;
    }

  for(const k of ['url','path','video','file','data','value','output']){
    if(k in v){
      const u=video(v[k],seen);
      if(u)return u;
    }
  }
  return null;
}

app.get('/api/status',async(q,r)=>{
  try{
    const e=endpoint(await api());
    r.json({space:SPACE,t2vEndpoint:e?.[0]||null});
  }catch(e){
    r.status(503).json({error:e.message});
  }
});

app.post('/api/generate',
upload.fields([
  {name:'voice',maxCount:1},
  {name:'music',maxCount:1},
  {name:'characterImage',maxCount:1}
]),async(q,r)=>{

  const script=q.body?.script?.trim();
  if(!script)return r.status(400).json({error:'Script is required.'});

  const sc=split(script);
  const id=Date.now().toString();

  jobs.set(id,{status:'generating',progress:5,scenes:[]});
  r.json({jobId:id,sceneCount:sc.length});

  try{
    const a=await api();
    const e=endpoint(a);

    if(!e)throw Error('Omni Video Factory T2V endpoint नहीं मिला।');

    const count=Math.min(Math.max(sc.length,1),4);
    const ratio=['9:16','16:9','4:3','1:1','3:4']
      .includes(q.body.format)?q.body.format:'9:16';

    const base=
      `Cinematic ${q.body.style||'Mystery'} Hindi documentary. `+
      `Realistic visuals, no text, no subtitles, no logos.`;

    const job=(await client()).submit(
      e[0],
      makeInputs(e[1],{count,ratio,base,sc})
    );

    let data;

    for await(const m of job){
      if(m?.type==='status')
        jobs.set(id,{
          status:'generating',
          progress:Math.min((jobs.get(id)?.progress||5)+2,85),
          scenes:[]
        });

      if(m?.type==='data')data=m.data;
    }

    const u=video(data);
    if(!u)throw Error('AI output मिला लेकिन video URL नहीं मिला।');

    jobs.set(id,{status:'ready',progress:100,scenes:[u]});

  }catch(e){
    console.error(e);
    jobs.set(id,{
      status:'error',
      progress:0,
      scenes:[],
      error:e.message
    });
  }
});

app.get('/api/job/:id',(q,r)=>{
  r.json(jobs.get(q.params.id)||{status:'not_found'});
});

app.post('/api/render',
upload.fields([
  {name:'voice',maxCount:1},
  {name:'music',maxCount:1}
]),async(q,r)=>{

  const j=jobs.get(q.body.jobId);

  if(!j||j.status!=='ready')
    return r.status(400).json({
      error:'पहले AI video generate करें।'
    });

  const out=path.join(
    root,'renders',q.body.jobId+'.mp4'
  );

  try{
    const x=await fetch(j.scenes[0]);
    if(!x.ok)throw Error('AI video download failed.');

    fs.writeFileSync(
      out,
      Buffer.from(await x.arrayBuffer())
    );

    const voice=q.files?.voice?.[0]?.path;
    const music=q.files?.music?.[0]?.path;

    if(!voice&&!music)
      return r.json({
        video:'/renders/'+path.basename(out)
      });

    const final=out.replace('.mp4','_final.mp4');
    const cmd=ffmpeg(out);

    if(voice)cmd.input(voice);
    if(music)cmd.input(music);

    let opts=['-map','0:v:0'];

    if(voice&&music){
      opts.push(
        '-filter_complex',
        '[1:a]volume=1[a];[2:a]volume=.18[b];[a][b]amix=2:duration=first[aout]',
        '-map','[aout]'
      );
    }else{
      opts.push('-map','1:a:0');
    }

    opts.push(
      '-c:v','libx264',
      '-c:a','aac',
      '-shortest'
    );

    await new Promise((ok,no)=>
      cmd.outputOptions(opts)
        .save(final)
        .on('end',ok)
        .on('error',no)
    );

    r.json({
      video:'/renders/'+path.basename(final)
    });

  }catch(e){
    r.status(500).json({error:e.message});
  }
});

const PORT=Number(process.env.PORT||3000);

app.listen(PORT,()=>console.log(
  'Raz Ki Duniya running on '+PORT
));
