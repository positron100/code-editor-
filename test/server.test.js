const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { io: connect } = require("socket.io-client");
const ACTIONS = require("../src/Actions");
const { createServer, allowedOriginsFromEnv } = require("../server");

const ERROR_EVENT = "server-error";

async function start() {
  const ctx = createServer();
  await new Promise((resolve) => ctx.server.listen(0, resolve));
  ctx.url = `http://localhost:${ctx.server.address().port}`;
  ctx.clients = [];
  ctx.client = async (opts = {}) => {
    // Same options the Compile Palace frontend uses (src/socket.ts).
    const c = connect(ctx.url, { transports: ["websocket"], forceNew: true, reconnection: false, ...opts });
    ctx.clients.push(c);
    await new Promise((resolve, reject) => {
      c.once("connect", resolve);
      c.once("connect_error", reject);
    });
    return c;
  };
  ctx.stop = async () => {
    ctx.clients.forEach((c) => c.close());
    await new Promise((resolve) => ctx.io.close(resolve));
  };
  return ctx;
}

const next = (socket, event, ms = 2000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

// Resolves true if the event does NOT arrive within `ms`.
const never = (socket, event, ms = 250) =>
  new Promise((resolve) => {
    const onEvent = () => resolve(false);
    socket.once(event, onEvent);
    setTimeout(() => {
      socket.off(event, onEvent);
      resolve(true);
    }, ms);
  });

const join = async (socket, roomId, username) => {
  const joined = next(socket, ACTIONS.JOINED);
  socket.emit(ACTIONS.JOIN, { roomId, username });
  return joined;
};

const roomEntries = (ctx) => [...ctx.io.sockets.adapter.rooms.keys()].filter((k) => k.startsWith("room:"));

test("GET /health returns 200 JSON", async () => {
  const ctx = await start();
  try {
    const body = await new Promise((resolve, reject) =>
      http.get(`${ctx.url}/health`, (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
      }).on("error", reject)
    );
    assert.equal(body.status, 200);
    assert.equal(body.json.status, "ok");
  } finally {
    await ctx.stop();
  }
});

test("JOIN: every member gets JOINED with the full, correct presence list", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    const first = await join(a, "r1", "alice");
    // colorIndex is an additive field (remote-cursor colors); old consumers ignore it.
    assert.deepEqual(first.clients, [{ socketId: a.id, username: "alice", colorIndex: 0 }]);
    assert.equal(first.username, "alice");
    assert.equal(first.socketId, a.id);

    const aSees = next(a, ACTIONS.JOINED);
    const second = await join(b, "r1", "bob");
    const alsoA = await aSees;
    for (const p of [second, alsoA]) {
      assert.equal(p.username, "bob");
      assert.deepEqual(
        p.clients.map((c) => c.username).sort(),
        ["alice", "bob"]
      );
    }
  } finally {
    await ctx.stop();
  }
});

test("CODE_CHANGE: reaches same-room peers as exactly { code }, not the sender, not other rooms", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    const other = await ctx.client();
    await join(a, "r1", "alice");
    await join(b, "r1", "bob");
    await join(other, "r2", "carol");

    const got = next(b, ACTIONS.CODE_CHANGE);
    const senderEcho = never(a, ACTIONS.CODE_CHANGE);
    const leak = never(other, ACTIONS.CODE_CHANGE);
    // The frontend also sends `author`; it must be accepted and not relayed.
    a.emit(ACTIONS.CODE_CHANGE, { roomId: "r1", code: "print(1)", author: "alice" });

    assert.deepEqual(await got, { code: "print(1)" });
    assert.ok(await senderEcho, "sender must not get its own change back");
    assert.ok(await leak, "other room must not receive it");
  } finally {
    await ctx.stop();
  }
});

test("CODE_CHANGE from a socket that is not in the room is rejected and not delivered", async () => {
  const ctx = await start();
  try {
    const victim = await ctx.client();
    const attacker = await ctx.client();
    await join(victim, "r1", "alice");
    await join(attacker, "r2", "mallory");

    const delivered = never(victim, ACTIONS.CODE_CHANGE);
    const err = next(attacker, ERROR_EVENT);
    attacker.emit(ACTIONS.CODE_CHANGE, { roomId: "r1", code: "evil" });

    assert.deepEqual(await err, { event: ACTIONS.CODE_CHANGE, code: "not_in_room" });
    assert.ok(await delivered);
  } finally {
    await ctx.stop();
  }
});

