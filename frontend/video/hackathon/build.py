#!/usr/bin/env python3
"""Build the Commutr UGC edit from the supplied local rushes; originals are read only."""
import argparse, concurrent.futures, html, json, math, pathlib, shutil, subprocess
import numpy as np
P=argparse.ArgumentParser();P.add_argument('--work',default='/Users/slava/Movies/Commutr-Hackathon');P.add_argument('--sources',default='/Users/slava/Downloads');args=P.parse_args()
ROOT=pathlib.Path(args.work);COMP=ROOT/'composition';ASSETS=COMP/'assets';ASSETS.mkdir(parents=True,exist_ok=True)
# Source in/out seconds, output length is rounded to whole frames at 30 fps.
EDL=[
 dict(id='hook',src='4108',start=0,end=2.0,speed=.70,mute=True),
 dict(id='keys',src='4089',start=.28,end=3.88,speed=1.22,mute=True),
 dict(id='question',src='4093',start=.94,end=2.08),
 dict(id='coffee',src='4094',start=1.08,end=2.73),
 dict(id='car',src='4096',start=.88,end=3.65),
 dict(id='excuse',src='4099',start=.82,end=2.32),
 dict(id='come',src='4100',start=.43,end=2.10),
 dict(id='request',src='4103',start=0,end=2.22),
 dict(id='answer',src='4104',start=14.00,end=17.18),
 dict(id='yes',src='4104',start=22.82,end=23.79),
 dict(id='route',src='4104',start=24.92,end=27.20),
 dict(id='screen',src='4104',start=27.20,end=28.90,zoom=1.8,focus='phone',mute=True),
 dict(id='walk',src='4108',start=0,end=2.03,speed=.48,mute=True),
 dict(id='reward',src='4109',start=.34,end=4.22),
]
t=0
for s in EDL:
 s['speed']=s.get('speed',1);s['frames']=round((s['end']-s['start'])/s['speed']*30);s['duration']=s['frames']/30;s['at']=t;t+=s['duration']
OUTRO=t;TOTAL=round((t+3.2)*30)/30
(ROOT/'edit.json').write_text(json.dumps(dict(fps=30,width=1080,height=1920,scenes=EDL,outro=OUTRO,duration=TOTAL),indent=2))
# HLG inverse OETF + display rendering, BT.2020 -> BT.709, soft highlight roll-off.
lut=ROOT/'hlg-to-sdr.cube';N=33
M=np.array([[1.6605,-.5876,-.0728],[-.1246,1.1329,-.0083],[-.0182,-.1006,1.1187]])
def transform(v):
 a=.17883277;b=.28466892;c=.55991073
 lin=np.where(v<=.5,v*v/3,(np.exp((v-c)/a)+b)/12)
 lin=np.maximum(M@lin,0)**1.2*6.5
 lum=np.dot(lin,[.2126,.7152,.0722]);lin=lin/(1+lum)*1.154
 lin=np.clip(lin,0,1)
 return np.where(lin<=.0031308,12.92*lin,1.055*lin**(1/2.4)-.055)
with lut.open('w') as f:
 f.write('TITLE "Commutr HLG to SDR"\nLUT_3D_SIZE 33\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n')
 for blue in np.linspace(0,1,N):
  for green in np.linspace(0,1,N):
   for red in np.linspace(0,1,N): f.write(' '.join(f'{x:.7f}' for x in transform(np.array([red,green,blue])))+'\n')
