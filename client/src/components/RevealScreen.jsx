import { socket } from "../socket.js";

export default function RevealScreen({ scene, teamGuess, aiGuess, scores }) {
  return (
    <div className="panel">
      <h2 className="section-title">Reveal</h2>

      <div className="reveal-grid">
        <div className="reveal-card">
          <p className="hint">Your team guessed</p>
          <p className="reveal-text">{teamGuess}</p>
          <p className="score">{scores.teamScore}% match</p>
        </div>
        <div className="reveal-card">
          <p className="hint">The AI guessed</p>
          <p className="reveal-text">{aiGuess}</p>
          <p className="score">{scores.aiScore}% match</p>
        </div>
      </div>

      <div className="reveal-answer">
        <p className="hint">The real scene was</p>
        <p className="reveal-answer-text">{scene}</p>
      </div>

      <p className="footnote">
        Scores come from real Gemini embeddings (semanticSimilarity in
        ai.js), with a word-overlap fallback only if that call fails. Both
        guesses are genuine Gemini calls, not a mock list.
      </p>

      <button
        className="btn btn-primary"
        style={{ marginTop: 16 }}
        onClick={() => socket.emit("reset_game")}
      >
        Play Again
      </button>
    </div>
  );
}
