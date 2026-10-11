import { useEffect, useRef, useState } from "react";
import { socket } from "./socket.js";
import Lobby from "./components/Lobby.jsx";
import DrawCanvas from "./components/DrawCanvas.jsx";
import ReassemblyBoard from "./components/ReassemblyBoard.jsx";
import RevealScreen from "./components/RevealScreen.jsx";

export default function App() {
  const [connected, setConnected] = useState(socket.connected);
  const [serverState, setServerState] = useState(null);
  const [joined, setJoined] = useState(false); // true once we are inside a room
  const [myAssignment, setMyAssignment] = useState(null); // { quadrant, clue, bannedWords }
  const [ghostPositions, setGhostPositions] = useState({});
  const [reassemblyLocked, setReassemblyLocked] = useState(false);
  const [notice, setNotice] = useState(null);
  const [penaltyToast, setPenaltyToast] = useState(null);
  const noticeTimer = useRef(null);
  const penaltyTimer = useRef(null);

  useEffect(() => {
    function showNotice(msg) {
      setNotice(msg);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), 4000);
    }

    // The server forgets us when the connection drops, so forget the room too.
    function leaveLocalRoom() {
      setJoined(false);
      setServerState(null);
      setMyAssignment(null);
      setReassemblyLocked(false);
      setGhostPositions({});
    }

    const onConnect = () => setConnected(true);
    const onDisconnect = () => {
      setConnected(false);
      leaveLocalRoom();
      showNotice("Connection lost. Create or join a room again to keep playing.");
    };
    const onConnectError = () =>
      showNotice("Can't reach the server yet. If it was idle it can take up to a minute to wake up.");
    const onState = (s) => setServerState(s);
    const onJoined = () => setJoined(true);
    const onAssignment = (a) => {
      setMyAssignment(a);
      setReassemblyLocked(false);
    };
    const onGhost = ({ playerId, x, y }) =>
      setGhostPositions((prev) => ({ ...prev, [playerId]: { x, y } }));
    const onPenalty = ({ playerName, secondsLost }) => {
      setPenaltyToast(`${playerName} said a banned word: -${secondsLost}s`);
      clearTimeout(penaltyTimer.current);
      penaltyTimer.current = setTimeout(() => setPenaltyToast(null), 3000);
    };
    const onJoinError = (msg) => showNotice(msg);
    const onReset = () => {
      // Back to the lobby, but we stay in the same room with the same players.
      setMyAssignment(null);
      setReassemblyLocked(false);
      setGhostPositions({});
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("state", onState);
    socket.on("joined", onJoined);
    socket.on("your_assignment", onAssignment);
    socket.on("ghost_move", onGhost);
    socket.on("penalty", onPenalty);
    socket.on("join_error", onJoinError);
    socket.on("game_reset", onReset);

    // The connection may have finished before this effect ran.
    setConnected(socket.connected);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("state", onState);
      socket.off("joined", onJoined);
      socket.off("your_assignment", onAssignment);
      socket.off("ghost_move", onGhost);
      socket.off("penalty", onPenalty);
      socket.off("join_error", onJoinError);
      socket.off("game_reset", onReset);
      clearTimeout(noticeTimer.current);
      clearTimeout(penaltyTimer.current);
    };
  }, []);

  const toasts = (
    <>
      {notice && <div className="toast toast-error">{notice}</div>}
      {penaltyToast && <div className="toast toast-penalty">{penaltyToast}</div>}
    </>
  );

  if (!connected) {
    return (
      <div className="app-shell">
        {toasts}
        <div className="panel">
          <h1 className="title">Blind Canvas</h1>
          <p className="subtitle">Connecting to the server...</p>
          <p className="hint">
            The free server sleeps when nobody is using it, so the first
            connection can take up to a minute.
          </p>
        </div>
      </div>
    );
  }

  const {
    phase,
    players = [],
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
    scoring,
  } = serverState || {};

  const inRoom = joined && !!serverState;
  const showLobby = !joined || !serverState || phase === "LOBBY";

  return (
    <div className="app-shell">
      {toasts}

      {inRoom && phase !== "LOBBY" && (
        <button
          className="btn reset-corner"
          onClick={() => socket.emit("reset_game")}
          title="Send everyone in this room back to the lobby"
        >
          Reset Game
        </button>
      )}

      {inRoom && scoring && (
        <div className="toast toast-penalty" style={{ top: 64 }}>
          Scoring your guess. The AI is studying the drawing...
        </div>
      )}

      {showLobby && <Lobby joined={joined} room={joined ? serverState : null} />}

      {inRoom && phase === "DRAWING" && myAssignment && (
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

      {inRoom && phase === "DRAWING" && !myAssignment && (
        <div className="panel">
          <p className="hint">Getting your clue...</p>
        </div>
      )}

      {inRoom && (phase === "REASSEMBLY" || phase === "GUESS") && shuffledOrder && (
        <ReassemblyBoard
          shuffledImages={shuffledOrder.map((q) => submittedCanvases[q])}
          locked={phase === "GUESS" || reassemblyLocked}
          onLockArrangement={() => setReassemblyLocked(true)}
        />
      )}

      {inRoom && phase === "REVEAL" && (
        <RevealScreen scene={scene} teamGuess={teamGuess} aiGuess={aiGuess} scores={scores} />
      )}
    </div>
  );
}
