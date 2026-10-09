# Blind Canvas

A real-time multiplayer drawing game. Four players each draw one quarter of a hidden scene with hand gestures through their webcam, without seeing what the others are drawing. The pieces come back shuffled, the team puts them together and guesses what the scene is, and an AI that only sees the finished picture makes its own guess. Both guesses are scored against the real scene.

**Live demo:** https://blind-canvas-three.vercel.app/

The backend runs on a free hosting tier and sleeps when idle, so the first load after a quiet period can take up to a minute. Use Chrome, allow camera and microphone access, and play with at least one other person on a separate device for the full experience.

## How a round works

1. Players join one shared lobby (up to 4) and pick a difficulty.
2. Gemini generates a hidden scene. Easy gives everyone the same clue, medium gives each quadrant its own clue, hard gives no clue.
3. The 90 second timer starts once every player's camera is ready (anyone can force-start if someone is stuck). Pinch your thumb and index finger together to draw and release to lift the pen. A mouse fallback exists for when tracking fails.
4. Saying a banned word out loud costs the team 15 seconds. Banned words are detected with the browser's Web Speech API.
5. When time runs out, anyone who has not submitted gets their canvas submitted automatically. The pieces come back shuffled and unlabeled, and a quadrant nobody drew shows up as a blank tile.
6. The team drags the pieces into the 2x2 grid (no snapping), agrees on a guess, and one person submits it. The app has no chat, so the team talks over a call or in the same room.
7. The reveal screen shows the team's guess, the AI's guess and the real scene, with each guess scored by meaning.

## How the AI is used

- **Scene generation:** one text request to Gemini that returns JSON: the scene, a shared clue, four quadrant clues and a list of banned words. The prompt asks for simple everyday English, and difficulty controls how complex the scene is.
- **Guessing:** a separate vision request that receives only the stitched composite image. It never sees the scene text or any earlier request.
- **Scoring:** both guesses are embedded with Gemini's embedding model and compared to the scene by cosine similarity.
- **When Gemini fails:** each call retries once. If scene generation still fails, the server uses a small built-in set of scenes. If scoring fails, it falls back to word overlap. If the AI's guess fails, the reveal screen shows no AI score instead of scoring a placeholder.

Models used: `gemini-3.6-flash` (text and vision) and `gemini-embedding-001` (scoring). Google has retired model names twice during this project, so both are constants at the top of `server/ai.js`.

## Tech stack

- **Frontend:** React, Vite, HTML5 Canvas, MediaPipe Tasks Vision (HandLandmarker), Web Speech API, Socket.io client
- **Backend:** Node.js, Express, Socket.io, @google/genai
- **Hosting:** Vercel (frontend), Render free tier (backend)

## Design notes

- The server owns the game state (lobby, drawing, reassembly, guess, reveal). It does not send the scene or other players' drawings to clients before the phase that needs them.
- Raw hand landmarks are noisy. Fingertip position is smoothed with an exponential moving average, pinch detection uses separate start and stop thresholds so it does not flicker, and tiny movements are ignored. Together these give continuous strokes instead of broken ones.
- Teammates' hands appear as small dots driven by normalized coordinates sent over Socket.io. No video is shared between players and there is no WebRTC.
- Events that trigger AI calls are limited to one every 3 seconds per connection, and a round can only be started from the lobby.

## Run it locally

Requires Node.js 20 or newer and a free Gemini API key from https://aistudio.google.com/apikey.

```
# terminal 1
cd server
npm install
# copy .env.example to .env and set GEMINI_API_KEY
npm run dev

# terminal 2
cd client
npm install
npm run dev
```

Then open http://localhost:5173. Camera and microphone access only work on localhost or HTTPS, so opening the dev server from another device by its network IP address will not get camera access.

| Variable | Where | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | `server/.env` | Gemini API key |
| `VITE_SERVER_URL` | client build | Backend URL, defaults to `http://localhost:3001`. Set it to the deployed backend URL when building the frontend. |

## Project layout

```
server/index.js          Socket.io game server and state machine
server/ai.js             Gemini calls: scene generation, image guess, scoring
client/src/App.jsx       Switches between game phases
client/src/components/   Lobby, DrawCanvas, ReassemblyBoard, RevealScreen
client/src/hooks/        useHandTracking, useSpeechPenalty
```

## Known limitations

- One shared room per server, so two groups cannot play at the same time.
- The layout is a fixed 2x2 grid. With fewer than four players the unused cells stay empty.
- Free hosting: the backend sleeps when idle. Gemini's free tier sometimes returns 503 "high demand" errors, which the retry and fallbacks soften but do not remove.
- Speech detection needs Chrome and has had limited testing.
- Hand tracking has only been tested on laptop webcams.
- No automated tests.
