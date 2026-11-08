# Commutr screen inserts

The Google Doc contains the full simplified filming script and the live-demo plan. This folder contains silent animated inserts built from screenshots of the running app at http://localhost:5175/.

The UI captures are real. Camera moves, pointers, and surrounding titles are added in HyperFrames. These are animated screen captures, not a continuous recording of every tap. Demo evidence photos are submissions, not real journey verification. Add your own voiceovers and human footage in your video editor.

`npm run check` validates the kit. `npx hyperframes preview --background` opens the editable timeline. `npm run render -- --output renders/commutr-screen-inserts.mp4` renders the full 96-second reel. Individual scene exports and the final timing sheet are in renders/ after rendering.

The desktop app preview uses an iframe; screenshots were captured through the connected browser. HyperFrames' website capture could not access this localhost site (HTTP 403), so the kit uses direct browser captures of the same running app.
