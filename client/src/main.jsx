import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// NOTE: React.StrictMode deliberately runs every effect twice in dev mode
// to help catch bugs. That's fine for most components, but useHandTracking
// spins up a webcam stream + WASM model + GPU/WebGL context — doubling
// that setup on every mount is a real memory cost, and on a memory-tight
// laptop running multiple tabs at once, it's a genuine contributor to
// out-of-memory crashes. Not using StrictMode here on purpose.
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
