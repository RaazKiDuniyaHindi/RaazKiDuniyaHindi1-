import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import RunwayML from '@runwayml/sdk';
import ffmpeg from 'fluent-ffmpeg';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(__dirname,'..');
const app=express();
const upload=multer({dest:path.join(root,'uploads')});
fs.mkdirSync(path.join(root,'uploads'),{recursive:true});
fs.mkdirSync(path.join(root,'renders'),{recursive:true});
app.use(express.json({limit:'5mb'}));
app.use(express.static(path.join(root,'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const client = process.env.RUNWAYML_API_SECRET ? new RunwayML({apiKey:process.env.RUNWAYML_API_SECRET}) : null;
const jobs=new Map();
const splitScenes=(s)=>s.replace(/\s+/g,' ').trim().split(/(?<=[.!?।])\s+/).filter(Boolean).slice(0,20);

app.get('/api/status',(req,res)=>res.json({runwayConfigured:!!client,ffmpeg:true}));
app.post('/api/generate',upload.fields([{name:'voice',maxCount:1},{name:'music',maxCount:1},{name:'characterImage',maxCount:1}]),async(req,res)=>{
  if(!client) return res.status(400).json({error:'Runway API key is not configured. Put RUNWAYML_API_SECRET in .env on the server.'});
  const {script,format='9:16',style='Mystery',characterMode='off'}=req.body;
  if(!script?.trim()) return res.status(400).json({error:'Script is required.'});
  const scenes=splitScenes(script);
  const id=Date.now().toString();
  jobs.set(id,{status:'generating',progress:0,scenes:[]});
  res.json({jobId:id,sceneCount:scenes.length});
  (async()=>{
    try{
      const ratio=format==='16:9'?'1280:720':'720:1280';
      const urls=[];
      for(let i=0;i<scenes.length;i++){
        const prompt=`Cinematic Hindi mystery documentary scene. Style: ${style}. No text, no subtitles, no logos. Visualize this narration: ${scenes[i]}`;
        const task=await client.imageToVideo.create({model:'gen4.5',promptText:prompt,ratio,duration:5}).waitForTaskOutput();
        const url=task.output?.[0]; if(!url) throw new Error('Runway returned no video URL');
        urls.push(url); jobs.set(id,{status:'generating',progress:Math.round(((i+1)/scenes.length)*75),scenes:urls});
      }
      jobs.set(id,{status:'ready',progress:75,scenes:urls,characterMode});
    }catch(e){ jobs.set(id,{status:'error',progress:0,error:e?.message||String(e)}); }
  })();
});
app.get('/api/job/:id',(req,res)=>res.json(jobs.get(req.params.id)||{status:'not_found'}));

app.post('/api/render',upload.fields([{name:'voice',maxCount:1},{name:'music',maxCount:1}]),async(req,res)=>{
  const job=jobs.get(req.body.jobId); if(!job||job.status!=='ready') return res.status(400).json({error:'Generate the AI scenes first.'});
  const out=path.join(root,'renders',`${req.body.jobId}.mp4`);
  const list=path.join(root,'renders',`${req.body.jobId}.txt`);
  try{
    const files=[];
    for(let i=0;i<job.scenes.length;i++){
      const p=path.join(root,'renders',`${req.body.jobId}_${i}.mp4`);
      const r=await fetch(job.scenes[i]); if(!r.ok) throw new Error('Could not download Runway scene');
      fs.writeFileSync(p,Buffer.from(await r.arrayBuffer())); files.push(p);
    }
    fs.writeFileSync(list,files.map(f=>`file '${f.replaceAll("'","'\\''")}'`).join('\n'));
    await new Promise((resolve,reject)=>ffmpeg().input(list).inputOptions(['-f','concat','-safe','0']).outputOptions(['-c','copy']).save(out).on('end',resolve).on('error',reject));
    const voice=req.files?.voice?.[0]?.path;
    const music=req.files?.music?.[0]?.path;
    if(voice||music){
      const final=out.replace('.mp4','_final.mp4');
      const cmd=ffmpeg(out);
      if(voice) cmd.input(voice);
      if(music) cmd.input(music);
      const filters=[]; let inputs=[];
      if(voice&&music){filters.push('[1:a]volume=1[a1]','[2:a]volume=0.18[a2]','[a1][a2]amix=inputs=2:duration=first[aout]'); inputs=['-map 0:v:0','-map [aout]'];}
      else if(voice){inputs=['-map 0:v:0','-map 1:a:0'];}
      else {inputs=['-map 0:v:0','-map 1:a:0'];}
      cmd.outputOptions([...inputs,'-c:v','libx264','-c:a','aac','-shortest',...(filters.length?['-filter_complex',filters.join(';')]:[])]).save(final).on('end',()=>{res.json({video:`/renders/${path.basename(final)}`});}).on('error',e=>res.status(500).json({error:e.message}));
    } else res.json({video:`/renders/${path.basename(out)}`});
  }catch(e){res.status(500).json({error:e.message||String(e)});}
});
app.use('/renders',express.static(path.join(root,'renders')));
app.listen(process.env.PORT||3000,()=>console.log(`Raz Ki Duniya app: http://localhost:${process.env.PORT||3000}`));
