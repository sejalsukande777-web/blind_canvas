# AI AirDraw Arena — Phase 1, 2 + 3

Working prototype: real hand-gesture drawing (MediaPipe HandLandmarker,
pinch-to-draw), quadrant assignment, shuffle, manual reassembly, mock AI
guessing, working difficulty levels, and a mouse fallback for
troubleshooting only — never a player-facing mode. Real Web Speech
transcription and real Gemini calls are next.

## Run it (single machine, multiple browser tabs = multiple players)

```bash
# terminal 1
cd server
npm install
npm run dev
# server runs on http://localhost:3001

# terminal 2
cd client
npm install
npm run dev
# client runs on http://localhost:5173
```

Open `http://localhost:5173` in up to 4 browser tabs, join with different
names in each, then start the game from any tab once at least one player
has joined (solo testing works too — the game doesn't require exactly 4).

## Run it across multiple laptops (LAN)

1. On the "host" laptop, find its LAN IP (e.g. `192.168.1.23`).
2. Start the server as above — it already binds to `0.0.0.0` via `host: true`
   in `vite.config.js` for the client, and Socket.io/Express bind to all
   interfaces by default.
3. On each teammate's laptop, set the server URL before starting the client:
   ```bash
   VITE_SERVER_URL=http://192.168.1.23:3001 npm run dev
   ```
   (or create a `client/.env` file with `VITE_SERVER_URL=http://192.168.1.23:3001`)
4. Everyone opens `http://192.168.1.23:5173` (the host's IP) in their browser.

Make sure everyone's on the same wifi/hotspot — this is pure LAN, no
internet-facing deployment involved, so no hosting cost at this stage.

## What's real vs. mocked right now

- **Real**: full game state machine (lobby → drawing → reassembly → guess
  → reveal), quadrant assignment, shuffle-on-reveal, manual drag reassembly
  (no auto-snap), shared timer, banned-word penalty wiring, ghost-hand
  position broadcast over Socket.io, client-side image compositing,
  working Easy/Medium/Hard difficulty (shared clue / per-quadrant sub-clue
  / no clue), a Reset Game escape hatch from any phase, and **real
  hand-gesture drawing** — MediaPipe HandLandmarker tracks your index
  fingertip, pinching your thumb and index finger together is "pen down."
- **Mocked** (see `server/mockAI.js`, clearly commented): the scene prompt
  generator and the AI's image-guessing — both currently pick from a small
  hardcoded list instead of calling a real model. Swap these two functions
  for real Gemini calls in Phase 5 without touching anything else.
- **Not yet built**: real Web Speech API transcription (there's a manual
  "type what you'd say" tester in DrawCanvas.jsx instead), and
  jigsaw-shaped puzzle edges (cosmetic polish, deliberately last).

## About the gesture tracking (Phase 3)

- Default input is your webcam. **Pinch your thumb and index finger
  together to draw, release to lift the pen** — same as a real pen, not a
  click-and-hold.
- A small mirrored camera preview and a status pill ("Hand tracked — pinch
  to draw") show what's being detected, so you're not guessing whether it
  sees you.
- If tracking genuinely isn't working — bad lighting, no webcam, browser
  permission denied — there's a **"Tracking not working? Switch to
  mouse"** link. This is deliberately framed as troubleshooting, not a
  difficulty option, per the project design decision: gesture is the real
  game, mouse is a safety net.
- First load takes a few seconds — it's downloading the hand-tracking
  model from Google's CDN and initializing WebGL (or falling back to CPU
  automatically if your laptop's GPU delegate fails to initialize).
- **I could not test this part myself** — MediaPipe needs a real browser
  with camera access, which isn't available in the environment I build in.
  Everything up through Phase 2 I verified by actually running simulated
  clients against the server and checking real output. This part, you'll
  need to be the first real test of. If pinch detection feels too
  sensitive or not sensitive enough once you try it, the number to tune is
  `PINCH_THRESHOLD` at the top of `client/src/hooks/useHandTracking.js`.

## Next steps, in order
1. ~~Playtest this mouse version with your actual teammates over LAN~~ —
   done, confirmed core loop works.
2. ~~Swap MediaPipe Tasks Vision (HandLandmarker) in for the mouse~~ — done,
   this build. **Playtest this with a real webcam before moving on** —
   confirm pinch-to-draw actually feels good before touching anything else.
3. Wire up real Web Speech API transcription in place of the manual tester.
4. Replace `mockAI.js` with real Gemini API calls — get a free-tier key
   from Google AI Studio, no credit card needed. Keep the two function
   signatures identical so nothing else needs to change.
5. Add jigsaw-shaped puzzle piece edges (SVG clip-path) as pure polish,
   only after the core loop is confirmed fun in testing.
