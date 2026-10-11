// index.js - Blind Canvas server
//
// Every group plays in its own room, identified by a 4-letter code. Each
// room runs its own state machine:
//   LOBBY -> DRAWING -> REASSEMBLY -> GUESS -> REVEAL
// Hand tracking and speech detection run in the browser, and the Gemini
// calls live in ai.js. Rooms are kept in memory only, so a room disappears
// when its last player leaves or the server restarts.

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
const MAX_ROOMS = 100;
const AUTO_SUBMIT_GRACE_MS = 1200;
const COOLDOWN_MS = 3000;
const MAX_IMAGE_CHARS = 1500000;
const RATE_LIMITED_ACTIONS = [
  "create_room",
  "join_room",
  "start_game",
  "guess_submit",
  "banned_word_spoken",
];

// No I or O, so codes are easy to read out loud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

const rooms = new Map(); // room code -> room state
const lastActionTime = new Map(); // "socketId:action" -> timestamp

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Simple per-connection cooldown so one client cannot spam actions that
// cost money (Gemini calls) or hurt other players (penalties).
function isRateLimited(socket, action, cooldownMs = COOLDOWN_MS) {
  const key = socket.id + ":" + action;
  const now = Date.now();
  const last = lastActionTime.get(key) || 0;
  if (now - last < cooldownMs) return true;
  lastActionTime.set(key, now);
  return false;
}

function tooFast(socket) {
  socket.emit("join_error", "Please wait a moment and try again.");
}

function generateCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return null;
}

function freshRoom(code) {
  return {
    code,
    phase: "LOBBY", // LOBBY | DRAWING | REASSEMBLY | GUESS | REVEAL
    players: [], // { id, name, quadrant }
    scene: null, // { scene, sharedClue, subClues, bannedWords } - never sent before REVEAL
    difficulty: "easy",
    starting: false, // true while the scene is being generated
    scoring: false, // true while the guesses are being scored
    timeLeft: DRAW_SECONDS,
    timerHandle: null,
    timerStarted: false, // the countdown waits until everyone's camera is ready
    readyPlayerIds: [],
    advancing: false, // true during the short auto-submit window at round end
    submittedCanvases: {}, // quadrant -> dataURL, only sent to clients from REASSEMBLY on
    roundQuadrants: [], // quadrants assigned when the round started
    shuffledOrder: null,
    teamGuess: null,
    aiGuess: null,
    scores: null,
  };
}

function publicState(room) {
  // The scene stays hidden until REVEAL, and other players' drawings stay
  // hidden until REASSEMBLY. Before that clients only learn WHICH quadrants
  // have submitted, so the status list works without leaking the pictures.
  const { scene, timerHandle, submittedCanvases, ...safe } = room;
  const submittedQuadrants = Object.keys(submittedCanvases).map(Number);
  const revealImages = ["REASSEMBLY", "GUESS", "REVEAL"].includes(room.phase);
  return {
    ...safe,
    scene: room.phase === "REVEAL" && scene ? scene.scene : null,
    submittedQuadrants,
    submittedCanvases: revealImages ? submittedCanvases : {},
  };
}

function broadcastState(room) {
  io.to(room.code).emit("state", publicState(room));
}

function roomOf(socket) {
  return rooms.get(socket.data.roomId);
}

function cleanPlayerName(name) {
  if (typeof name !== "string") return "";
  return name.replace(/\s+/g, " ").trim().slice(0, 20);
}

function isValidImage(value) {
  return (
    typeof value === "string" &&
    value.startsWith("data:image/png;base64,") &&
    value.length <= MAX_IMAGE_CHARS
  );
}

// Lowest free quadrant, so someone leaving the lobby never causes two
// players to share a quadrant.
function freeQuadrant(room) {
  for (let q = 0; q < MAX_PLAYERS; q++) {
    if (!room.players.some((p) => p.quadrant === q)) return q;
  }
  return -1;
}

function addPlayer(socket, room, name) {
  const quadrant = freeQuadrant(room);
  room.players.push({ id: socket.id, name, quadrant });
  socket.join(room.code);
  socket.data.roomId = room.code;
  socket.data.quadrant = quadrant;
  socket.emit("joined", { code: room.code });
  broadcastState(room);
}

