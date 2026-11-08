# Commutr — the coffee run, revision 3

47-second portrait UGC film, 1080 × 1920 at 30 fps. Supplied skipping clip → keys → conversation → complete agent exchange and phone action → stationary ground time-lapse → six-point coffee payoff → spring logo reveal.

Delivery: `/Users/slava/Movies/Commutr-Hackathon/Commutr-UGC-v3.mp4`. Previous cuts remain as `Commutr-UGC-v2.mp4` and `Commutr-UGC.mp4`. Originals remain in Downloads; footage and rendered media stay outside Git.

## Current pacing pass

Revision 3 removes about 10 seconds of nonspeaking filler: idle time before the keys pickup and waits between the app greeting, trip request, recommendation, confirmation, planning response, and final card. All spoken words remain at their original speed. The complete ground time-lapse now plays at approximately its original speed instead of being slowed down. The supplied silent opening, confirmation question, affirmative answer, phone action, payoff, and logo ending remain.

`python3 tighten.py --work /Users/slava/Movies/Commutr-Hackathon` cuts the completed v2 HyperFrames export into v3 without changing its baked captions or branding. The script checks cut ranges against `v2-app-words.json`, a word-timed transcription of the v2 app exchange. `edit-v3.json` records retained frame ranges, cut reasons, and timing; `captions-v3.json` and `Commutr-captions-v3.srt` follow the new clock. It leaves v2 intact.

## Revision 2 foundation

- Use the entire supplied `0DCDE9AD-136A-4AB9-97D5-E8A609055C91.MP4` at the start, muted. Add no text, effects, shade, or sound to it. Its existing baked-in caption is retained as supplied. Cut directly to the keys shot.
- Preserve every spoken line in IMG_4104 from 5.80 seconds through the end: greeting, request, café recommendation, walking estimate, full confirmation question, affirmative reply, planning response, and final words. Revision 2 preserved the pauses and phone UI changes; revision 3 shortens the nonspeaking waits while retaining the dialogue and visible result. A continuous cut at 27.20 seconds changes the framing to the phone without removing any speech or elapsed time. No synthetic trip-start screen is substituted.
- Remove both internet meme audio cues. The stationary ground time-lapse is silent for the user to add their own sound. The only added audio effects are the existing logo-ending pop and chime.
- Keep the dialogue noise reduction, captions, points payoff, and animated logo ending.

## Rebuild

Requires Python with NumPy, FFmpeg, Node 22+, and HyperFrames 0.9.23. Copy this folder's `assets/logo.png` into the local composition's `assets/` folder. The outro pop/chime are the HyperFrames audio engine's bundled effects; see `audio_request.json` (`--only sfx`).

Run `python3 build.py --work /Users/slava/Movies/Commutr-Hackathon --sources /Users/slava/Downloads`. Existing unchanged scene intermediates are reused; delete an affected MP4 in `composition/assets/` when changing a cached scene. The opening and two agent scenes are always rebuilt. The script writes the edit decisions, SDR tone-map LUT, cleaned scene intermediates, captions/SRT, and composition HTML. Explicit concat durations keep scene boundaries aligned to the authored caption clock.

Inside the local composition, run `npx --yes hyperframes@0.9.23 check`. Then run `python3 deliver.py --work /Users/slava/Movies/Commutr-Hackathon` from this source folder. HyperFrames renders captions, the audio mix, and seekable GSAP logo animation to a transparent WebM; FFmpeg composites over the footage and writes the 30 fps H.264/AAC MP4 with a -1 dB limiter. `--output` changes the filename; `--reuse-graphics` skips rerendering graphics.

Dialogue is filtered, FFT denoised, and normalized before mixing. iPhone HLG sources use the existing SDR conversion. The supplied SDR opening and stationary time-lapse bypass that conversion. Reading-time advisories are reviewed against the source-synced UGC speech; decorative paths intentionally extend beyond the clipped frame.
