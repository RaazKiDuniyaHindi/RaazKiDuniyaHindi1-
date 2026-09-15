import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {fileURLToPath} from 'url';
import {Client} from '@gradio/client';
import ffmpeg from 'fluent-ffmpeg';

const d=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(d,'..');
const app=express();
const up=multer({dest:path.join(root,'uploads')});
const jobs=new Map();

const SPACE='FrameAI4687/Omni-Video-Factory';
const URL='https://frameai4687-omni-video-factory.hf.space';

fs.mkdirSync(path.join(root,'uploads'),{recursive:true});
fs.mkdirSync(path.join(root,'renders'),{recursive:true});

app.use(express.json({limit:'5mb'}));
app.use(express.static(root));
app.use('/renders',express.static(path.join(root,'renders')));
app.get('/',(q,r)=>r.sendFile(path.join(root,'index.html')));

let C;
const client=async()=>C||(C=await Client.connect(SPACE));

function findT2V(a){
  const all=[
    ...Object.entries(a.named_endpoints||{}),
    ...Object.entries(a.unnamed_endpoints||{})
  ];
  return all.find(([n,v])=>{
    const s=JSON.stringify(v).toLowerCase();
    return s.includes('scene count')&&
      s.includes('seconds per scene')&&
      s.includes('aspect ratio');
  });
}

function vid(x){
  if(!x)return null;
  if(typeof x==='string'){
    if(/^https?:/i.test(x))return x;
    if(/\.(mp4|webm|mov|m4v)/i.test(x))
      return URL+'/gradio_api/file='+encodeURIComponent(x);
  }
  if(Array.isArray(x))
    for(const y of x){let z=vid(y);if(z)return z}
  if(typeof x==='object')
    for(const k of ['url','path','video','file','data','value','output']){
      let z=vid(x[k]);if(z)return z;
    }
  return null;
}

app.post('/api/generate',
up.fields([
  {name:'voice',maxCount:1},
  {name:'music',maxCount:1},
  {name:'characterImage',maxCount:1}
]),async(q,r)=>{

  if(!q.body.script?.trim())
    return r.status(400).json({error:'Script डालें।'});

  const id=Date.now().toString();
  jobs.set(id,{status:'generating',progress:5,scenes:[]});
  r.json({jobId:id,sceneCount:1});

  try{
    const c=await client();
    const a=await c.view_api(true);
    const e=findT2V(a);

    if(!e)throw Error('T2V API schema नहीं मिला।');

    const p=e[1].parameters||[];
    const s=[q.body.script.trim()];

    const input=p.map(x=>{
      const n=String(x.label||x.name||'').toLowerCase();
      if(n.includes('scene count'))return 1;
      if(n.includes('seconds per scene'))return 3;
      if(n.includes('resolution'))return 384;
      if(n.includes('aspect ratio'))return q.body.format||'9:16';
      if(n.includes('base prompt'))
        return `Cinematic ${q.body.style||'Mystery'} realistic video`;
      if(n.includes('scene 1')||n.startsWith('s1'))return s[0];
      if(n.includes('scene 2')||n.startsWith('s2'))return '';
      if(n.includes('scene 3')||n.startsWith('s3'))return '';
      if(n.includes('scene 4')||n.startsWith('s4'))return '';
      return null;
    });

    const job=c.submit(e[0],input);
    let data;

    for await(const m of job){
      if(m.type==='status')
        jobs.set(id,{status:'generating',progress:30,scenes:[]});
      if(m.type==='data')data=m.data;
    }

    const u=vid(data?.[1])||vid(data);

    if(!u)throw Error('AI ने video URL नहीं दिया।');

    jobs.set(id,{status:'ready',progress:100,scenes:[u]});

  }catch(e){
    console.error(e);
    jobs.set(id,{status:'error',progress:0,scenes:[],error:e.message});
  }
});

app.get('/api/job/:id',(q,r)=>
  r.json(jobs.get(q.params.id)||{status:'not_found'})
);

app.post('/api/render',
up.fields([{name:'voice',maxCount:1},{name:'music',maxCount:1}]),
async(q,r)=>{

  const j=jobs.get(q.body.jobId);
  if(!j||j.status!=='ready')
    return r.status(400).json({error:'पहले video generate करें।'});

  const out=path.join(root,'renders',q.body.jobId+'.mp4');

  try{
    const x=await fetch(j.scenes[0]);
    fs.writeFileSync(out,Buffer.from(await x.arrayBuffer()));

    const v=q.files?.voice?.[0]?.path;
    const m=q.files?.music?.[0]?.path;

    if(!v&&!m)
      return r.json({video:'/renders/'+path.basename(out)});

    const fin=out.replace('.mp4','_final.mp4');
    const f=ffmpeg(out);

    if(v)f.input(v);
    if(m)f.input(m);

    let o=['-map','0:v:0'];

    if(v&&m)
      o.push(
        '-filter_complex',
        '[1:a]volume=1[a];[2:a]volume=.18[b];[a][b]amix=2:duration=first[aout]',
        '-map','[aout]'
      );
    else o.push('-map','1:a:0');

    o.push('-c:v','libx264','-c:a','aac','-shortest');

    await new Promise((ok,no)=>
      f.outputOptions(o).save(fin).on('end',ok).on('error',no)
    );

    r.json({video:'/renders/'+path.basename(fin)});

  }catch(e){
    r.status(500).json({error:e.message});
  }
});

app.listen(Number(process.env.PORT||3000),
()=>console.log('Raz Ki Duniya started'));