test("a client-chosen roomId equal to another socket's id cannot write into that socket", async () => {
  const ctx = await start();
  try {
    const victim = await ctx.client();
    const attacker = await ctx.client();
    await join(victim, "r1", "alice");
    // Every socket sits in a private room named after its own id. Without the
    // room-name prefix, joining that "room" and broadcasting to it would
    // overwrite the victim's editor and spoof presence in a room it never joined.
    const spoofedPresence = never(victim, ACTIONS.JOINED);
    const injected = never(victim, ACTIONS.CODE_CHANGE);
    await join(attacker, victim.id, "mallory");
    attacker.emit(ACTIONS.CODE_CHANGE, { roomId: victim.id, code: "pwned" });

    assert.ok(await spoofedPresence, "victim must not see a JOINED for a room it is not in");
    assert.ok(await injected, "victim must not receive code sent to its socket-id 'room'");
  } finally {
    await ctx.stop();
  }
});

test("SYNC_CODE: relayed as CODE_CHANGE to a same-room target only; other-room targets are rejected", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    const outsider = await ctx.client();
    await join(a, "r1", "alice");
    await join(b, "r1", "bob");
    await join(outsider, "r2", "carol");

    const ok = next(b, ACTIONS.CODE_CHANGE);
    a.emit(ACTIONS.SYNC_CODE, { socketId: b.id, code: "state" });
    assert.deepEqual(await ok, { code: "state" });

    const noLeak = never(outsider, ACTIONS.CODE_CHANGE);
    const err = next(a, ERROR_EVENT);
    a.emit(ACTIONS.SYNC_CODE, { socketId: outsider.id, code: "secret" });
    assert.deepEqual(await err, { event: ACTIONS.SYNC_CODE, code: "invalid_target" });
    assert.ok(await noLeak);
  } finally {
    await ctx.stop();
  }
});

test("LEAVE and disconnect notify the room and leave no server state behind", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    const c = await ctx.client();
    await join(a, "r1", "alice");
    await join(b, "r1", "bob");
    await join(c, "r1", "carol");
    a.emit(ACTIONS.CODE_CHANGE, { roomId: "r1", code: "x" });
    await next(b, ACTIONS.CODE_CHANGE);

    const aId = a.id; // cleared by disconnect()
    const aLeft = next(b, ACTIONS.DISCONNECTED);
    a.emit(ACTIONS.LEAVE, { roomId: "r1" });
    a.disconnect(); // the frontend always disconnects right after LEAVE
    assert.deepEqual(await aLeft, { socketId: aId, username: "alice" });
    assert.ok(await never(b, ACTIONS.DISCONNECTED), "LEAVE + disconnect must notify once, not twice");

    const bLeft = next(c, ACTIONS.DISCONNECTED);
    b.disconnect(); // abrupt (tab close / network loss): no LEAVE
    assert.equal((await bLeft).username, "bob");

    c.disconnect();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(roomEntries(ctx), [], "room must be gone");
    assert.equal(ctx.snapshots.size, 0, "snapshot must be dropped when the room empties");
  } finally {
    await ctx.stop();
  }
});

test("duplicate JOIN from one socket does not duplicate presence or re-notify peers", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "r1", "alice");
    await join(b, "r1", "bob");

    const peerNotified = never(a, ACTIONS.JOINED);
    const again = await join(b, "r1", "bob");
    assert.equal(again.clients.length, 2, "presence must not duplicate");
    assert.ok(await peerNotified, "peers must not get a second JOINED");
  } finally {
    await ctx.stop();
  }
});

test("JOIN to a different room leaves the previous one", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "r1", "alice");
    await join(b, "r1", "bob");

    const left = next(a, ACTIONS.DISCONNECTED);
    const moved = await join(b, "r2", "bob");
    assert.deepEqual(await left, { socketId: b.id, username: "bob" });
    assert.deepEqual(moved.clients, [{ socketId: b.id, username: "bob", colorIndex: 0 }]);
  } finally {
    await ctx.stop();
  }
});

test("late joiner receives the room's latest code; a room that emptied starts clean", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    await join(a, "r1", "alice");
    a.emit(ACTIONS.CODE_CHANGE, { roomId: "r1", code: "v1" });
    a.emit(ACTIONS.CODE_CHANGE, { roomId: "r1", code: "v2" });
    await new Promise((r) => setTimeout(r, 100));

    const b = await ctx.client();
    const snap = next(b, ACTIONS.CODE_CHANGE);
    await join(b, "r1", "bob");
    assert.deepEqual(await snap, { code: "v2" });

    a.disconnect();
    b.disconnect();
    await new Promise((r) => setTimeout(r, 150));
    const c = await ctx.client();
    const stale = never(c, ACTIONS.CODE_CHANGE);
    await join(c, "r1", "carol");
    assert.ok(await stale, "an emptied room must not replay old code");
  } finally {
    await ctx.stop();
  }
});

