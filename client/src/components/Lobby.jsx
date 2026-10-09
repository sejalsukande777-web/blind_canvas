import { useState } from "react";
import { socket } from "../socket.js";

export default function Lobby({ players, joined }) {
  const [name, setName] = useState("");
  const [difficulty, setDifficulty] = useState("medium");

  function handleJoin() {
    const trimmed = name.trim();
    if (!trimmed) return;
    socket.emit("join", trimmed);
  }

  function handleNameKeyDown(e) {
    if (e.key === "Enter") handleJoin();
  }

  function handleStart() {
    socket.emit("start_game", difficulty);
  }

  return (
    <div className="panel">
      <h1 className="title">Blind Canvas</h1>
      <p className="subtitle">
        Four players. One hidden scene. Nobody sees the whole picture alone.
      </p>

      {!joined ? (
        <div className="row">
          <input
            className="input"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleNameKeyDown}
            autoFocus
            autoComplete="off"
            name="airdraw-player-name"
            // Chrome frequently ignores autoComplete="off" on fields it
            // heuristically treats as a "name" field, and <form> elements
            // trigger stronger autofill/autosubmit behavior generally.
            // Using a plain button click (not a form submit) sidesteps
            // both issues rather than fighting the browser's heuristics.
          />
          <button className="btn btn-primary" type="button" onClick={handleJoin}>
            Join Room
          </button>
        </div>
      ) : (
        <p className="hint">You're in. Waiting for the team...</p>
      )}

      <div className="player-list">
        {[0, 1, 2, 3].map((slot) => {
          const p = players[slot];
          return (
            <div key={slot} className={`player-slot ${p ? "filled" : ""}`}>
              <span className="slot-index">Q{slot + 1}</span>
              <span>{p ? p.name : "— empty —"}</span>
            </div>
          );
        })}
      </div>

      {joined && (
        <div className="row" style={{ marginTop: 24 }}>
          <select
            className="input"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
          >
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
          <button className="btn btn-accent" onClick={handleStart}>
            Start Game
          </button>
        </div>
      )}

      <p className="footnote">
        Draw with your hand: pinch your thumb and index finger together to
        draw, release to lift the pen. Your browser will ask for camera
        permission once the round starts.
      </p>
    </div>
  );
}

