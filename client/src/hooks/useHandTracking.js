import { useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

// Landmark indices per MediaPipe's 21-point hand model.
const THUMB_TIP = 4;
const INDEX_TIP = 8;

// Hysteresis on pinch detection: two different thresholds for "start
// pinching" vs "stop pinching", rather than one. Without this, the raw
// distance hovers right around a single threshold and flickers on/off
// dozens of times a second while you hold a steady pinch — which is what
// causes drawing to break into disconnected little segments instead of
// one continuous stroke. With separate enter/exit thresholds, once
// you've started pinching you have to open your fingers noticeably
// wider before it counts as released, which absorbs the jitter.
const PINCH_ENTER = 0.055; // distance must drop below this to START a pinch
const PINCH_EXIT = 0.08; // distance must rise above this to END a pinch

// Position smoothing: an exponential moving average blends each new raw
// landmark position with the previous smoothed position instead of using
// the raw (noisy) position directly. Lower = smoother but more lag,
// higher = more responsive but more jitter. 0.4 is a reasonable middle
// ground to start tuning from.
const SMOOTHING = 0.25;

/**
 * Hooks up a webcam + MediaPipe HandLandmarker and returns live tracking
 * state: fingertip position (normalized 0-1, already mirrored to match
 * what the user sees in a selfie-style preview) and whether they're
 * currently "pinching" (pen down).
 *
 * @param {boolean} active - only runs the camera/model when true, so it's
 *   easy to fully tear down when a player switches to the mouse fallback.
 */
export function useHandTracking(active) {
  const videoRef = useRef(null);
  const landmarkerRef = useRef(null);
  const rafRef = useRef(null);
  const streamRef = useRef(null);
  const smoothedPosRef = useRef(null); // last smoothed {x, y}, persists across frames
  const pinchingRef = useRef(false); // current pinch state, for hysteresis

  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [error, setError] = useState(null);
  const [indexPos, setIndexPos] = useState(null); // {x, y} normalized, mirrored, smoothed
  const [isPinching, setIsPinching] = useState(false);
  const [handVisible, setHandVisible] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function setup() {
      setStatus("loading");
      setError(null);
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
        );

        let landmarker;
        try {
          landmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
              delegate: "GPU",
            },
            runningMode: "VIDEO",
            numHands: 1, // one drawing hand per player is all we need
          });
        } catch (gpuErr) {
          // Some laptops (integrated graphics, older drivers) choke on the
          // WebGL GPU delegate. Fall back to CPU rather than failing hard —
          // slower, but far more compatible, which matters since this is
          // meant to run on modest hardware.
          landmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
              delegate: "CPU",
            },
            runningMode: "VIDEO",
            numHands: 1,
          });
        }
        if (cancelled) return;
        landmarkerRef.current = landmarker;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 480, height: 360 },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        setStatus("ready");
        loop();
      } catch (e) {
        if (cancelled) return;
        setError(e.message || "Could not start camera/hand tracking.");
        setStatus("error");
      }
    }

    function loop() {
      if (cancelled || !landmarkerRef.current || !videoRef.current) return;
      const video = videoRef.current;
      if (video.readyState >= 2) {
        const result = landmarkerRef.current.detectForVideo(video, performance.now());
        if (result.landmarks && result.landmarks.length > 0) {
          const hand = result.landmarks[0];
          const thumb = hand[THUMB_TIP];
          const index = hand[INDEX_TIP];

          // Mirror x so it matches a selfie-style preview (moving your
          // hand right visually moves the point right on screen).
          const rawX = 1 - index.x;
          const rawY = index.y;

          // Exponential moving average smoothing — see SMOOTHING comment above.
          if (smoothedPosRef.current) {
            smoothedPosRef.current = {
              x: smoothedPosRef.current.x + SMOOTHING * (rawX - smoothedPosRef.current.x),
              y: smoothedPosRef.current.y + SMOOTHING * (rawY - smoothedPosRef.current.y),
            };
          } else {
            smoothedPosRef.current = { x: rawX, y: rawY };
          }
          setIndexPos(smoothedPosRef.current);

          const dx = thumb.x - index.x;
          const dy = thumb.y - index.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          // Hysteresis — see PINCH_ENTER/PINCH_EXIT comment above.
          if (pinchingRef.current) {
            if (dist > PINCH_EXIT) pinchingRef.current = false;
          } else {
            if (dist < PINCH_ENTER) pinchingRef.current = true;
          }
          setIsPinching(pinchingRef.current);
          setHandVisible(true);
        } else {
          setHandVisible(false);
          setIsPinching(false);
          pinchingRef.current = false;
          smoothedPosRef.current = null; // don't smooth across a hand re-appearing later
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    }

    setup();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      // Explicitly clear the video element's source too, not just stopping
      // the tracks — this makes sure the browser can actually release the
      // decoded video frame buffers right away instead of possibly holding
      // them until garbage collection gets around to it. Matters more than
      // it sounds like on a memory-constrained machine.
      if (videoRef.current) videoRef.current.srcObject = null;
      if (landmarkerRef.current) landmarkerRef.current.close();
      landmarkerRef.current = null;
      smoothedPosRef.current = null;
      pinchingRef.current = false;
      setStatus("idle");
      setIndexPos(null);
      setIsPinching(false);
      setHandVisible(false);
    };
  }, [active]);

  return { videoRef, status, error, indexPos, isPinching, handVisible };
}
