import { useEffect, useState } from "react";
import { socket } from "./socket.js";
import Lobby from "./components/Lobby.jsx";
import DrawCanvas from "./components/DrawCanvas.jsx";
import ReassemblyBoard from "./components/ReassemblyBoard.jsx";
import RevealScreen from "./components/RevealScreen.jsx";

export default function App() {
  const [serverState, setServerState] = useState(null);
  const [joined, setJoined] = useState(false);
  const [myAssignment, setMyAssignment] = useState(null); // {quadrant, clue, bannedWords}
  const [ghostPositions, setGhostPositions] = useState({});
  const [penaltyToast, setPenaltyToast] = useState(null);
  const [reassemblyLocked, setReassemblyLocked] = useState(false);
  const [joinError, setJoinError] = useState(null);

  useEffect(() => {
    socket.on("state", (s) => setServerState(s));

    socket.on("joined", () => setJoined(true));

    socket.on("your_assignment", (a) => {
      setMyAssignment(a);
      setJoined(true);
      setReassemblyLocked(false);
    });

    socket.on("ghost_move", ({ playerId, x, y }) => {
      setGhostPositions((prev) => ({ ...prev, [playerId]: { x, y } }));
    });

    socket.on("penalty", ({ word, secondsLost }) => {
      setPenaltyToast(`"${word}" spoken — -${secondsLost}s penalty!`);
      setTimeout(() => setPenaltyToast(null), 3000);
    });

    socket.on("join_error", (msg) => setJoinError(msg));

    socket.on("game_reset", () => {
      setJoined(false);
      setMyAssignment(null);
      setReassemblyLocked(false);
      setGhostPositions({});
    });

    socket.on("connect_error", (err) => {
      setJoinError(`Can't reach server: ${err.message}. Is the server running?`);
    });

    return () => {
      socket.off("state");
      socket.off("joined");
      socket.off("your_assignment");
      socket.off("ghost_move");
      socket.off("penalty");
      socket.off("join_error");
      socket.off("game_reset");
      socket.off("connect_error");
    };
  }, []);

  if (!serverState) {
    return <div className="panel">Connecting to server...</div>;
  }

  const {
    phase,
    players,
    timeLeft,
    timerStarted,
    readyPlayerIds,
    submittedQuadrants,
    submittedCanvases,
    shuffledOrder,
    scene,
    teamGuess,
    aiGuess,
    scores,
    advancing,
  } = serverState;

  return (
    <div className="app-shell">
      {joinError && <div className="toast toast-error">{joinError}</div>}
      {penaltyToast && <div className="toast toast-penalty">{penaltyToast}</div>}

      {phase !== "LOBBY" && (
        <button
          className="btn reset-corner"
          onClick={() => socket.emit("reset_game")}
          title="Bail out and restart the lobby for everyone"
        >
          Reset Game
        </button>
      )}

      {phase !== "LOBBY" && !myAssignment && (
        <div className="panel">
          <h2 className="section-title">Game already in progress</h2>
          <p className="hint">
            This app only supports one room at a time, and this tab wasn't
            part of the current round. Reset the game to start a fresh
            lobby everyone (including this tab) can join.
          </p>
          <button className="btn btn-primary" onClick={() => socket.emit("reset_game")}>
            Reset Game
          </button>
        </div>
      )}

      {phase === "LOBBY" && <Lobby players={players} joined={joined} />}

      {phase === "DRAWING" && myAssignment && (
        <DrawCanvas
          quadrant={myAssignment.quadrant}
          clue={myAssignment.clue}
          bannedWords={myAssignment.bannedWords}
          timeLeft={timeLeft}
          timerStarted={timerStarted}
          readyPlayerIds={readyPlayerIds}
          submittedQuadrants={submittedQuadrants || []}
          advancing={advancing}
          ghostPositions={ghostPositions}
          players={players}
          submitted={(submittedQuadrants || []).includes(myAssignment.quadrant)}
        />
      )}

      {(phase === "REASSEMBLY" || phase === "GUESS") && shuffledOrder && (
        <ReassemblyBoard
          shuffledImages={shuffledOrder.map((q) => submittedCanvases[q])}
          locked={phase === "GUESS" || reassemblyLocked}
          onLockArrangement={() => setReassemblyLocked(true)}
        />
      )}

      {phase === "REVEAL" && (
        <RevealScreen scene={scene} teamGuess={teamGuess} aiGuess={aiGuess} scores={scores} />
      )}
    </div>
  );
}
