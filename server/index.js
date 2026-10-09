// index.js - Blind Canvas server
//
// Full state machine: LOBBY -> DRAWING -> REASSEMBLY -> GUESS -> REVEAL.
// Gesture-drawing (MediaPipe) and real Gemini AI calls (ai.js) are both live.
// Speech detection (Web Speech API) for the banned-word penalty is also live.
import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { generatePrompt, guessFromImage, semanticSimilarity } from "./ai.js";
const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3001;
const DRAW_SECONDS = 90;
const PENALTY_SECONDS = 15;
const MAX_PLAYERS = 4;

// Simple per-socket cooldown to stop a single client from spamming
// AI-calling events (start_game -> generatePrompt, guess_submit ->
// guessFromImage/semanticSimilarity) and burning through the Gemini
// quota. Not a full abuse-prevention system, just a basic brake.
const RATE_LIMIT_MS = 3000;
const lastActionTime = new Map(); // 'socketId:action' -> timestamp

function isRateLimited(socket, action) {
  const key = socket.id + ':' + action;
  const now = Date.now();
  const last = lastActionTime.get(key) || 0;
  if (now - last < RATE_LIMIT_MS) return true;
  lastActionTime.set(key, now);
  return false;
}

// --- Single-room game state (MVP: one game at a time) -----------------
// TODO(later): key this by roomId to support multiple concurrent games.
let state = freshState();

function freshState() {
  return {
    phase: "LOBBY", // LOBBY | DRAWING | REASSEMBLY | GUESS | REVEAL
    players: [], // { id, name, quadrant }
    scene: null, // { scene, sharedClue, bannedWords } â€” server-only until REVEAL
    difficulty: "easy",
    timeLeft: DRAW_SECONDS,
    timerHandle: null,
    timerStarted: false, // countdown doesn't run until everyone's confirmed ready
    readyPlayerIds: [], // socket ids who confirmed camera-ready (or chose mouse fallback)
    advancing: false, // true during the brief auto-submit grace window at round end
    submittedCanvases: {}, // quadrant(0-3) -> dataURL, only revealed to clients at REASSEMBLY+
    roundQuadrants: [], // quadrants assigned when the round started -- the puzzle always shows this many pieces, even if someone disconnects or never draws, instead of silently shrinking
    shuffledOrder: null, // array of quadrant indices in shuffled display order
    teamGuess: null,
    aiGuess: null,
    scores: null,
  };
}

function publicState() {
  // Never leak state.scene to clients before REVEAL, and never leak
  // teammates' actual drawing content before REASSEMBLY â€” only *whether*
  // each quadrant has submitted, so the UI can show status without
  // revealing the picture early.
  const { scene, timerHandle, submittedCanvases, ...safe } = state;
  const submittedQuadrants = Object.keys(submittedCanvases).map(Number);
  const revealImages = ["REASSEMBLY", "GUESS", "REVEAL"].includes(state.phase);
  return {
    ...safe,
    scene: state.phase === "REVEAL" ? state.scene.scene : null,
    submittedQuadrants,
    submittedCanvases: revealImages ? submittedCanvases : {},
  };
}

function broadcastState() {
  io.emit("state", publicState());
}