def render_scene(s):
 src=next(pathlib.Path(args.sources).glob('IMG_'+s['src']+'.*'));out=ASSETS/(s['id']+'.mp4')
 if out.exists() and s['id']!='route': return
 zoom=s.get('zoom',1);w=round(1080*zoom/2)*2;h=round(1920*zoom/2)*2
 vf=[]
 if s['src']!='4108': vf+=[f'scale=1080:1920:in_color_matrix=bt2020:out_color_matrix=bt2020,format=gbrpf32le,lut3d={lut},scale=1080:1920:out_color_matrix=bt709']
 else: vf+=['scale=1080:1920']
 if zoom!=1: vf +=[f'scale={w}:{h},crop=1080:1920:'+('iw-ow:ih-oh' if s.get('focus')=='phone' else '(iw-ow)/2:(ih-oh)/2')]
 vf +=[f'setpts=(PTS-STARTPTS)/{s["speed"]}', 'fps=30','setsar=1','format=yuv420p','setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709']
 cmd=['ffmpeg','-y','-v','error','-threads','2','-ss',str(s['start']),'-t',str(s['end']-s['start']),'-i',str(src)]
 if s.get('mute'):cmd+=['-f','lavfi','-i','anullsrc=r=48000:cl=mono']
 cmd+=['-map','0:v:0','-map','1:a:0' if s.get('mute') else '0:a:0','-vf',','.join(vf)]
 af='atrim=duration='+str(s['duration']) if s.get('mute') else 'highpass=f=90,lowpass=f=7800,afftdn=nr=12:nf=-35:tn=1,loudnorm=I=-16:TP=-2:LRA=7,aresample=48000,apad'
 cmd+=['-af',af,'-t',str(s['duration']),'-c:v','libx264','-preset','fast','-crf','18','-threads','2','-c:a','aac','-b:a','192k','-ar','48000','-ac','1','-movflags','+faststart',str(out)]
 subprocess.run(cmd,check=True);print(s['id'],s['at'],s['duration'],flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:list(pool.map(render_scene,EDL))
# Flatten the editorial cuts once; HyperFrames owns captions, overlays and the logo animation.
concat=ROOT/'concat.txt';concat.write_text(''.join("file '"+str(ASSETS/(s['id']+'.mp4'))+"'\n" for s in EDL))
subprocess.run(['ffmpeg','-y','-v','error','-f','concat','-safe','0','-i',str(concat),'-c','copy','-movflags','+faststart',str(ASSETS/'story.mp4')],check=True)
# Caption chunks: deliberate phrase breaks and emphasis, timings grounded in source transcript.
CAP=[]
def cap(scene,a,b,text):
 s=next(x for x in EDL if x['id']==scene);CAP.append(dict(start=round(s['at']+(a-s['start'])/s['speed'],3),end=round(min(s['at']+(b-s['start'])/s['speed'],s['at']+s['duration']),3),text=text))
cap('question',1.00,2.08,'So, where are you going?')
cap('coffee',1.13,2.02,"Yeah, I’m gonna get <em>coffee</em>")
cap('coffee',2.02,2.73,'down the street.')
cap('car',.96,1.60,'Dude...')
cap('car',1.60,2.62,'it’s a <em>five-minute walk.</em>')
cap('car',2.66,3.65,'Why are you taking your car?')
cap('excuse',.9,2.32,'Because it’s <em>right here.</em>')
cap('come',.5,1.54,'Let me put you on, bro.')
cap('come',1.58,2.10,'Come with me.')
cap('request',0,1.25,'Start me a <em>walk</em>')
cap('request',1.25,2.22,'to the nearest café.')
cap('answer',14.0,15.58,'The closest spot is')
cap('answer',15.58,17.18,'the Bauer Bakery & Café.')
cap('yes',22.9,23.79,'Yes, please.')
cap('route',25.02,25.96,'Planning your route')
cap('route',25.96,27.15,'to the café now.')
cap('reward',.44,1.20,'Yo, look at that.')
cap('reward',1.3,2.32,'We just got <em>six free points.</em>')
cap('reward',2.46,3.42,'Later, I can redeem')
cap('reward',3.42,4.22,'a <em>free coffee</em> here.')
# Keep a standard SRT alongside the burned-in captions.
def stamp(t):
 ms=round(t*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
import re
(ROOT/'Commutr-captions.srt').write_text('\n\n'.join(f'{i+1}\n{stamp(c["start"])} --> {stamp(c["end"])}\n'+re.sub('<[^>]+>','',c['text']) for i,c in enumerate(CAP))+'\n')
(COMP/'captions.json').write_text(json.dumps(CAP,indent=2))
scene={s['id']:s for s in EDL}
style='''*{box-sizing:border-box}html,body{margin:0;background:#fff9ef}#root{position:relative;width:1080px;height:1920px;overflow:hidden;font-family:Montserrat,sans-serif;color:#fff9ef}.clip{position:absolute}#story{inset:0;width:1080px;height:1920px;object-fit:cover}.shade{position:absolute;inset:0;background:linear-gradient(transparent 58%,rgba(4,28,17,.15) 77%,rgba(4,28,17,.28))}.caption{left:75px;width:930px;top:1360px;height:180px;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.12;font-weight:900;font-size:63px;letter-spacing:-2px;text-shadow:0 4px 0 #102319,3px 0 0 #102319,-3px 0 0 #102319,0 -3px 0 #102319,0 7px 16px #102319}.caption span{display:block}em{font-style:normal;color:#cfef78}.label{position:absolute;left:76px;top:170px;padding:18px 25px;background:#0a4126;border-radius:16px;font-size:28px;font-weight:700;letter-spacing:2px}.hooktext{position:absolute;left:75px;top:330px;width:930px;font-size:95px;font-weight:900;line-height:.96;letter-spacing:-4px;text-shadow:0 5px 0 #102319}.hooktext{background:#0a4126;padding:30px;border-radius:24px}.hooktext small{display:block;margin-top:30px;font-size:38px;letter-spacing:0}.tag{position:absolute;left:76px;top:1170px;background:#fff9ef;color:#0a4126;border:4px solid #0a4126;border-radius:22px;padding:22px 30px;font-weight:900;font-size:48px;box-shadow:7px 8px 0 #0a4126}#routing .tag{top:350px}.outro{inset:0;width:1080px;height:1920px;background:#fff9ef;color:#0a4126;overflow:hidden}.routepath{position:absolute;inset:0;width:1080px;height:1920px}.logo{position:absolute;left:95px;top:785px;width:890px;height:auto}.outcopy{position:absolute;left:80px;top:1085px;width:920px;text-align:center;font-size:63px;font-weight:900;letter-spacing:-2px}.outsub{position:absolute;left:80px;top:1200px;width:920px;text-align:center;font-family:'Space Mono',monospace;font-size:29px;letter-spacing:1px}.endlabel{position:absolute;left:80px;top:170px;font-family:'Space Mono',monospace;font-size:28px;letter-spacing:3px}.endfoot{position:absolute;left:80px;bottom:190px;font-size:28px;font-weight:700}.dot{position:absolute;width:28px;height:28px;background:#3d8e2b;border-radius:50%}'''
parts=[f'<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Commutr — the coffee run</title><script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script><style>{style}</style></head><body><div id="root" data-composition-id="main" data-width="1080" data-height="1920" data-duration="{TOTAL}" data-fps="30">',f'<video id="story" class="clip" src="assets/story.mp4" data-start="0" data-duration="{OUTRO}" data-track-index="0" muted playsinline></video>',f'<audio id="dialogue" src="assets/story.mp4" data-start="0" data-duration="{OUTRO}" data-track-index="10" data-volume="1"></audio>',f'<div id="shade" class="clip shade" data-start="0" data-duration="{OUTRO}" data-track-index="1"></div>']
def overlay(id,start,dur,body,cls=''):
 parts.append(f'<section id="{id}" class="clip {cls}" data-start="{start:.3f}" data-duration="{dur:.3f}" data-track-index="3">{body}</section>')
# Meme speech is trimmed to the complete two-second line after listening/transcription.
parts += ['<audio id="meme" src="assets/hook.mp3" data-start="0.08" data-duration="2.65" data-track-index="11" data-volume="0.85"></audio>']
overlay('opening',0,scene['hook']['duration'],'<div class="label">THE COFFEE RUN</div><div class="hooktext">WHAT IS THIS GUY DOING?<small>bro found the side quest</small></div>')
overlay('rewind',scene['keys']['at'],1.2,'<div class="label">30 SECONDS EARLIER...</div>')
for i,c in enumerate(CAP): overlay(f'caption-{i}',c['start'],c['end']-c['start'],f'<span>{c["text"]}</span>','caption')
route=scene['screen'];overlay('routing',route['at'],route['duration'],'<div class="tag">✓ ROUTE READY</div>')
walk=scene['walk'];overlay('walking',walk['at'],walk['duration'],'<div class="label">SIDE QUEST: COFFEE</div><div class="tag">walking arc unlocked</div>')
parts +=[f'<audio id="coco" src="assets/cocomelon.mp3" data-start="{walk["at"]}" data-duration="{walk["duration"]}" data-track-index="12" data-volume="0.65"></audio>']
reward=scene['reward'];overlay('points',reward['at']+1.2,1.8,'<div class="label">+6 POINTS</div>')
endbody='''<svg class="routepath" viewBox="0 0 1080 1920"><path d="M-80 510 C290 230 650 710 1110 420" fill="none" stroke="#dce7c2" stroke-width="7" stroke-dasharray="20 20"/><path d="M-40 1510 C340 1760 680 1340 1140 1550" fill="none" stroke="#dce7c2" stroke-width="7" stroke-dasharray="20 20"/></svg><div class="endlabel">YOUR EVERYDAY SIDE QUEST.</div><div id="logowrap"><img id="logo" class="logo" src="assets/logo.png" alt="Commutr"></div><div id="outcopy" class="outcopy">Go places. Get rewarded.</div><div id="outsub" class="outsub">WALK · RIDE · EARN</div><div class="dot" id="dot1" style="left:150px;top:490px"></div><div class="dot" id="dot2" style="left:860px;top:1510px"></div><div class="endfoot">A better way to get there.</div>'''
overlay('endcard',OUTRO,3.2,endbody,'outro')
parts +=[f'<audio id="endpop" src="assets/sfx/pop.mp3" data-start="{OUTRO+.12}" data-duration=".72" data-track-index="13" data-volume=".45"></audio>',f'<audio id="endchime" src="assets/sfx/chime.mp3" data-start="{OUTRO+.38}" data-duration="2.5" data-track-index="14" data-volume=".30"></audio>']
parts.append('<audio id="rewind-sfx" src="assets/sfx/whoosh.mp3" data-start="2.75" data-duration=".57" data-track-index="15" data-volume=".25"></audio>')
parts.append('</div><script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});')
parts.append("tl.fromTo('.hooktext',{scale:.75,rotation:-4,opacity:0},{scale:1,rotation:0,opacity:1,duration:.32,ease:'back.out(2.2)'},.08);")
for i,c in enumerate(CAP):parts.append(f"tl.fromTo('#caption-{i} span',{{scale:.93,y:12}},{{scale:1,y:0,duration:.12,ease:'back.out(1.5)'}},{c['start']});")
parts.append(f"tl.fromTo('#logo',{{scale:.15,rotation:-10,opacity:0}},{{scale:1,rotation:0,opacity:1,duration:.66,ease:'back.out(2.5)'}},{OUTRO+.08});tl.fromTo('#outcopy',{{y:40,opacity:0}},{{y:0,opacity:1,duration:.4,ease:'power3.out'}},{OUTRO+.58});tl.fromTo('#outsub',{{opacity:0}},{{opacity:1,duration:.3}},{OUTRO+.85});tl.fromTo('#dot1',{{x:-100}},{{x:120,duration:3.2,ease:'none'}},{OUTRO});tl.fromTo('#dot2',{{x:120}},{{x:-120,duration:3.2,ease:'none'}},{OUTRO});")
parts.append("window.__timelines.main=tl;</script></body></html>")
(COMP/'index.html').write_text('\n'.join(parts))
print('OUTRO',OUTRO,'TOTAL',TOTAL,flush=True)
