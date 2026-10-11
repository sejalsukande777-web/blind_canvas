import { useState } from "react";
import { socket } from "../socket.js";

// Lets a shared link like https://your-site/?room=ABCD pre-fill the code.
function codeFromUrl() {
  try {
    const raw = new URLSearchParams(window.location.search).get("room") || "";
    return raw.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  } catch {
    return "";
  }
}

export default function Lobby({ joined, room }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(codeFromUrl);
  const [difficulty, setDifficulty] = useState("medium");
  const [copied, setCopied] = useState(false);

  const cleanName = name.trim();

  function createRoom() {
    if (!cleanName) return;
    socket.emit("create_room", cleanName);
  }

  function joinRoom() {
    if (!cleanName || code.length !== 4) return;
    socket.emit("join_room", { code, name: cleanName });
  }

  // ---- Step 1: not in a room yet -----------------------------------------
  if (!joined) {
    return (
      <div className="panel">
        <h1 className="title">Blind Canvas</h1>
        <p className="subtitle">
          Four players. One hidden scene. Nobody sees the whole picture alone.
        </p>

        <input
          className="input"
          style={{ width: "100%" }}
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={20}
          autoFocus
          autoComplete="off"
          name="blind-canvas-player-name"
        />
        {!cleanName && <p className="hint" style={{ marginTop: 8 }}>Enter your name to continue.</p>}

        <div className="row" style={{ marginTop: 16 }}>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!cleanName}
            onClick={createRoom}
          >
            Create a room
          </button>
        </div>

        <p className="hint" style={{ margin: "28px 0 8px" }}>
          Or join a friend's room with its 4-letter code:
        </p>
        <div className="row">
          <input
            className="input"
            style={{ textAlign: "center", letterSpacing: "0.3em", textTransform: "uppercase" }}
            placeholder="CODE"
            value={code}
            onChange={(e) =>
              setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") joinRoom();
            }}
            maxLength={4}
            autoComplete="off"
            name="blind-canvas-room-code"
          />
          <button
            className="btn btn-accent"
            type="button"
            disabled={!cleanName || code.length !== 4}
            onClick={joinRoom}
          >
            Join room
          </button>
        </div>

        <p className="footnote">
          Draw with your hand: pinch your thumb and index finger together to
          draw, release to lift the pen. Your browser will ask for camera and
          microphone permission once the round starts.
        </p>
      </div>
    );
  }

  // ---- In a room, waiting for the first state update ---------------------
  if (!room) {
    return (
      <div className="panel">
        <p className="hint">Joining room...</p>
      </div>
    );
  }

  // ---- Step 2: the room lobby --------------------------------------------
  const players = room.players || [];
  const inviteLink = `${window.location.origin}/?room=${room.code}`;

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available here. The code is on screen, so nothing is lost.
    }
  }

  return (
    <div className="panel">
      <h1 className="title">Blind Canvas</h1>
      <p className="subtitle">Share this code with your team:</p>

      <div
        style={{
          fontSize: "3rem",
          fontWeight: 800,
          letterSpacing: "0.35em",
          color: "var(--cyan)",
          margin: "4px 0 12px",
        }}
      >
        {room.code}
      </div>
      <button className="btn" type="button" onClick={copyInvite}>
        {copied ? "Link copied" : "Copy invite link"}
      </button>

      <p className="hint" style={{ marginTop: 20 }}>
        {players.length} of 4 players in the room
      </p>
      <div className="player-list">
        {[0, 1, 2, 3].map((slot) => {
          const p = players.find((pl) => pl.quadrant === slot);
          return (
            <div key={slot} className={`player-slot ${p ? "filled" : ""}`}>
              <span className="slot-index">Q{slot + 1}</span>
              <span>{p ? p.name : "- empty -"}</span>
            </div>
          );
        })}
      </div>

      <div className="row" style={{ marginTop: 24 }}>
        <select
          className="input"
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value)}
          disabled={room.starting}
        >
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
        <button
          className="btn btn-accent"
          type="button"
          disabled={room.starting}
          onClick={() => socket.emit("start_game", difficulty)}
        >
          {room.starting ? "Generating scene..." : "Start Game"}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 12 }}>
        Anyone in the room can start the round once everyone has joined.
      </p>
    </div>
  );
}
