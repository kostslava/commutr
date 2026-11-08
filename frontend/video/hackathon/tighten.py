#!/usr/bin/env python3
"""Tighten the finished v2 HyperFrames edit without rebuilding its baked graphics."""
import argparse,concurrent.futures,json,pathlib,re,subprocess
p=argparse.ArgumentParser();p.add_argument('--work',default='/Users/slava/Movies/Commutr-Hackathon');a=p.parse_args();r=pathlib.Path(a.work);source=r/'Commutr-UGC-v2.mp4';fps=30
# v2-global seconds, chosen inside nonspeaking gaps with speech handles.
CUTS=[(7.10,8.13,'idle before keys pickup'),(21.40,21.73,'pause before trip request'),(24.20,26.50,'waiting for café suggestion'),(35.15,35.65,'pause before yes'),(36.90,37.70,'waiting for planning response'),(40.80,43.60,'waiting for final route card')]
# Keep every frame of the ground shot, playing it at its original approximate speed.
WALK=(45.5333333333,49.7666666667)
F=lambda t:round(t*fps)
end=int(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=nb_frames','-of','csv=p=0',str(source)]).decode().strip())
cuts=[(F(x),F(y),why) for x,y,why in CUTS];bounds=sorted({0,end,F(WALK[0]),F(WALK[1])}|{n for x,y,_ in cuts for n in [x,y]})
spans=[];at=0
for x,y in zip(bounds,bounds[1:]):
 if any(x>=lo and y<=hi for lo,hi,_ in cuts):continue
 speed=2 if x>=F(WALK[0]) and y<=F(WALK[1]) else 1
 frames=round((y-x)/speed);spans.append(dict(startFrame=x,endFrame=y,speed=speed,frames=frames,atFrame=at));at+=frames
# Guard every transcribed source word in the app against the removed ranges.
words_path=r/'v2-app-words.json'
if words_path.exists():
 words=[w for s in json.loads(words_path.read_text())['segments'] for w in s['words']]
 for lo,hi,reason in cuts:
  for word in words:
   ws=(18.8+word['start'])*fps;we=(18.8+word['end'])*fps
   if min(hi,we)>max(lo,ws)+.01:raise ValueError(f"Cut {reason} overlaps speech: {word['word']} {ws/fps:.2f}-{we/fps:.2f}")
cache=r/'tighten-v3-final';cache.mkdir(exist_ok=True)
def render(item):
 i,s=item;duration=s['frames']/fps;speed=s['speed'];out=cache/f'{i:02}.mp4'
 if i not in [1,7] and out.exists():
  probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(out)],capture_output=True,text=True)
  if probe.returncode==0 and abs(float(probe.stdout.strip())-duration)<.08:return
 subprocess.run(['ffmpeg','-nostdin','-xerror','-y','-v','error','-threads','2','-ss',str(s['startFrame']/fps),'-t',str((s['endFrame']-s['startFrame'])/fps),'-i',str(source),'-map','0:v:0','-map','0:a:0','-vf',f'setpts=(PTS-STARTPTS)/{speed},fps=30,format=yuv420p','-af',(f'asetpts=PTS-STARTPTS,apad,atrim=duration={duration}' if speed==1 else f'anull,asetpts=(PTS-STARTPTS)/{speed},apad,atrim=duration={duration}'),'-t',str(duration),'-c:v','libx264','-crf','17','-preset','fast','-threads','2','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',str(out)],check=True)
 print(f'kept {s["startFrame"]/fps:.2f}–{s["endFrame"]/fps:.2f}, {speed}x',flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(render,enumerate(spans)))
concat=cache/'concat.txt';concat.write_text(''.join(f"file '{cache/f'{i:02}.mp4'}'\nduration {s['frames']/fps}\n" for i,s in enumerate(spans)))
output=r/'Commutr-UGC-v3.mp4'
subprocess.run(['ffmpeg','-nostdin','-xerror','-y','-v','warning','-f','concat','-safe','0','-i',str(concat),'-map','0:v:0','-map','0:a:0','-c:v','copy','-af','aresample=async=1:first_pts=0','-c:a','aac','-b:a','192k','-t',str(at/fps),'-movflags','+faststart',str(output)],check=True)
manifest=dict(source=str(source),output=str(output),fps=fps,duration=at/fps,removedSeconds=end/fps-at/fps,cuts=[dict(start=x/fps,end=y/fps,reason=reason) for x,y,reason in cuts],spans=spans)
(r/'edit-v3.json').write_text(json.dumps(manifest,indent=2)+'\n')
def mapped(t):
 f=t*fps
 for s in spans:
  if s['startFrame']-.01<=f<=s['endFrame']+.01:return (s['atFrame']+(f-s['startFrame'])/s['speed'])/fps
 raise ValueError(f'Caption endpoint inside removed wait: {t}')
caps=json.loads((r/'composition/captions.json').read_text());caps=[dict(c,start=round(mapped(c['start']),3),end=round(mapped(c['end']),3)) for c in caps]
(r/'captions-v3.json').write_text(json.dumps(caps,indent=2)+'\n')
def stamp(t):
 ms=round(t*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
(r/'Commutr-captions-v3.srt').write_text('\n\n'.join(f'{i+1}\n{stamp(c["start"])} --> {stamp(c["end"])}\n'+re.sub('<[^>]+>','',c['text']) for i,c in enumerate(caps))+'\n')
print(f'Finished {at/fps:.2f}s; removed {end/fps-at/fps:.2f}s',flush=True)
