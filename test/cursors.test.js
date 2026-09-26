// Remote cursors: cursor-change relay + server-assigned unique colors.
const test = require("node:test");
const assert = require("node:assert/strict");
const { io: connect } = require("socket.io-client");
const ACTIONS = require("../src/Actions");
const { createServer } = require("../server");

const ERROR_EVENT = "server-error";

async function start() {
  const ctx = createServer();
  await new Promise((resolve) => ctx.server.listen(0, resolve));
  ctx.url = `http://localhost:${ctx.server.address().port}`;
  ctx.clients = [];
  ctx.client = async () => {
    // Same options the Compile Palace frontend uses (src/socket.ts).
    const c = connect(ctx.url, { transports: ["websocket"], forceNew: true, reconnection: false });
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
  ctx.data = (socket) => ctx.io.sockets.sockets.get(socket.id).data;
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

const join = (socket, roomId, username) => {
  const joined = next(socket, ACTIONS.JOINED);
  socket.emit(ACTIONS.JOIN, { roomId, username });
  return joined;
};

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

test("CURSOR_CHANGE: relayed to same-room peers as { socketId, line, ch } (server-stamped), not echoed, not to other rooms", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    const other = await ctx.client();
    await join(a, "cur1", "alice");
    await join(b, "cur1", "bob");
    await join(other, "cur2", "eve");

    const bGot = next(b, ACTIONS.CURSOR_CHANGE);
    const aEcho = never(a, ACTIONS.CURSOR_CHANGE);
    const eveGot = never(other, ACTIONS.CURSOR_CHANGE);
    a.emit(ACTIONS.CURSOR_CHANGE, { line: 4, ch: 9 });
    assert.deepEqual(await bGot, { socketId: a.id, line: 4, ch: 9 });
    assert.ok(await aEcho, "sender must not get its own cursor back");
    assert.ok(await eveGot, "cursor must never leave its room");
    assert.deepEqual(ctx.data(a).cursor, { line: 4, ch: 9 });
  } finally {
    await ctx.stop();
  }
});

test("CURSOR_CHANGE: identity comes from the socket; client-supplied socketId/roomId/username/color are ignored", async () => {
  const ctx = await start();
  try {
    const victim = await ctx.client();
    const attacker = await ctx.client();
    const watcher = await ctx.client();
    const eve = await ctx.client();
    await join(victim, "cur-imp", "victim");
    await join(attacker, "cur-imp", "attacker");
    await join(watcher, "cur-imp", "watcher");
    await join(eve, "cur-elsewhere", "eve");

    const got = next(watcher, ACTIONS.CURSOR_CHANGE);
    const eveGot = never(eve, ACTIONS.CURSOR_CHANGE);
    attacker.emit(ACTIONS.CURSOR_CHANGE, {
      line: 1,
      ch: 2,
      socketId: victim.id,
      roomId: "cur-elsewhere",
      username: "victim",
      colorIndex: 11,
    });
    assert.deepEqual(await got, { socketId: attacker.id, line: 1, ch: 2 });
    assert.ok(await eveGot, "a client-supplied roomId must not redirect the broadcast");
    assert.equal(ctx.data(victim).cursor, undefined, "the victim's cursor must be untouched");
    assert.notEqual(ctx.data(attacker).colorIndex, 11, "color is server-assigned only");
  } finally {
    await ctx.stop();
  }
});

test("CURSOR_CHANGE: from a socket that is not in a room is rejected and not delivered", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(b, "cur-nir", "bob");
    const err = next(a, ERROR_EVENT);
    const bGot = never(b, ACTIONS.CURSOR_CHANGE);
    a.emit(ACTIONS.CURSOR_CHANGE, { line: 0, ch: 0 });
    assert.deepEqual(await err, { event: ACTIONS.CURSOR_CHANGE, code: "not_in_room" });
    assert.ok(await bGot);
  } finally {
    await ctx.stop();
  }
});

test("CURSOR_CHANGE: malformed line/ch are rejected without crashing or reaching peers", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "cur-bad", "alice");
    await join(b, "cur-bad", "bob");
    const bad = [
      { line: -1, ch: 0 },
      { line: 0, ch: -3 },
      { line: 1.5, ch: 0 },
      { line: 0, ch: NaN },
      { line: "3", ch: 0 },
      { line: 0, ch: 1000001 },
      { line: 0 },
      { ch: 0 },
      {},
      null,
      "cursor",
      42,
      { line: {}, ch: [] },
    ];
    let peerGot = false;
    b.on(ACTIONS.CURSOR_CHANGE, () => (peerGot = true));
    for (const payload of bad) {
      const err = next(a, ERROR_EVENT);
      a.emit(ACTIONS.CURSOR_CHANGE, payload);
      assert.deepEqual(await err, { event: ACTIONS.CURSOR_CHANGE, code: "invalid_payload" }, JSON.stringify(payload));
    }
    await settle();
    assert.equal(peerGot, false);
    assert.equal(ctx.data(a).cursor, undefined);
    // still alive and accepting valid input
    const ok = next(b, ACTIONS.CURSOR_CHANGE);
    a.emit(ACTIONS.CURSOR_CHANGE, { line: 0, ch: 0 });
    assert.deepEqual(await ok, { socketId: a.id, line: 0, ch: 0 });
  } finally {
    await ctx.stop();
  }
});

