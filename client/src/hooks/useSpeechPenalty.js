import { useEffect, useRef, useState } from "react";

/**
 * Listens to the player's mic continuously and reports it whenever a
 * finalized sentence contains one of the banned words. Only acts on
 * FINAL results (not interim/in-progress ones) — Web Speech API fires
 * interim results repeatedly as a sentence builds up ("the... the
 * apple... the apple is..."), and checking those too would fire the
 * same penalty multiple times for one utterance.
 *
 * This is purely a browser API — no server call, no npm package. It is
 * NOT tested with a real microphone anywhere in this project's
 * development, since that's impossible outside a real browser. You are
 * the first real test of whether detection timing/accuracy feels right.
 *
 * @param {boolean} active - only listens while true
 * @param {string[]} bannedWords
 * @param {(word: string, heardText: string) => void} onBannedWordDetected
 */
export function useSpeechPenalty(active, bannedWords, onBannedWordDetected) {
  const recognitionRef = useRef(null);
  const shouldBeListeningRef = useRef(false);
  const bannedWordsRef = useRef(bannedWords);
  const onDetectedRef = useRef(onBannedWordDetected);

  // Keep these in refs so the start/stop effect below doesn't need to
  // re-run every time the parent re-renders with a new inline function.
  bannedWordsRef.current = bannedWords;
  onDetectedRef.current = onBannedWordDetected;

  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | listening | error | unsupported
  const [error, setError] = useState(null);
  const [lastHeard, setLastHeard] = useState(null);

  useEffect(() => {
    if (!active) return;

    const SpeechRecognitionImpl =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionImpl) {
      setStatus("unsupported");
      setError("This browser doesn't support live speech detection (try Chrome).");
      return;
    }

    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setListening(true);
      setStatus("listening");
      setError(null);
    };

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) continue; // ignore in-progress speech, only act on finished sentences

        const heardText = result[0].transcript.trim();
        setLastHeard(heardText);

        const said = heardText.toLowerCase();
        const hit = bannedWordsRef.current.find((w) => said.includes(w.toLowerCase()));
        if (hit) {
          onDetectedRef.current?.(hit, heardText);
        }
      }
    };

    recognition.onerror = (event) => {
      // "no-speech" fires constantly during normal silence between
      // sentences — that's expected, not a real error, so don't surface it.
      if (event.error === "no-speech") return;

      setStatus("error");
      setError(
        event.error === "not-allowed"
          ? "Microphone access denied — banned-word detection is off this round."
          : `Speech detection error: ${event.error}`
      );
    };

    recognition.onend = () => {
      setListening(false);
      // Some browsers stop recognition after a period of silence even in
      // continuous mode. If we're still supposed to be listening, restart
      // automatically so the player doesn't lose detection mid-round.
      if (shouldBeListeningRef.current) {
        try {
          recognition.start();
        } catch {
          // already starting/started — ignore, this can race harmlessly
        }
      }
    };

    recognitionRef.current = recognition;
    shouldBeListeningRef.current = true;

    try {
      recognition.start();
    } catch (e) {
      setStatus("error");
      setError(e.message || "Could not start microphone.");
    }

    return () => {
      shouldBeListeningRef.current = false;
      recognition.onend = null; // prevent the auto-restart firing during our own intentional stop
      recognition.stop();
      recognitionRef.current = null;
      setListening(false);
      setStatus("idle");
    };
  }, [active]);

  return { listening, status, error, lastHeard };
}
