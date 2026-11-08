#!/usr/bin/env python3
"""Render graphics separately, then composite without extracting the rushes to frames."""
import argparse,pathlib,re,subprocess,json
p=argparse.ArgumentParser();p.add_argument('--work',default='/Users/slava/Movies/Commutr-Hackathon');p.add_argument('--reuse-graphics',action='store_true');p.add_argument('--output',default='Commutr-UGC-v2.mp4');a=p.parse_args();r=pathlib.Path(a.work);c=r/'composition'
s=(c/'index.html').read_text();s=s.replace('background:#fff9ef}#root','background:transparent}#root');s=re.sub(r'<video id="story"[^>]*></video>','',s);layer=c/'render-layer';layer.mkdir(exist_ok=True);(layer/'index.html').write_text(s.replace('src="assets/', 'src="../assets/'))
if not a.reuse_graphics:
 subprocess.run(['npx','--yes','hyperframes@0.9.23','render','--composition','render-layer/index.html','--format','webm','--quality','high','--workers','2','--sdr','--output',str(r/'graphics.webm')],cwd=c,check=True)
edl=json.loads((r/'edit.json').read_text());silent=[x for x in edl['scenes'] if x.get('mute')];mute_enable='+'.join(f"between(t,{x['at']:.6f},{x['at']+x['duration']:.6f})" for x in silent);audio_filter="alimiter=limit=0.8913:level=false,volume=0:enable='"+mute_enable+"'"
subprocess.run(['ffmpeg','-y','-v','warning','-i',str(c/'assets/story.mp4'),'-c:v','libvpx-vp9','-i',str(r/'graphics.webm'),'-filter_complex','[0:v]tpad=stop_mode=clone:stop_duration=3.2[base];[base][1:v]overlay=shortest=1:format=auto,format=yuv420p[v]','-map','[v]','-map','1:a:0','-r','30','-fps_mode','cfr','-c:v','libx264','-preset','fast','-crf','17','-threads','4','-c:a','aac','-b:a','192k','-af',audio_filter,'-ar','48000','-movflags','+faststart','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',str(r/a.output)],check=True)
