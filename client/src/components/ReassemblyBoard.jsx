import { useRef, useState } from "react";
import { socket } from "../socket.js";

const TILE = 220;

export default function ReassemblyBoard({ shuffledImages, locked, onLockArrangement }) {
  const [cells, setCells] = useState([null, null, null, null]);
  const [guess, setGuess] = useState("");
  const canvasRef = useRef(null);

  const placedIndices = new Set(cells.filter((c) => c !== null));
  const trayImages = shuffledImages
    .map((img, i) => ({ img, i }))
    .filter(({ i }) => !placedIndices.has(i));

  function handleDrop(cellIndex, e) {
    e.preventDefault();
    if (locked) return;
    const sourceIndex = Number(e.dataTransfer.getData("text/plain"));
    setCells((prev) => {
      const next = [...prev];
      const existingCell = next.indexOf(sourceIndex);
      if (existingCell !== -1) next[existingCell] = null;
      next[cellIndex] = sourceIndex;
      return next;
    });
  }

  function buildComposite() {
    const canvas = canvasRef.current;
    canvas.width = TILE * 2;
    canvas.height = TILE * 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const positions = [
      [0, 0],
      [TILE, 0],
      [0, TILE],
      [TILE, TILE],
    ];
    return Promise.all(
      cells.map((imgIndex, cellIndex) => {
        if (imgIndex === null) return Promise.resolve();
        const src = shuffledImages[imgIndex];
        if (!src) return Promise.resolve();
        return new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            const [x, y] = positions[cellIndex];
            ctx.drawImage(image, x, y, TILE, TILE);
            resolve();
          };
          image.src = src;
        });
      })
    ).then(() => canvas.toDataURL("image/png"));
  }

  function lockArrangement() {
    if (trayImages.length > 0) return;
    socket.emit("reassembly_submit");
    onLockArrangement?.();
  }

  async function submitGuess(e) {
    e.preventDefault();
    if (!guess.trim()) return;
    const compositeImage = await buildComposite();
    socket.emit("guess_submit", { teamGuess: guess.trim(), compositeImage });
  }

  function PieceTile({ src, draggable, onDragStart, className }) {
    if (!src) {
      return (
        <div className={`tile-img tile-blank ${className || ""}`} draggable={draggable} onDragStart={onDragStart}>
          <span className="tile-blank-label">blank</span>
        </div>
      );
    }
    return (
      <img
        src={src}
        alt=""
        draggable={draggable}
        onDragStart={onDragStart}
        className={`tile-img ${className || ""}`}
      />
    );
  }

  return (
    <div className="panel">
      <h2 className="section-title">Reassemble the scene</h2>
      <p className="hint">
        Pieces are shuffled — drag each one into the grid where you think it
        belongs. No auto-snap: you have to place it deliberately.
      </p>

      <div className="row" style={{ alignItems: "flex-start", gap: 32 }}>
        <div className="grid-2x2" style={{ width: TILE * 2, height: TILE * 2 }}>
          {[0, 1, 2, 3].map((cellIndex) => (
            <div
              key={cellIndex}
              className="grid-cell"
              style={{ width: TILE, height: TILE }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleDrop(cellIndex, e)}
            >
              {cells[cellIndex] !== null ? (
                <PieceTile
                  src={shuffledImages[cells[cellIndex]]}
                  draggable={!locked}
                  onDragStart={(e) =>
                    e.dataTransfer.setData("text/plain", String(cells[cellIndex]))
                  }
                />
              ) : (
                <span className="cell-placeholder">drop here</span>
              )}
            </div>
          ))}
        </div>

        <div className="tray">
          <p className="hint">Unplaced pieces</p>
          <div className="tray-items">
            {trayImages.map(({ img, i }) => (
              <PieceTile
                key={i}
                src={img}
                draggable={!locked}
                onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i))}
                className="tray-img"
              />
            ))}
          </div>
        </div>
      </div>

      {!locked ? (
        <button
          className="btn btn-accent"
          style={{ marginTop: 16 }}
          disabled={trayImages.length > 0}
          onClick={lockArrangement}
        >
          Lock Arrangement
        </button>
      ) : (
        <div style={{ marginTop: 16 }}>
          <p className="hint">
            Talk it over as a team — everyone can see this same screen and
            discuss out loud (or on a call). Once you agree, <strong>only
            one person needs to type and submit</strong> the answer below
            for the whole team — whoever's fastest, not everyone
            separately. The AI makes its own independent guess from the
            picture alone, and both guesses get compared to the real
            answer on the reveal screen.
          </p>
          <form onSubmit={submitGuess} className="row">
            <input
              className="input"
              placeholder="What's the scene? (team's guess)"
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              autoFocus
              autoComplete="off"
            />
            <button className="btn btn-primary" type="submit">
              Submit Guess
            </button>
          </form>
        </div>
      )}

      <canvas ref={canvasRef} style={{ display: "none" }} />
    </div>
  );
}
