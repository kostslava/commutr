# Commutr — the coffee run

36.2-second portrait UGC film, 1080 × 1920 at 30 fps. Opening meme → keys → conversation → app request and route confirmation → stationary ground time-lapse → six-point coffee payoff → spring logo reveal.

Local delivery folder: `/Users/slava/Movies/Commutr-Hackathon/`. Original MOVs remain in Downloads. Raw footage and audio downloads are intentionally kept outside Git.

## Rebuild

Requires Python with NumPy, FFmpeg, Node 22+, and HyperFrames 0.9.23. The supplied logo lives in `assets/logo.png`. Copy it into the composition's `assets/` folder. Retrieve the two audio cues from `sources.json` to `assets/hook.mp3` and `assets/cocomelon.mp3`. The three additional effects are resolved through the installed HyperFrames audio engine (`audio_request.json`, `--only sfx`).

Run `python3 build.py --work /Users/slava/Movies/Commutr-Hackathon --sources /Users/slava/Downloads`. Existing scene intermediates are reused; delete an affected MP4 in `composition/assets/` when changing its trim or grade. The route intermediate is always rebuilt. The script writes the edit decision list, SDR tone-map LUT, cleaned scene intermediates, phrase captions/SRT, and `composition/index.html`.

Inside `composition`, run `npx --yes hyperframes@0.9.23 check`. Then run `python3 deliver.py --work /Users/slava/Movies/Commutr-Hackathon` from this folder. HyperFrames renders an alpha WebM of the captions, audio cues, and seek-safe GSAP logo reveal; FFmpeg composites it over the footage, applies a -1 dBFS limiter, and writes the final H.264/AAC MP4. This avoids expanding the full footage into high-resolution frames on a nearly full disk. Media elements are direct children of the root; the audio track is separate from the muted video.

## Edit decisions

- Dialogue is high/low-pass filtered, FFT denoised, and normalized to -16 LUFS with a -2 dBTP ceiling before the final mix.
- iPhone HLG footage is tone-mapped into SDR with BT.2020 to BT.709 conversion. The already SDR stationary time-lapse bypasses that transform.
- The moving-phone time-lapse (IMG_4106) is omitted. IMG_4108 supplies the hook and stationary walking shot. Its tiny source duration is slowed for the meme beats.
- App response waiting time, the 37-minute estimate, and incomplete trailing speech are cut. The filmed spoken destination is retained; no route data is fabricated.
- Source-synced spoken captions deliberately follow the fast delivery. The validator's slower reading-time advisory is reviewed as expected for UGC subtitles. Decorative route paths may extend beyond the clipping frame intentionally.
- Third-party meme cues were requested by the user. Source links are recorded in `sources.json`; their presence on a soundboard is not a license grant. Bundled incidental effects are from the HyperFrames Pixabay library.
