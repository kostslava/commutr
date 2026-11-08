# Commutr filming kit

1920 x 1080 landscape. Silent edit-ready screen inserts for a human-recorded hackathon video.
Use actual screenshots of the running app. The user explicitly requests the real site, so do not recreate product UI in HTML.
Palette: paper #fffdf1, ink #063c28, grass #bddc7b, background #e4eacf, secondary #526b48.
Typography: Lilita One for titles, Nunito for body. Local fonts from ../public/fonts when available; body fallback sans-serif.
Layout: a cropped view of the real phone preview on the right (roughly x=1180, y=70, 440x930); big plain headline on the left at x=130, y=260, max-width=850. Each screenshot is 757x837; the phone occupies x=200.28,y=22,w=356.43,h=755. Crop in CSS: box 356.43x755, overflow:hidden, inner image width757px height837px left:-200.28px top:-22px. Scale the box with a wrapper to 1.22. Do not upscale beyond 1.3.
Keep a permanent small note "Real app · demo account". Transit/evidence scenes say "Demo route / demo trip" where applicable.
Motion: gentle 0.35s entrance, readable holds, 1.01 camera drift, restrained pointer highlight on actual controls. Cut between real states, no counterfeit text on the UI. Animate only transform and opacity. A reader must be able to follow the task at 1x speed.
No music, generated voice, SFX, fake GPS verification, or partnership claims. These are screen inserts, not the final filmed video. Do not include human-footage placeholders in the rendered inserts.
