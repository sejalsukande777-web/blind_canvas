import { io } from "socket.io-client";

// During dev, point this at the server laptop's LAN IP if testing across
// multiple machines, e.g. "http://192.168.1.23:3001". localhost works when
// everyone runs the server locally too (single-machine multi-tab testing).
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

export const socket = io(SERVER_URL, { autoConnect: true });
