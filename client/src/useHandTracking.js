import { useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

// Loaded once per browser tab and cached — creating a new HandLandmarker
// per component instance is expensive (loads a WASM + model file).
let landmarkerPromise = null;
function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    ).then((fileset) =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 1,
      })
    );
  }
  return landmarkerPromise;
}

// Classic air-draw heuristic: index finger extended (tip above its own
// knuckle on screen), middle finger folded down. This is the same pattern
// used in most MediaPipe air-draw tutorials — deliberately simple and
// reasonably reliable rather than a fancier ML gesture classifier.
function isPointingGesture(landmarks) {
  const indexTip = landmarks[8];
  const indexPip = landmarks[6];
  const middleTip = landmarks[12];
  const middlePip = landmarks[10];
  const indexExtended = indexTip.y < indexPip.y;
  const middleFolded = middleTip.y > middlePip.y;
  return indexExtended && middleFolded;
}

/**
 * Hook that owns the webcam + hand-tracking loop.
 * Returns normalized (0-1) index fingertip position, mirrored to feel
 * natural (like a mirror, not a security camera), plus drawing/error state.
 */
export function useHandTracking() {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | ready | denied | error
  const [indexTip, setIndexTip] = useState(null); // {x, y} normalized, mirrored
  const [isDrawing, setIsDrawing] = useState(false);
  const [lastHandSeenAt, setLastHandSeenAt] = useState(Date.now());
  const rafRef = useRef(null);

  useEffect(() => {
    let stream;
    let cancelled = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
        });
        if (cancelled) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        const landmarker = await getLandmarker();
        if (cancelled) return;
        setStatus("ready");

        const loop = () => {
          if (cancelled) return;
          const video = videoRef.current;
          if (video && video.readyState >= 2) {
            const result = landmarker.detectForVideo(video, performance.now());
            if (result.landmarks && result.landmarks.length > 0) {
              const lm = result.landmarks[0];
              // Mirror x so it feels like a mirror, not a rear camera.
              setIndexTip({ x: 1 - lm[8].x, y: lm[8].y });
              setIsDrawing(isPointingGesture(lm));
              setLastHandSeenAt(Date.now());
            } else {
              setIsDrawing(false);
              // keep last indexTip position rather than snapping to null,
              // to avoid a jarring jump when hand briefly leaves frame
            }
          }
          rafRef.current = requestAnimationFrame(loop);
        };
        loop();
      } catch (err) {
        if (cancelled) return;
        console.error("Hand tracking init failed:", err);
        setStatus(err.name === "NotAllowedError" ? "denied" : "error");
      }
    }

    start();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Surface whether the hand has been missing for a while, so the UI can
  // offer the mouse fallback as troubleshooting, not as a default choice.
  const handMissingMs = Date.now() - lastHandSeenAt;

  return { videoRef, status, indexTip, isDrawing, handMissingMs };
}
