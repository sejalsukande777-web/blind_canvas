import { useEffect, useRef, useState } from "react";
import { socket } from "../socket.js";
import { useHandTracking } from "../hooks/useHandTracking.js";
import { useSpeechPenalty } from "../hooks/useSpeechPenalty.js";

const SIZE = 420;

export default function DrawCanvas({
  quadrant,
  clue,
  bannedWords,
  timeLeft,
  timerStarted,
  readyPlayerIds,
  submittedQuadrants,
  advancing,
  ghostPositions,
  players,
  submitted,
}) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const lastPoint = useRef(null);
  const hasSignaledReady = useRef(false);

  const [inputMode, setInputMode] = useState("gesture");
  const gestureActive = inputMode === "gesture";
  const { videoRef, status, error, indexPos, isPinching, handVisible } =
    useHandTracking(gestureActive);

  function handleBannedWordDetected(word) {
    socket.emit("banned_word_spoken", word);
  }
  const {
    listening: micListening,
    status: micStatus,
    error: micError,
    lastHeard,
  } = useSpeechPenalty(true, bannedWords, handleBannedWordDetected);

  const [mousePos, setMousePos] = useState(null);

  useEffect(() => {
    if (hasSignaledReady.current) return;
    const cameraReady = gestureActive && status === "ready";
    const mouseChosen = !gestureActive;
    if (cameraReady || mouseChosen) {
      hasSignaledReady.current = true;
      socket.emit("player_ready");
    }
  }, [gestureActive, status]);

  const [tool, setTool] = useState("draw");
  const toolRef = useRef(tool);
  toolRef.current = tool;

  const DRAW_COLOR = "#1a1a2e";
  const DRAW_WIDTH = 4;
  const ERASE_WIDTH = 26;

  useEffect(() => {
    const ctx = canvasRef.current.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.lineCap = "round";
  }, []);

  function drawSegment(from, to) {
    const ctx = canvasRef.current.getContext("2d");
    const erasing = toolRef.current === "erase";
    ctx.strokeStyle = erasing ? "#ffffff" : DRAW_COLOR;
    ctx.lineWidth = erasing ? ERASE_WIDTH : DRAW_WIDTH;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  function getMousePos(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handlePointerDown(e) {
    drawing.current = true;
    lastPoint.current = getMousePos(e);
  }

  function handlePointerMove(e) {
    const pos = getMousePos(e);
    setMousePos(pos);
    socket.emit("ghost_move", { x: pos.x / SIZE, y: pos.y / SIZE });
    if (!drawing.current) return;
    drawSegment(lastPoint.current, pos);
    lastPoint.current = pos;
  }

  function handlePointerUp() {
    drawing.current = false;
  }

  function handlePointerLeave() {
    drawing.current = false;
    setMousePos(null);
  }

  useEffect(() => {
    if (!gestureActive || !indexPos) return;
    const pos = { x: indexPos.x * SIZE, y: indexPos.y * SIZE };

    socket.emit("ghost_move", { x: indexPos.x, y: indexPos.y });

    if (isPinching) {
      if (drawing.current && lastPoint.current) {
        const dx = pos.x - lastPoint.current.x;
        const dy = pos.y - lastPoint.current.y;
        const moved = Math.sqrt(dx * dx + dy * dy);
        if (moved < 2) return;
        drawSegment(lastPoint.current, pos);
      }
      drawing.current = true;
      lastPoint.current = pos;
    } else {
      drawing.current = false;
      lastPoint.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexPos, isPinching, gestureActive]);

  function clearCanvas() {
    const ctx = canvasRef.current.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, SIZE, SIZE);
  }

  function submit() {
    const dataUrl = canvasRef.current.toDataURL("image/png");
    socket.emit("submit_canvas", dataUrl);
  }

  useEffect(() => {
    function handleAutoSubmitRequest() {
      if (submitted) return;
      submit();
    }
    socket.on("request_auto_submit", handleAutoSubmitRequest);
    return () => socket.off("request_auto_submit", handleAutoSubmitRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted]);

  const others = players.filter((p) => p.quadrant !== quadrant);
  const readyCount = (readyPlayerIds || []).length;
  const submittedCount = (submittedQuadrants || []).length;

  return (
    <div className="panel">
      <div className="row space-between">
        <div>
          <span className="pill">Quadrant Q{quadrant + 1}</span>
          <span className="pill pill-accent">Clue: {clue}</span>
        </div>
        <div className="timer">{timerStarted ? `${timeLeft}s` : "—"}</div>
      </div>

      {advancing && (
        <div className="toast toast-penalty" style={{ position: "static", margin: "8px 0" }}>
          Wrapping up — grabbing everyone's latest canvas...
        </div>
      )}

      {!timerStarted && (
        <div className="waiting-room">
          <p className="hint">
            Waiting for everyone's camera to be ready before the timer
            starts — {readyCount}/{players.length} ready.
          </p>
          <div className="player-list" style={{ marginTop: 8 }}>
            {players.map((p) => {
              const isMe = p.quadrant === quadrant;
              const ready = (readyPlayerIds || []).includes(p.id);
              return (
                <div key={p.id} className={`player-slot ${ready ? "filled" : ""}`}>
                  <span className="slot-index">{ready ? "✓" : "…"}</span>
                  <span>
                    {p.name}
                    {isMe ? " (you)" : ""}
                  </span>
                </div>
              );
            })}
          </div>
          <button
            className="btn"
            style={{ marginTop: 12 }}
            onClick={() => socket.emit("force_start_timer")}
          >
            Someone stuck? Start timer anyway
          </button>
        </div>
      )}

      {gestureActive && (
        <div className="gesture-status-row">
          {status === "loading" && (
            <span className="pill">Loading hand tracking...</span>
          )}
          {status === "ready" && !handVisible && (
            <span className="pill">Show your hand to the camera</span>
          )}
          {status === "ready" && handVisible && (
            <span className={`pill ${isPinching ? "pill-accent" : ""}`}>
              {isPinching ? "Drawing (pinched)" : "Hand tracked — pinch to draw"}
            </span>
          )}
          {status === "error" && (
            <span className="pill pill-error">
              Tracking error: {error || "camera unavailable"}
            </span>
          )}
          <button className="btn btn-link" onClick={() => setInputMode("mouse")}>
            Tracking not working? Switch to mouse
          </button>
        </div>
      )}
      {!gestureActive && (
        <div className="gesture-status-row">
          <span className="pill">Mouse fallback active</span>
          <button className="btn btn-link" onClick={() => setInputMode("gesture")}>
            Switch back to hand tracking
          </button>
        </div>
      )}

      <div className="gesture-status-row">
        {micStatus === "unsupported" && (
          <span className="pill pill-error">Speech detection not supported — use Chrome</span>
        )}
        {micStatus === "error" && (
          <span className="pill pill-error">{micError}</span>
        )}
        {micStatus === "listening" && (
          <span className="pill pill-accent">🎤 Listening for banned words</span>
        )}
        {lastHeard && (
          <span className="pill" title="Most recently heard sentence">
            Heard: "{lastHeard}"
          </span>
        )}
      </div>

      <div className="row" style={{ alignItems: "flex-start", gap: 24 }}>
        <div className="canvas-stack">
          <canvas
            ref={canvasRef}
            width={SIZE}
            height={SIZE}
            className="canvas"
            onPointerDown={!gestureActive ? handlePointerDown : undefined}
            onPointerMove={!gestureActive ? handlePointerMove : undefined}
            onPointerUp={!gestureActive ? handlePointerUp : undefined}
            onPointerLeave={!gestureActive ? handlePointerLeave : undefined}
            style={{ cursor: gestureActive ? "default" : "none" }}
          />
          {gestureActive && indexPos && (
            <div
              className={`custom-cursor ${isPinching ? "pinching" : ""} ${
                tool === "erase" ? "erasing" : ""
              }`}
              style={{
                left: `${indexPos.x * 100}%`,
                top: `${indexPos.y * 100}%`,
              }}
            />
          )}
          {!gestureActive && mousePos && (
            <div
              className={`custom-cursor ${drawing.current ? "pinching" : ""} ${
                tool === "erase" ? "erasing" : ""
              }`}
              style={{
                left: `${(mousePos.x / SIZE) * 100}%`,
                top: `${(mousePos.y / SIZE) * 100}%`,
              }}
            />
          )}
        </div>

        <div className="side-panel">
          {gestureActive && (
            <div className="webcam-preview">
              <p className="hint">Your camera (mirrored)</p>
              <video ref={videoRef} className="webcam-video" muted playsInline />
            </div>
          )}

          <div className="ghost-panel">
            <p className="hint">Ghost hands</p>
            {others.map((p) => {
              const pos = ghostPositions[p.id];
              return (
                <div key={p.id} className="ghost-track">
                  <span className="ghost-label">{p.name}</span>
                  <div className="ghost-box">
                    {pos && (
                      <div
                        className="ghost-dot"
                        style={{
                          left: `${pos.x * 100}%`,
                          top: `${pos.y * 100}%`,
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="submit-status-panel">
            <p className="hint">
              Submitted ({submittedCount}/{players.length})
            </p>
            {players.map((p) => {
              const done = (submittedQuadrants || []).includes(p.quadrant);
              return (
                <div key={p.id} className="submit-status-row">
                  <span className={done ? "status-done" : "status-pending"}>
                    {done ? "✓" : "…"}
                  </span>
                  <span>
                    {p.name}
                    {p.quadrant === quadrant ? " (you)" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className={`btn ${tool === "draw" ? "btn-accent" : ""}`}
          onClick={() => setTool("draw")}
        >
          Draw
        </button>
        <button
          className={`btn ${tool === "erase" ? "btn-accent" : ""}`}
          onClick={() => setTool("erase")}
        >
          Erase
        </button>
        <button className="btn" onClick={clearCanvas}>
          Clear All
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={submitted}>
          {submitted ? "Submitted ✓" : "Submit Drawing"}
        </button>
        <button
          className="btn btn-link"
          disabled={submittedCount === 0}
          onClick={() => socket.emit("force_advance")}
          title="Move on even if not everyone has submitted yet"
        >
          Move on without everyone
        </button>
      </div>
    </div>
  );
}
