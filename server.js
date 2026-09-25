const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const ACTIONS = require("./src/Actions");

const DEFAULT_ORIGINS = ["http://localhost:5173", "https://compile-palace.vercel.app"];
const ERROR_EVENT = "server-error";
const MAX_ROOM_ID = 128;
const MAX_USERNAME = 64;
// Well above real editor content; keeps a single message under maxHttpBufferSize
// even at 4 bytes/char, so an oversized payload is rejected instead of the
// transport dropping the whole connection.
const MAX_CODE_CHARS = 400000;
// The client debounces code-change to ~2/s; this only stops a runaway client.
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 60;
const MAX_LOGGED_REJECTS = 5;

function log(level, msg, fields = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  (level === "error" ? console.error : console.log)(line);
}

// Browsers never send a trailing slash in the Origin header, so an origin
// configured with one (a common copy-paste from a URL bar) would silently
// never match. Strip it here rather than trusting every caller to.
const stripTrailingSlash = (o) => o.replace(/\/+$/, "");

// Extra origins are additive; "*" is ignored so it can't reopen CORS by accident.
function allowedOriginsFromEnv(env = process.env) {
  const extra = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => stripTrailingSlash(o.trim()))
    .filter((o) => o && o !== "*");
  return [...new Set([...DEFAULT_ORIGINS.map(stripTrailingSlash), ...extra])];
}

const validString = (v, max) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

// Client-chosen ids are prefixed so a roomId can never equal a socket id:
// every socket auto-joins a private room named after its own id, and an
// unprefixed roomId would let a client join (and hear) another socket's room.
const roomName = (roomId) => `room:${roomId}`;

