#!/usr/bin/env python3
"""Render graphics separately, then composite without extracting the rushes to frames."""
import argparse,pathlib,re,subprocess
p=argparse.ArgumentParser();p.add_argument('--work',default='/Users/slava/Movies/Commutr-Hackathon');p.add_argument('--reuse-graphics',action='store_true');a=p.parse_args();r=pathlib.Path(a.work);c=r/'composition'
s=(c/'index.html').read_text();s=s.replace('background:#fff9ef}#root','background:transparent}#root');s=re.sub(r'<video id="story"[^>]*></video>','',s);(c/'overlay.html').write_text(s)
if not a.reuse_graphics:
 subprocess.run(['npx','--yes','hyperframes@0.9.23','render','--composition','overlay.html','--format','webm','--quality','high','--workers','2','--sdr','--output',str(r/'graphics.webm')],cwd=c,check=True)
subprocess.run(['ffmpeg','-y','-v','warning','-i',str(c/'assets/story.mp4'),'-c:v','libvpx-vp9','-i',str(r/'graphics.webm'),'-filter_complex','[0:v]tpad=stop_mode=clone:stop_duration=3.2[base];[base][1:v]overlay=shortest=1:format=auto,format=yuv420p[v]','-map','[v]','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','17','-threads','4','-c:a','aac','-b:a','192k','-af','alimiter=limit=0.8913:level=false','-ar','48000','-movflags','+faststart','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',str(r/'Commutr-UGC.mp4')],check=True)