function leaveRoom(socket) {
  const room = roomOf(socket);
  socket.data.roomId = undefined;
  socket.data.quadrant = undefined;
  if (!room) return;

  socket.leave(room.code);
  room.players = room.players.filter((p) => p.id !== socket.id);
  room.readyPlayerIds = room.readyPlayerIds.filter((id) => id !== socket.id);

  if (room.players.length === 0) {
    clearInterval(room.timerHandle);
    rooms.delete(room.code);
    console.log(`[rooms] closed ${room.code} (${rooms.size} active)`);
    return;
  }

  if (room.phase === "DRAWING") {
    // This leave may be exactly what was blocking the countdown, or the
    // last thing the round was waiting for.
    if (!room.timerStarted && room.readyPlayerIds.length >= room.players.length) {
      room.timerStarted = true;
      startTimer(room);
    }
    maybeAdvanceToReassembly(room);
  }
  broadcastState(room);
}

// "Play Again" / "Reset Game": back to the lobby, same room, same players.
function resetRoom(room) {
  clearInterval(room.timerHandle);
  Object.assign(room, freshRoom(room.code), { players: room.players });
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startTimer(room) {
  clearInterval(room.timerHandle);
  room.timerHandle = setInterval(() => {
    room.timeLeft -= 1;
    if (room.timeLeft <= 0) {
      clearInterval(room.timerHandle);
      room.timeLeft = 0;
      maybeAdvanceToReassembly(room, true);
    }
    broadcastState(room);
  }, 1000);
}

// When the round ends (everyone submitted, the timer hit zero, or someone
// clicked "Move on without everyone") any player who has not submitted is
// asked to submit whatever is on their canvas, even if it is blank or half
// done. They get a short window to answer, then the round moves on anyway.
function maybeAdvanceToReassembly(room, force = false) {
  if (room.phase !== "DRAWING" || room.advancing) return;

  const submitted = new Set(Object.keys(room.submittedCanvases).map(Number));
  const stragglers = room.players.filter((p) => !submitted.has(p.quadrant));
  if (!force && stragglers.length > 0) return;

  if (stragglers.length === 0) {
    finalizeReassembly(room);
    return;
  }

  room.advancing = true;
  for (const p of stragglers) {
    io.to(p.id).emit("request_auto_submit");
  }
  broadcastState(room);

  setTimeout(() => {
    room.advancing = false;
    finalizeReassembly(room);
  }, AUTO_SUBMIT_GRACE_MS);
}

function finalizeReassembly(room) {
  if (rooms.get(room.code) !== room || room.phase !== "DRAWING") return;
  clearInterval(room.timerHandle);
  room.phase = "REASSEMBLY";
  // Every quadrant assigned at the start gets a piece, even if that player
  // left or never drew. Pieces with no drawing show up as blank tiles.
  room.shuffledOrder = shuffle(room.roundQuadrants);
  broadcastState(room);
}

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  socket.on("create_room", (name) => {
    if (isRateLimited(socket, "create_room")) {
      tooFast(socket);
      return;
    }
    const cleanName = cleanPlayerName(name);
    if (!cleanName) {
      socket.emit("join_error", "Please enter a name first.");
      return;
    }
    if (rooms.size >= MAX_ROOMS) {
      socket.emit("join_error", "The server is full right now. Try again in a few minutes.");
      return;
    }
    const code = generateCode();
    if (!code) {
      socket.emit("join_error", "Could not create a room. Please try again.");
      return;
    }

    leaveRoom(socket); // in case this connection was already in a room
    const room = freshRoom(code);
    rooms.set(code, room);
    console.log(`[rooms] created ${code} (${rooms.size} active)`);
    addPlayer(socket, room, cleanName);
  });

  socket.on("join_room", (payload) => {
    if (isRateLimited(socket, "join_room", 1000)) {
      tooFast(socket);
      return;
    }
    const code = typeof payload?.code === "string" ? payload.code.trim().toUpperCase() : "";
    const cleanName = cleanPlayerName(payload?.name);
    if (!cleanName) {
      socket.emit("join_error", "Please enter a name first.");
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      socket.emit("join_error", "No room with that code. Check it and try again.");
      return;
    }
    if (socket.data.roomId === room.code) {
      socket.emit("joined", { code: room.code }); // already in this room
      return;
    }
    if (room.phase !== "LOBBY" || room.starting) {
      socket.emit("join_error", "That game has already started.");
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("join_error", "That room is full (max 4 players).");
      return;
    }

    leaveRoom(socket);
    addPlayer(socket, room, cleanName);
  });

  socket.on("start_game", async (difficulty) => {
    const room = roomOf(socket);
    if (!room || room.phase !== "LOBBY" || room.starting) return;
    if (isRateLimited(socket, "start_game")) {
      tooFast(socket);
      return;
    }

    const level = ["easy", "medium", "hard"].includes(difficulty) ? difficulty : "easy";
    room.starting = true;
    broadcastState(room);

    let scene = null;
    try {
      scene = await generatePrompt(level);
    } catch (err) {
      console.error(`[rooms] ${room.code} scene generation threw:`, err);
    }

    // Everyone left, or the room was reset, while the scene was generating.
    if (rooms.get(room.code) !== room || !room.starting) return;
    room.starting = false;

    if (!scene) {
      broadcastState(room);
      socket.emit("join_error", "Could not start the round. Please try again.");
      return;
    }

    room.difficulty = level;
    room.scene = scene;
    room.phase = "DRAWING";
    room.timeLeft = DRAW_SECONDS;
    room.timerStarted = false;
    room.readyPlayerIds = [];
    room.advancing = false;
    room.submittedCanvases = {};
    room.roundQuadrants = room.players.map((p) => p.quadrant);

    // Clue specificity is the difficulty knob: easy = one shared clue,
    // medium = a clue per quadrant, hard = no clue.
    for (const p of room.players) {
      let clue;
      if (level === "hard") {
        clue = "(no clue this round - good luck)";
      } else if (level === "medium") {
        clue = scene.subClues[p.quadrant];
      } else {
        clue = scene.sharedClue;
      }
      io.to(p.id).emit("your_assignment", {
        quadrant: p.quadrant,
        clue,
        bannedWords: scene.bannedWords,
      });
    }

    // The timer does NOT start here. It starts once every player's camera
    // (or mouse fallback) is ready, see player_ready below.
    broadcastState(room);
  });

  // Teammates' hand positions only (no drawing content), sent to the room.
  socket.on("ghost_move", (pos) => {
    const room = roomOf(socket);
    if (!room || room.phase !== "DRAWING") return;
    if (typeof pos?.x !== "number" || typeof pos?.y !== "number") return;
    socket.to(room.code).emit("ghost_move", { playerId: socket.id, x: pos.x, y: pos.y });
  });

  socket.on("banned_word_spoken", (word) => {
    const room = roomOf(socket);
    if (!room || room.phase !== "DRAWING" || !room.timerStarted || !room.scene) return;
    if (typeof word !== "string") return;
    const banned = room.scene.bannedWords.map((w) => String(w).toLowerCase());
    if (!banned.includes(word.toLowerCase())) return;
    if (isRateLimited(socket, "banned_word_spoken", 2000)) return;

    room.timeLeft = Math.max(0, room.timeLeft - PENALTY_SECONDS);
    const speaker = room.players.find((p) => p.id === socket.id);
    // The word itself is NOT sent. Banned words are the words closest to
    // the hidden scene, so announcing it would give the scene away.
    io.to(room.code).emit("penalty", {
      playerName: speaker ? speaker.name : "Someone",
      secondsLost: PENALTY_SECONDS,
    });
    broadcastState(room);
  });

  socket.on("player_ready", () => {
    const room = roomOf(socket);
    if (!room || room.phase !== "DRAWING" || room.timerStarted) return;
    if (!room.readyPlayerIds.includes(socket.id)) {
      room.readyPlayerIds.push(socket.id);
    }
    if (room.readyPlayerIds.length >= room.players.length) {
      room.timerStarted = true;
      startTimer(room);
    }
    broadcastState(room);
  });

  // Escape hatch: start the countdown even if someone's camera is stuck.
  socket.on("force_start_timer", () => {
    const room = roomOf(socket);
    if (!room || room.phase !== "DRAWING" || room.timerStarted) return;
    room.timerStarted = true;
    startTimer(room);
    broadcastState(room);
  });

  socket.on("submit_canvas", (dataUrl) => {
    const room = roomOf(socket);
    if (!room || room.phase !== "DRAWING") return;
    if (!isValidImage(dataUrl)) return;
    const quadrant = socket.data.quadrant;
    if (quadrant === undefined) return;

    room.submittedCanvases[quadrant] = dataUrl;
    broadcastState(room);

    if (room.advancing) {
      // A straggler answered the auto-submit request. If that was the last
      // one we were waiting for, no need to sit out the rest of the window.
      const allIn = room.players.every((p) =>
        Object.prototype.hasOwnProperty.call(room.submittedCanvases, p.quadrant)
      );
      if (allIn) {
        room.advancing = false;
        finalizeReassembly(room);
      }
      return;
    }
    maybeAdvanceToReassembly(room);
  });

  // Move on even if not everyone has submitted. Needs at least one real
  // submission so there is something to reassemble.
  socket.on("force_advance", () => {
    const room = roomOf(socket);
    if (!room || room.phase !== "DRAWING") return;
    if (Object.keys(room.submittedCanvases).length === 0) return;
    maybeAdvanceToReassembly(room, true);
  });

  socket.on("reassembly_submit", () => {
    const room = roomOf(socket);
    if (!room || room.phase !== "REASSEMBLY") return;
    room.phase = "GUESS";
    broadcastState(room);
  });

  socket.on("guess_submit", async (payload) => {
    const room = roomOf(socket);
    if (!room || room.phase !== "GUESS" || room.scoring || !room.scene) return;
    if (isRateLimited(socket, "guess_submit")) return;

    const teamGuess =
      typeof payload?.teamGuess === "string" ? payload.teamGuess.trim().slice(0, 200) : "";
    if (!teamGuess || !isValidImage(payload?.compositeImage)) return;

    room.scoring = true;
    broadcastState(room);

    let aiGuess = null;
    let teamScore = 0;
    let aiScore = null;
    try {
      // The vision call only ever receives the composite image, never the
      // scene text, and it is a separate request from scene generation.
      aiGuess = await guessFromImage(payload.compositeImage);
      [teamScore, aiScore] = await Promise.all([
        semanticSimilarity(teamGuess, room.scene.scene),
        // null means the AI call failed, so there is nothing to score.
        aiGuess ? semanticSimilarity(aiGuess, room.scene.scene) : Promise.resolve(null),
      ]);
    } catch (err) {
      console.error(`[rooms] ${room.code} scoring failed:`, err);
      if (rooms.get(room.code) === room && room.scoring) {
        room.scoring = false;
        broadcastState(room);
      }
      return;
    }

    // The room may have been reset or emptied while we waited on Gemini.
    if (rooms.get(room.code) !== room || room.phase !== "GUESS" || !room.scoring) return;

    room.teamGuess = teamGuess;
    room.aiGuess = aiGuess;
    room.scores = { teamScore, aiScore };
    room.scoring = false;
    room.phase = "REVEAL";
    broadcastState(room);
  });

  socket.on("reset_game", () => {
    const room = roomOf(socket);
    if (!room) return;
    resetRoom(room);
    io.to(room.code).emit("game_reset");
    broadcastState(room);
  });

  socket.on("disconnect", () => {
    for (const action of RATE_LIMITED_ACTIONS) {
      lastActionTime.delete(socket.id + ":" + action);
    }
    leaveRoom(socket);
  });
});

app.get("/", (_req, res) => res.send("Blind Canvas server running."));

httpServer.listen(PORT, () =>
  console.log(`Blind Canvas server listening on :${PORT}`)
);