io.on("connection", (socket) => {
  socket.on("join", (name) => {
    // Idempotent: if this socket already joined, just re-confirm instead
    // of bouncing them with "Room full" on a second click.
    const existing = state.players.find((p) => p.id === socket.id);
    if (existing) {
      socket.emit("joined");
      return;
    }
    if (state.players.length >= MAX_PLAYERS) {
      socket.emit("join_error", "Room full (max 4 players).");
      return;
    }
    if (state.phase !== "LOBBY") {
      socket.emit("join_error", "Game already in progress.");
      return;
    }
    const quadrant = state.players.length; // 0..3, assigned in join order
    state.players.push({ id: socket.id, name, quadrant });
    socket.data.quadrant = quadrant;
    socket.emit("joined");
    broadcastState();
  });

  socket.on("start_game", async (difficulty) => {
    if (state.phase !== "LOBBY") return; // can't start a round that's already in progress
    if (state.players.length < 1) return; // allow solo testing
    if (isRateLimited(socket, 'start_game')) {
      socket.emit('join_error', 'Please wait a moment before starting another round.');
      return;
    }
    state.difficulty = difficulty || "easy";
    state.scene = await generatePrompt(state.difficulty);
    state.phase = "DRAWING";
    state.timeLeft = DRAW_SECONDS;
    state.timerStarted = false;
    state.readyPlayerIds = [];
    state.advancing = false;
    state.submittedCanvases = {};
    state.roundQuadrants = state.players.map((p) => p.quadrant);

    // Clue specificity is the difficulty knob that fixes the "everyone
    // draws the same generic thing" problem: shared clue = easy but
    // disorienting on reassembly (nothing anchors a piece to its
    // position), per-quadrant sub-clue = medium and gives reassembly a
    // real logical anchor, no clue = hard.
    for (const p of state.players) {
      let clue;
      if (state.difficulty === "hard") {
        clue = "(no clue this round â€” good luck)";
      } else if (state.difficulty === "medium") {
        clue = state.scene.subClues[p.quadrant];
      } else {
        clue = state.scene.sharedClue;
      }
      io.to(p.id).emit("your_assignment", {
        quadrant: p.quadrant,
        clue,
        bannedWords: state.scene.bannedWords,
      });
    }

    // Deliberately NOT starting the timer here. It only starts once every
    // connected player has confirmed their camera (or mouse fallback) is
    // actually working â€” see "player_ready" below â€” so nobody loses real
    // drawing time to a webcam that's still loading or never came up.
    broadcastState();
  });

  // A client sends this once its camera+hand-tracking is confirmed ready,
  // OR once it deliberately switched to the mouse fallback (which needs
  // no loading time, so it's "ready" immediately). Once every currently
  // connected player has signaled ready, the countdown actually starts.
  socket.on("player_ready", () => {
    if (state.phase !== "DRAWING" || state.timerStarted) return;
    if (!state.readyPlayerIds.includes(socket.id)) {
      state.readyPlayerIds.push(socket.id);
    }
    if (state.readyPlayerIds.length >= state.players.length) {
      state.timerStarted = true;
      startTimer();
    }
    broadcastState();
  });

  // Manual escape hatch: if someone's camera is stuck (permission dialog
  // never resolved, hardware issue, whatever) and they're not responding,
  // any player can force the countdown to start anyway rather than the
  // whole team being stuck waiting forever.
  socket.on("force_start_timer", () => {
    if (state.phase !== "DRAWING" || state.timerStarted) return;
    state.timerStarted = true;
    startTimer();
    broadcastState();
  });

  // Ghost-hand: broadcast cursor/pointer position only â€” never canvas content â€”
  // during the drawing phase, so teammates get a sense of hand movement
  // without seeing what's actually being drawn.
  socket.on("ghost_move", (pos) => {
    socket.broadcast.emit("ghost_move", { playerId: socket.id, ...pos });
  });

  socket.on("banned_word_spoken", (word) => {
    if (state.phase !== "DRAWING") return;
    state.timeLeft = Math.max(0, state.timeLeft - PENALTY_SECONDS);
    io.emit("penalty", { word, secondsLost: PENALTY_SECONDS });
    broadcastState();
  });

  socket.on("submit_canvas", (dataUrl) => {
    if (state.phase !== "DRAWING") return; // don't accept stray late submits after the round moved on
    const quadrant = socket.data.quadrant;
    if (quadrant === undefined) return;
    state.submittedCanvases[quadrant] = dataUrl;
    broadcastState(); // so everyone's submission-status list updates immediately

    if (state.advancing) {
      // A straggler just responded to the auto-submit request during the
      // grace window. If that was the last one we were waiting on, no
      // need to sit out the rest of the grace period.
      const allIn = state.players.every((p) =>
        Object.prototype.hasOwnProperty.call(state.submittedCanvases, p.quadrant)
      );
      if (allIn) {
        state.advancing = false;
        finalizeReassembly();
      }
      return;
    }

    maybeAdvanceToReassembly();
  });

  // Manual override: move on to reassembly even if not everyone has
  // submitted â€” e.g. a teammate's camera never worked and they're stuck,
  // or you're solo-testing with fewer than 4 real players connected.
  // Requires at least one real submission so there's something to reassemble.
  socket.on("force_advance", () => {
    if (state.phase !== "DRAWING") return;
    if (Object.keys(state.submittedCanvases).length === 0) return;
    maybeAdvanceToReassembly(true);
  });

  socket.on("reassembly_submit", () => {
    // First submission locks the team's arrangement for MVP simplicity.
    // TODO(later): require all players to agree, or a host-confirms flow.
    if (state.phase !== "REASSEMBLY") return;
    state.phase = "GUESS";
    broadcastState();
  });

  socket.on("guess_submit", async ({ teamGuess, compositeImage }) => {
    if (state.phase !== "GUESS") return;
    if (isRateLimited(socket, 'guess_submit')) return;
    state.teamGuess = teamGuess;

    // compositeImage is a single stitched dataURL built client-side from
    // the team's final arrangement â€” see ReassemblyBoard.jsx.
    state.aiGuess = await guessFromImage(compositeImage);
    
    state.scores = {
      teamScore: await semanticSimilarity(teamGuess, state.scene.scene),
      aiScore: state.aiGuess ? await semanticSimilarity(state.aiGuess, state.scene.scene) : null,
    };
    state.phase = "REVEAL";
    broadcastState();
  });

  socket.on("reset_game", () => {
    clearInterval(state.timerHandle);
    state = freshState();
    io.emit("game_reset"); // tell every client to drop its local joined/assignment state too
    broadcastState();
  });

  socket.on("disconnect", () => {
    state.players = state.players.filter((p) => p.id !== socket.id);
    lastActionTime.delete(socket.id + ':start_game');
    lastActionTime.delete(socket.id + ':guess_submit');
    state.readyPlayerIds = state.readyPlayerIds.filter((id) => id !== socket.id);
    // If everyone remaining happens to already be ready, this disconnect
    // might be exactly what was blocking the countdown from starting.
    if (
      state.phase === "DRAWING" &&
      !state.timerStarted &&
      state.players.length > 0 &&
      state.readyPlayerIds.length >= state.players.length
    ) {
      state.timerStarted = true;
      startTimer();
    }
    broadcastState();
  });

  // Send current state immediately on connect.
  socket.emit("state", publicState());
});