test("reconnect (new socket, same user) shows one fresh presence entry, no stale one", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b1 = await ctx.client();
    await join(a, "r1", "alice");
    await join(b1, "r1", "bob");

    const gone = next(a, ACTIONS.DISCONNECTED);
    b1.disconnect();
    await gone;

    const b2 = await ctx.client();
    const joined = await join(b2, "r1", "bob");
    assert.deepEqual(
      joined.clients.map((c) => c.username).sort(),
      ["alice", "bob"]
    );
    assert.ok(joined.clients.every((c) => c.socketId !== b1.id));
  } finally {
    await ctx.stop();
  }
});

test("malformed payloads are rejected without crashing the server or affecting others", async () => {
  const ctx = await start();
  try {
    const good = await ctx.client();
    const bad = await ctx.client();
    await join(good, "r1", "alice");

    const errors = [];
    bad.on(ERROR_EVENT, (e) => errors.push(e));
    const junk = [undefined, null, 42, "str", [], {}, { roomId: 1, username: 2 }, { roomId: "", username: "x" },
      { roomId: "x".repeat(129), username: "u" }, { roomId: "r", username: "x".repeat(65) },
      { roomId: "r\u0000", username: "u" }];
    junk.forEach((p) => bad.emit(ACTIONS.JOIN, p));
    [undefined, null, 7, {}, { roomId: "r1", code: 5 }, { roomId: 5, code: "x" },
      { roomId: "r1", code: "y".repeat(400001) }].forEach((p) => bad.emit(ACTIONS.CODE_CHANGE, p));
    [null, {}, { socketId: 1, code: "x" }, { socketId: good.id, code: {} }].forEach((p) => bad.emit(ACTIONS.SYNC_CODE, p));
    bad.emit(ACTIONS.LEAVE, null);
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(errors.length >= 20, `expected rejections, got ${errors.length}`);
    assert.ok(bad.connected, "a bad client must not be disconnected by its own bad input");
    // never got into any room
    assert.deepEqual(roomEntries(ctx), ["room:r1"]);
    // the good client is unaffected
    const other = await ctx.client();
    const relayed = next(good, ACTIONS.CODE_CHANGE);
    await join(other, "r1", "bob");
    other.emit(ACTIONS.CODE_CHANGE, { roomId: "r1", code: "still works" });
    assert.deepEqual(await relayed, { code: "still works" });
  } finally {
    await ctx.stop();
  }
});

test("rate limit: a runaway sender is capped and told once", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "r1", "alice");
    await join(b, "r1", "bob");

    let delivered = 0;
    b.on(ACTIONS.CODE_CHANGE, () => delivered++);
    const errors = [];
    a.on(ERROR_EVENT, (e) => errors.push(e.code));
    for (let i = 0; i < 100; i++) a.emit(ACTIONS.CODE_CHANGE, { roomId: "r1", code: `c${i}` });
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(delivered, 60);
    assert.deepEqual(errors, ["rate_limited"]);
  } finally {
    await ctx.stop();
  }
});