test("CURSOR_CHANGE rate limit is its own bucket: it does not eat the code-change budget", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "cur-rate", "alice");
    await join(b, "cur-rate", "bob");
    // 150 cursor events is more than the 60-per-window code-change limit.
    for (let i = 0; i < 150; i++) a.emit(ACTIONS.CURSOR_CHANGE, { line: i, ch: 0 });
    const got = next(b, ACTIONS.CODE_CHANGE);
    a.emit(ACTIONS.CODE_CHANGE, { roomId: "cur-rate", code: "still allowed" });
    assert.deepEqual(await got, { code: "still allowed" });
  } finally {
    await ctx.stop();
  }
});

test("CURSOR_CHANGE rate limit: a runaway cursor sender is capped and told once", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    await join(a, "cur-flood", "alice");
    await join(b, "cur-flood", "bob");
    const errors = [];
    a.on(ERROR_EVENT, (e) => errors.push(e));
    let delivered = 0;
    b.on(ACTIONS.CURSOR_CHANGE, () => delivered++);
    for (let i = 0; i < 400; i++) a.emit(ACTIONS.CURSOR_CHANGE, { line: i, ch: 0 });
    await settle(400);
    assert.equal(delivered, 200, "exactly the per-window budget is delivered");
    assert.deepEqual(errors, [{ event: ACTIONS.CURSOR_CHANGE, code: "rate_limited" }], "told exactly once");
  } finally {
    await ctx.stop();
  }
});

test("JOINED carries a distinct colorIndex per member and the last known cursor for late joiners", async () => {
  const ctx = await start();
  try {
    const socks = [];
    for (const name of ["a", "b", "c", "d"]) {
      const s = await ctx.client();
      socks.push(s);
      await join(s, "cur-col", name);
    }
    const [a, b, c] = socks;
    assert.deepEqual(socks.map((s) => ctx.data(s).colorIndex), [0, 1, 2, 3]);

    // b moves; a late joiner then sees b's cursor and everyone's distinct color.
    b.emit(ACTIONS.CURSOR_CHANGE, { line: 7, ch: 3 });
    await settle();
    const late = await ctx.client();
    const joined = await join(late, "cur-col", "late");
    const byName = Object.fromEntries(joined.clients.map((x) => [x.username, x]));
    assert.deepEqual(byName.b.cursor, { line: 7, ch: 3 });
    assert.equal(byName.a.cursor, undefined, "no cursor field until a member has reported one");
    const idx = joined.clients.map((x) => x.colorIndex);
    assert.equal(new Set(idx).size, idx.length, "all colorIndex values in a room are distinct");
    assert.equal(byName.late.colorIndex, 4);

    // c leaves: its index (2) is now the lowest free one and goes to the next joiner
    const cLeft = next(a, ACTIONS.DISCONNECTED);
    c.emit(ACTIONS.LEAVE, { roomId: "cur-col" });
    await cLeft;
    const fresh = await ctx.client();
    const j2 = await join(fresh, "cur-col", "fresh");
    assert.equal(j2.clients.find((x) => x.username === "fresh").colorIndex, 2);
  } finally {
    await ctx.stop();
  }
});

test("colorIndex: duplicate JOIN / rename keeps the same color; wraps deterministically past the palette", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    await join(a, "cur-keep", "alice");
    const before = ctx.data(a).colorIndex;
    await join(a, "cur-keep", "alice"); // duplicate
    await join(a, "cur-keep", "alice2"); // rename in the same room
    assert.equal(ctx.data(a).colorIndex, before);

    // 13 concurrent members: the first 12 get 0..11, the 13th wraps (size % 12)
    const many = [];
    for (let i = 0; i < 13; i++) {
      const s = await ctx.client();
      many.push(s);
      await join(s, "cur-many", `u${i}`);
    }
    const idx = many.map((s) => ctx.data(s).colorIndex);
    assert.deepEqual(idx.slice(0, 12), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(idx[12], 12 % 12);
  } finally {
    await ctx.stop();
  }
});

test("cursor state is cleared on leave, disconnect and room switch (a later JOINED never lists a departed cursor)", async () => {
  const ctx = await start();
  try {
    const a = await ctx.client();
    const b = await ctx.client();
    const c = await ctx.client();
    await join(a, "cur-clean", "alice");
    await join(b, "cur-clean", "bob");
    await join(c, "cur-clean", "carol");
    b.emit(ACTIONS.CURSOR_CHANGE, { line: 2, ch: 2 });
    c.emit(ACTIONS.CURSOR_CHANGE, { line: 3, ch: 3 });
    await settle();

    const bId = b.id;
    const bData = ctx.data(b);
    const bGone = next(a, ACTIONS.DISCONNECTED);
    b.emit(ACTIONS.LEAVE, { roomId: "cur-clean" });
    assert.equal((await bGone).socketId, bId);
    assert.equal(bData.cursor, undefined);
    assert.equal(bData.colorIndex, undefined);

    const cId = c.id;
    const cGone = next(a, ACTIONS.DISCONNECTED);
    c.disconnect(); // abrupt: no LEAVE
    assert.equal((await cGone).socketId, cId);

    const d = await ctx.client();
    const joined = await join(d, "cur-clean", "dave");
    assert.deepEqual(joined.clients.map((x) => x.username).sort(), ["alice", "dave"]);
    assert.ok(joined.clients.every((x) => x.socketId !== bId && x.socketId !== cId));

    // switching rooms drops the old room's cursor too
    a.emit(ACTIONS.CURSOR_CHANGE, { line: 9, ch: 9 });
    await settle();
    await join(a, "cur-elsewhere", "alice");
    assert.equal(ctx.data(a).cursor, undefined);
  } finally {
    await ctx.stop();
  }
});