function startTimer() {
  clearInterval(state.timerHandle);
  state.timerHandle = setInterval(() => {
    state.timeLeft -= 1;
    if (state.timeLeft <= 0) {
      clearInterval(state.timerHandle);
      state.timeLeft = 0;
      maybeAdvanceToReassembly(true);
    }
    broadcastState();
  }, 1000);
}

const AUTO_SUBMIT_GRACE_MS = 1200;

// Grace-period auto-submit: when the round ends (timer hits zero, or
// someone clicks "Move on without everyone") while players still haven't
// clicked Submit themselves, we don't just leave their quadrant out of
// the puzzle. Instead we ask their browser to submit whatever's currently
// on their canvas â€” even blank or half-finished â€” so every quadrant that
// has a real player still shows up in reassembly. A half-drawn piece
// still tells the team something; a missing piece tells them nothing.
function maybeAdvanceToReassembly(force = false) {
  if (state.phase !== "DRAWING" || state.advancing) return;

  const submittedQuadrants = new Set(Object.keys(state.submittedCanvases).map(Number));
  const allSubmitted = submittedQuadrants.size >= state.players.length;
  if (!force && !allSubmitted) return;

  const stragglers = state.players.filter((p) => !submittedQuadrants.has(p.quadrant));

  if (stragglers.length === 0) {
    finalizeReassembly();
    return;
  }

  // Ask each straggler's own browser to submit its current canvas right now.
  state.advancing = true;
  for (const p of stragglers) {
    io.to(p.id).emit("request_auto_submit");
  }
  broadcastState();

  // Give them a brief window to respond (submit_canvas is still accepted
  // during this window since phase is still DRAWING), then finalize
  // regardless â€” a straggler who's genuinely disconnected or frozen
  // shouldn't be able to block the round forever.
  setTimeout(() => {
    state.advancing = false;
    finalizeReassembly();
  }, AUTO_SUBMIT_GRACE_MS);
}

function finalizeReassembly() {
  if (state.phase !== "DRAWING") return; // already moved on somehow, don't double-fire
  clearInterval(state.timerHandle);
  state.phase = "REASSEMBLY";
  // Shuffle quadrant order so pieces come back unlabeled/unordered â€”
  // the team has to figure out correct placement themselves.
  const indices = state.roundQuadrants; // always all assigned quadrants, not just the ones that got submitted
  state.shuffledOrder = shuffle(indices);
  broadcastState();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

app.get("/", (_req, res) => res.send("Blind Canvas server running."));

httpServer.listen(PORT, () =>
  console.log(`Blind Canvas server listening on :${PORT}`)
);










