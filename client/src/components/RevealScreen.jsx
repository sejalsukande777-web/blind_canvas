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
        Scores are placeholder word-overlap (mockSimilarity in mockAI.js) —
        Phase 5 swaps this for real embedding cosine similarity, and both
        guesses come from Gemini instead of the mock lists.
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
