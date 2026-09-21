// ai.js — real Gemini-backed AI module
//
// Requires a GEMINI_API_KEY environment variable (see server/.env.example).
// Get a free key, no credit card required, at https://aistudio.google.com/apikey
//
// generatePrompt()      -> Prompt-AI       (text-only call)
// guessFromImage()      -> Guesser-AI      (vision call) — a FULLY SEPARATE
//                           call from generatePrompt(), zero shared
//                           conversation history. Must never see the real
//                           scene text.
// semanticSimilarity()  -> real embedding-based scoring.
//
// All three wrap their real API call in withRetry() — Google's free tier
// occasionally returns a transient 503 "high demand" error that usually
// succeeds on a second try seconds later, so retrying once before falling
// back avoids treating a temporary blip as a hard failure.

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Model names Google has changed twice already during this project's
// development (gemini-2.5-flash and text-embedding-004 both got retired
// for new keys mid-project). If either of these ever 404s again, check
// https://ai.google.dev/gemini-api/docs/models for the current name.
const MODEL = "gemini-3.6-flash";
const EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * Retries a flaky async call once after a short delay before giving up.
 * Only helps with transient failures (like a temporary 503) — a genuinely
 * wrong model name or bad key will fail the same way both times, and
 * that's fine, it just means we give up slightly slower in that case.
 */
async function withRetry(fn, retries = 1, delayMs = 1500) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        console.log(`[ai.js] call failed (attempt ${attempt + 1}), retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// A small POOL of fallback scenes, not one fixed scene — so if the real
// call does have to fall back, it's not obviously the same "apple" every
// single time. Still not real generation, just less suspicious-looking
// when it does happen. All easy/simple on purpose, regardless of the
// difficulty that was actually requested, since this only fires when we
// couldn't ask Gemini for anything at all.
const FALLBACK_SCENES = [
  {
    scene: "a red apple on a table",
    sharedClue: "apple on table",
    subClues: ["top of apple", "stem of apple", "table top", "apple's shadow"],
    bannedWords: ["apple", "red", "table", "fruit"],
  },
  {
    scene: "a small dog running in a park",
    sharedClue: "dog running",
    subClues: ["dog's head", "dog's legs", "green grass", "park trees"],
    bannedWords: ["dog", "run", "park", "grass"],
  },
  {
    scene: "a cup of tea on a table",
    sharedClue: "cup of tea",
    subClues: ["steam rising", "cup handle", "saucer plate", "table top"],
    bannedWords: ["cup", "tea", "table", "hot"],
  },
  {
    scene: "a teddy bear sitting on a bed",
    sharedClue: "teddy bear on bed",
    subClues: ["bear's head", "bear's arms", "bed pillow", "bed blanket"],
    bannedWords: ["teddy", "bear", "bed", "soft"],
  },
];

function randomFallbackScene() {
  return FALLBACK_SCENES[Math.floor(Math.random() * FALLBACK_SCENES.length)];
}

function parseSceneJSON(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (
    !parsed.scene ||
    !parsed.sharedClue ||
    !Array.isArray(parsed.subClues) ||
    parsed.subClues.length !== 4 ||
    !Array.isArray(parsed.bannedWords)
  ) {
    throw new Error("Gemini response missing required fields: " + text);
  }
  return parsed;
}

export async function generatePrompt(difficulty = "easy") {
  const concreteness =
    difficulty === "hard"
      ? "an abstract or multi-element scene that takes real interpretation to recognize (but still describable in simple words)"
      : difficulty === "medium"
      ? "a recognizable scene with 2-3 elements and a bit of action"
      : "one single, very simple, concrete object or animal in a plain setting — something a child could easily draw";

  const prompt = `You are generating content for a party drawing-and-guessing game.
Generate ONE hidden scene for a team of 4 players to collaboratively draw,
where each player only draws one quarter of it and never sees the others'
work until the end.

Rules, follow all of them exactly:
- Difficulty level: ${difficulty}. The scene should be ${concreteness}.
- Use ONLY simple, everyday English words in every field below. No idioms,
  no uncommon vocabulary, no obscure references. Many players are not
  native English speakers, so simplicity matters more than cleverness.
- "subClues" must have exactly 4 short clues (2-4 words each), one for
  each quadrant of a 2x2 grid, IN THIS EXACT ORDER: [top-left, top-right,
  bottom-left, bottom-right]. Each should describe what belongs in that
  specific part of the scene, so a team can figure out where a shuffled
  piece belongs.
- "bannedWords" must have 4-6 words closely related to the scene that
  players must avoid saying out loud while drawing (Taboo-style).

Respond with ONLY valid JSON, no markdown code fences, no commentary,
in exactly this shape:
{"scene": "...", "sharedClue": "...", "subClues": ["...","...","...","..."], "bannedWords": ["...", "..."]}`;

  try {
    const response = await withRetry(() =>
      ai.models.generateContent({ model: MODEL, contents: prompt })
    );
    return parseSceneJSON(response.text);
  } catch (err) {
    console.error("[ai.js] generatePrompt failed after retry, using a random fallback scene:", err.message);
    return randomFallbackScene();
  }
}

export async function guessFromImage(compositeImageDataUrl) {
  try {
    const base64Data = compositeImageDataUrl.replace(/^data:image\/\w+;base64,/, "");

    const response = await withRetry(() =>
      ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "This picture was drawn by four people, each drawing one " +
                  "quarter blind without seeing the others' work, then the " +
                  "pieces were shuffled back together. In one short phrase " +
                  "(5-10 simple words), describe what scene or object this " +
                  "composite drawing appears to show. Respond with ONLY the " +
                  "phrase — no quotation marks, no extra commentary.",
              },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: base64Data,
                },
              },
            ],
          },
        ],
      })
    );
    return response.text.trim();
  } catch (err) {
    console.error("[ai.js] guessFromImage failed after retry:", err.message);
    return "(the AI couldn't make a guess this round)";
  }
}

export async function semanticSimilarity(a, b) {
  try {
    const response = await withRetry(() =>
      ai.models.embedContent({ model: EMBEDDING_MODEL, contents: [a, b] })
    );
    const [vecA, vecB] = response.embeddings.map((e) => e.values);
    return Math.round(cosineSimilarity(vecA, vecB) * 100);
  } catch (err) {
    console.error("[ai.js] semanticSimilarity failed after retry, falling back to word overlap:", err.message);
    return wordOverlapSimilarity(a, b);
  }
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function wordOverlapSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const overlap = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size || 1;
  return Math.round((overlap / union) * 100);
}