test("CORS: allowed origins get the header, others do not (polling handshake)", async () => {
  const ctx = await start();
  try {
    const originHeader = (origin) =>
      new Promise((resolve, reject) =>
        http.get(`${ctx.url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: origin } }, (res) => {
          res.resume();
          resolve(res.headers["access-control-allow-origin"]);
        }).on("error", reject)
      );
    assert.equal(await originHeader("https://compile-palace.vercel.app"), "https://compile-palace.vercel.app");
    assert.equal(await originHeader("http://localhost:5173"), "http://localhost:5173");
    assert.equal(await originHeader("https://evil.example.com"), undefined);
  } finally {
    await ctx.stop();
  }
});

test("ALLOWED_ORIGINS env: additive, defaults kept, wildcard ignored", () => {
  const defaults = ["http://localhost:5173", "https://compile-palace.vercel.app"];
  assert.deepEqual(allowedOriginsFromEnv({}), defaults);
  assert.deepEqual(allowedOriginsFromEnv({ ALLOWED_ORIGINS: " https://a.example , * ,https://a.example" }), [
    ...defaults,
    "https://a.example",
  ]);
});

test("ALLOWED_ORIGINS env: trailing slash is stripped (browsers never send one in Origin)", () => {
  assert.deepEqual(allowedOriginsFromEnv({ ALLOWED_ORIGINS: "https://a.example/" }), [
    "http://localhost:5173",
    "https://compile-palace.vercel.app",
    "https://a.example",
  ]);
});

test("ALLOWED_ORIGINS: an extra origin is actually honored at the polling handshake", async () => {
  const ctx = { server: require("http").createServer() };
  const { createServer } = require("../server");
  const built = createServer({ allowedOrigins: allowedOriginsFromEnv({ ALLOWED_ORIGINS: "https://extra.example" }) });
  await new Promise((resolve) => built.server.listen(0, resolve));
  const url = `http://localhost:${built.server.address().port}`;
  try {
    const header = await new Promise((resolve, reject) =>
      http.get(`${url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: "https://extra.example" } }, (res) => {
        res.resume();
        resolve(res.headers["access-control-allow-origin"]);
      }).on("error", reject)
    );
    assert.equal(header, "https://extra.example");
  } finally {
    await new Promise((resolve) => built.io.close(resolve));
  }
});

test("CODE_CHANGE with empty string code is valid, relayed, and snapshotted (clearing the editor)", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "r1", "alice");
    await join(b, "r1", "bob");

    const got = next(b, ACTIONS.CODE_CHANGE);
    a.emit(ACTIONS.CODE_CHANGE, { roomId: "r1", code: "" });
    assert.deepEqual(await got, { code: "" });
    assert.equal(ctx.snapshots.get("room:r1"), "");

    // A late joiner must receive the empty snapshot, not be treated as "no snapshot yet".
    const c = await ctx.client();
    const snap = next(c, ACTIONS.CODE_CHANGE);
    await join(c, "r1", "carol");
    assert.deepEqual(await snap, { code: "" });
  } finally {
    await ctx.stop();
  }
});

test("clearing a non-empty document propagates each step and a rejoiner gets the empty snapshot, not old text", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "r1", "alice");
    await join(b, "r1", "bob");

    // non-empty -> "" -> non-empty -> "" : every step relayed and snapshotted.
    for (const code of ["Hello World", "", "New code", ""]) {
      const got = next(b, ACTIONS.CODE_CHANGE);
      a.emit(ACTIONS.CODE_CHANGE, { roomId: "r1", code });
      assert.deepEqual(await got, { code });
      assert.equal(ctx.snapshots.get("room:r1"), code);
    }

    // B leaves and rejoins while A keeps the room open: the snapshot exists and is "".
    const left = next(a, ACTIONS.DISCONNECTED);
    b.emit(ACTIONS.LEAVE, { roomId: "r1" });
    await left;
    const snap = next(b, ACTIONS.CODE_CHANGE);
    await join(b, "r1", "bob");
    assert.deepEqual(await snap, { code: "" });
  } finally {
    await ctx.stop();
  }
});

test("re-JOIN in the same room with a new username updates presence consistently for everyone", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "r1", "alice");
    await join(b, "r1", "bob");

    const bSeesRename = next(b, ACTIONS.JOINED);
    const renamed = await join(a, "r1", "alicia");
    const seenByB = await bSeesRename;
    for (const p of [renamed, seenByB]) {
      assert.deepEqual(
        p.clients.map((c) => c.username).sort(),
        ["alicia", "bob"]
      );
    }
  } finally {
    await ctx.stop();
  }
});

test("LEAVE from a socket that never joined is a no-op (no error, no crash, no broadcast)", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    let errored = false;
    a.on(ERROR_EVENT, () => (errored = true));
    a.emit(ACTIONS.LEAVE, { roomId: "r1" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(errored, false);
    assert.ok(a.connected);
  } finally {
    await ctx.stop();
  }
});

test("JOIN accepts spaces/unicode room ids and rejects roomId at the 129-char boundary", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const okJoined = await join(a, "team room 🚀", "alice");
    assert.equal(okJoined.clients.length, 1);

    const b = await ctx.client();
    const err = next(b, ERROR_EVENT);
    b.emit(ACTIONS.JOIN, { roomId: "x".repeat(129), username: "bob" });
    assert.deepEqual(await err, { event: ACTIONS.JOIN, code: "invalid_payload" });

    const c = await ctx.client();
    const joined128 = await join(c, "x".repeat(128), "carol");
    assert.equal(joined128.clients.length, 1);
  } finally {
    await ctx.stop();
  }
});

test("createShutdown: closes io, exits 0, and is idempotent (SIGTERM then SIGINT)", async () => {
  const { createShutdown } = require("../server");
  const ctx = await start();
  try {
    const exits = [];
    const shutdown = createShutdown({ io: ctx.io, log: () => {}, exit: (code) => exits.push(code), timeoutMs: 5000 });
    shutdown("SIGTERM");
    shutdown("SIGINT"); // must be a no-op, not a second close()/exit()
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(exits, [0]);
  } finally {
    // io is already closed by shutdown(); nothing left to stop.
  }
});

test("createShutdown: forces exit(1) if io.close never calls back", async () => {
  const { createShutdown } = require("../server");
  const exits = [];
  const hangingIo = { close: () => {} }; // never invokes its callback
  const shutdown = createShutdown({ io: hangingIo, log: () => {}, exit: (code) => exits.push(code), timeoutMs: 30 });
  shutdown("SIGTERM");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(exits, [1]);
});

test("two users may share a display name: two presence entries; renaming one leaves the other's untouched", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "r-name", "Same Name");
    const joinedB = await join(b, "r-name", "Same Name");
    assert.equal(joinedB.clients.length, 2);
    assert.deepEqual(joinedB.clients.map((c) => c.username), ["Same Name", "Same Name"]);
    assert.notEqual(joinedB.clients[0].socketId, joinedB.clients[1].socketId);

    const renamed = next(a, ACTIONS.JOINED);
    b.emit(ACTIONS.JOIN, { roomId: "r-name", username: "Test User" });
    const payload = await renamed;
    const byId = Object.fromEntries(payload.clients.map((c) => [c.socketId, c.username]));
    assert.equal(payload.clients.length, 2);
    assert.equal(byId[a.id], "Same Name");
    assert.equal(byId[b.id], "Test User");
  } finally {
    await ctx.stop();
  }
});

test("CODE_CHANGE relays multi-line code byte-for-byte (LF, CRLF, tabs, blank lines, trailing newline, unicode)", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "r-ml", "A");
    await join(b, "r-ml", "B");
    const docs = ["line 1\n\nline 2\nline 3", "a\r\nb\r\n", "\tindented\n  two spaces\n", "trailing\n", "\n\n", "unicode \u2713 \u00e9\nnext"];
    for (const code of docs) {
      const got = next(b, ACTIONS.CODE_CHANGE);
      a.emit(ACTIONS.CODE_CHANGE, { roomId: "r-ml", code });
      assert.deepEqual(await got, { code });
      assert.equal(ctx.snapshots.get("room:r-ml"), code);
    }
  } finally {
    await ctx.stop();
  }
});

test("a joiner that has not sent code-change never overwrites the room snapshot or the members' documents", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "r-join", "A");
    await join(b, "r-join", "B");
    const seen = next(b, ACTIONS.CODE_CHANGE);
    a.emit(ACTIONS.CODE_CHANGE, { roomId: "r-join", code: "DOC\nsecond line" });
    await seen;

    const c = await ctx.client();
    const aQuiet = never(a, ACTIONS.CODE_CHANGE, 400);
    const bQuiet = never(b, ACTIONS.CODE_CHANGE, 400);
    const replay = next(c, ACTIONS.CODE_CHANGE);
    await join(c, "r-join", "C");
    // C receives the current document; nobody else receives anything on C's behalf.
    assert.deepEqual(await replay, { code: "DOC\nsecond line" });
    assert.equal(await aQuiet, true);
    assert.equal(await bQuiet, true);
    assert.equal(ctx.snapshots.get("room:r-join"), "DOC\nsecond line");
  } finally {
    await ctx.stop();
  }
});

test("a member leaving or disconnecting does not corrupt the snapshot while others remain; it is dropped only when the room empties", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    const c = await ctx.client();
    for (const [s, n] of [[a, "A"], [b, "B"], [c, "C"]]) await join(s, "r-leave", n);
    const seen = next(b, ACTIONS.CODE_CHANGE);
    a.emit(ACTIONS.CODE_CHANGE, { roomId: "r-leave", code: "KEEP ME" });
    await seen;

    const gone1 = next(a, ACTIONS.DISCONNECTED);
    c.close(); // abrupt: tab closed
    await gone1;
    assert.equal(ctx.snapshots.get("room:r-leave"), "KEEP ME");

    const gone2 = next(a, ACTIONS.DISCONNECTED);
    b.emit(ACTIONS.LEAVE, { roomId: "r-leave" }); // explicit leave
    await gone2;
    assert.equal(ctx.snapshots.get("room:r-leave"), "KEEP ME");

    const d = await ctx.client();
    const replay = next(d, ACTIONS.CODE_CHANGE);
    await join(d, "r-leave", "D");
    assert.deepEqual(await replay, { code: "KEEP ME" });

    a.close();
    d.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ctx.snapshots.has("room:r-leave"), false);
    assert.deepEqual(roomEntries(ctx), []);
  } finally {
    await ctx.stop();
  }
});