function createServer({ allowedOrigins = allowedOriginsFromEnv() } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: allowedOrigins },
    maxHttpBufferSize: 2e6,
  });

  // Last code per room, so a late joiner starts from the current document
  // instead of relying on a peer to answer. Memory-only; dropped when the
  // room empties. The room's document is still client-authoritative.
  const snapshots = new Map();

  io.engine.on("connection_error", (err) => {
    log("warn", "connection_error", { code: err.code, message: err.message });
  });

  const clientsIn = (name) =>
    Array.from(io.sockets.adapter.rooms.get(name) || [], (socketId) => ({
      socketId,
      username: io.sockets.sockets.get(socketId)?.data.username,
    }));

  function reject(socket, event, code) {
    socket.emit(ERROR_EVENT, { event, code });
    const n = (socket.data.rejects = (socket.data.rejects || 0) + 1);
    if (n <= MAX_LOGGED_REJECTS) log("warn", "rejected", { event, code, socketId: socket.id });
  }

  function rateLimited(socket) {
    const now = Date.now();
    const r = (socket.data.rate ||= { start: now, count: 0 });
    if (now - r.start > RATE_WINDOW_MS) {
      r.start = now;
      r.count = 0;
    }
    r.count += 1;
    if (r.count === RATE_MAX + 1) reject(socket, ACTIONS.CODE_CHANGE, "rate_limited");
    return r.count > RATE_MAX;
  }

  function leaveRoom(socket) {
    const { roomId, username } = socket.data;
    if (!roomId) return;
    const name = roomName(roomId);
    socket.data.roomId = undefined;
    socket.leave(name);
    socket.to(name).emit(ACTIONS.DISCONNECTED, { socketId: socket.id, username });
    if (!io.sockets.adapter.rooms.has(name)) snapshots.delete(name);
    log("info", "left", { roomId, socketId: socket.id, username });
  }

  // One bad handler must not take the process down or go unreported.
  const guard = (socket, event, fn) => (payload) => {
    try {
      fn(payload ?? {});
    } catch (err) {
      log("error", "handler_failed", { event, socketId: socket.id, error: err.message });
      socket.emit(ERROR_EVENT, { event, code: "internal_error" });
    }
  };

  io.on("connection", (socket) => {
    log("info", "connect", { socketId: socket.id });

    socket.on(
      ACTIONS.JOIN,
      guard(socket, ACTIONS.JOIN, ({ roomId, username }) => {
        if (!validString(roomId, MAX_ROOM_ID) || !validString(username, MAX_USERNAME)) {
          return reject(socket, ACTIONS.JOIN, "invalid_payload");
        }
        const name = roomName(roomId);
        const sameRoom = socket.data.roomId === roomId;
        if (sameRoom && socket.data.username === username) {
          // The client can emit JOIN from more than one place; answer the
          // sender only so peers don't get a duplicate "joined" toast.
          return socket.emit(ACTIONS.JOINED, { clients: clientsIn(name), username, socketId: socket.id });
        }
        if (!sameRoom) leaveRoom(socket);
        socket.data.roomId = roomId;
        socket.data.username = username;
        socket.join(name);
        io.to(name).emit(ACTIONS.JOINED, { clients: clientsIn(name), username, socketId: socket.id });
        if (snapshots.has(name)) socket.emit(ACTIONS.CODE_CHANGE, { code: snapshots.get(name) });
        log("info", "join", { roomId, socketId: socket.id, username, members: io.sockets.adapter.rooms.get(name).size });
      })
    );

    socket.on(
      ACTIONS.CODE_CHANGE,
      guard(socket, ACTIONS.CODE_CHANGE, ({ roomId, code }) => {
        if (rateLimited(socket)) return;
        if (typeof roomId !== "string" || typeof code !== "string" || code.length > MAX_CODE_CHARS) {
          return reject(socket, ACTIONS.CODE_CHANGE, "invalid_payload");
        }
        if (socket.data.roomId !== roomId) return reject(socket, ACTIONS.CODE_CHANGE, "not_in_room");
        const name = roomName(roomId);
        snapshots.set(name, code);
        // Payload stays exactly { code }: the client toasts "Code updated by
        // <author>" for any payload that carries one, i.e. on every keystroke burst.
        socket.to(name).emit(ACTIONS.CODE_CHANGE, { code });
      })
    );

    // Legacy targeted sync (older client): relay to one socket, but only one in the sender's room.
    socket.on(
      ACTIONS.SYNC_CODE,
      guard(socket, ACTIONS.SYNC_CODE, ({ socketId, code }) => {
        if (typeof socketId !== "string" || typeof code !== "string" || code.length > MAX_CODE_CHARS) {
          return reject(socket, ACTIONS.SYNC_CODE, "invalid_payload");
        }
        if (!socket.data.roomId) return reject(socket, ACTIONS.SYNC_CODE, "not_in_room");
        const target = io.sockets.sockets.get(socketId);
        if (!target || target.data.roomId !== socket.data.roomId) {
          return reject(socket, ACTIONS.SYNC_CODE, "invalid_target");
        }
        target.emit(ACTIONS.CODE_CHANGE, { code });
      })
    );

    socket.on(ACTIONS.LEAVE, guard(socket, ACTIONS.LEAVE, () => leaveRoom(socket)));

    // Covers refresh, tab close and network loss too: all end in a disconnect.
    socket.on("disconnecting", () => {
      try {
        leaveRoom(socket);
      } catch (err) {
        log("error", "cleanup_failed", { socketId: socket.id, error: err.message });
      }
    });
    socket.on("disconnect", (reason) => log("info", "disconnect", { socketId: socket.id, reason }));
  });

  return { app, server, io, snapshots };
}

// Exported so a test can drive it with a fake `exit` instead of real
// signals/process.exit (signal delivery isn't reliably testable on Windows).
// Idempotent: a second call (e.g. SIGTERM then SIGINT) is a no-op instead of
// closing an already-closed io/server pair or double-firing the timer.
function createShutdown({ io, log: logger = log, exit = process.exit, timeoutMs = 10000 } = {}) {
  let called = false;
  return (signal) => {
    if (called) return;
    called = true;
    logger("info", "shutdown", { signal });
    const forceTimer = setTimeout(() => exit(1), timeoutMs);
    forceTimer.unref();
    io.close(() => {
      clearTimeout(forceTimer);
      exit(0);
    });
  };
}

module.exports = { createServer, allowedOriginsFromEnv, createShutdown };

if (require.main === module) {
  const { server, io } = createServer();
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => log("info", "listening", { port: PORT }));

  const shutdown = createShutdown({ io });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => log("error", "unhandled_rejection", { reason: String(reason) }));
  process.on("uncaughtException", (err) => {
    log("error", "uncaught_exception", { error: err.stack });
    process.exit(1);
  });
}
