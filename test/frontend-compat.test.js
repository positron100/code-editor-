// Drives the server exactly the way the deployed Compile Palace frontend does
// (src/socket.ts, src/pages/EditorPage.tsx, src/hooks/useCollaboration.ts,
// src/services/userService.ts) to guard backward compatibility.
const test = require("node:test");
const assert = require("node:assert/strict");
const { io: connect } = require("socket.io-client");
const { createServer } = require("../server");

const JOIN = "join";
const JOINED = "joined";
const DISCONNECTED = "disconnected";
const CODE_CHANGE = "code-change";
const LEAVE = "leave";
const SYNC_REQUEST = "sync-request";
const SYNC_RESPONSE = "sync-response";

test("frontend flow: connect -> join (twice) -> code-change with author -> sync events -> leave -> disconnect", async () => {
  const { server, io } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const errors = [];

  // initSocket() options from src/socket.ts
  const make = (name) => {
    const s = connect(url, { transports: ["websocket"], timeout: 10000, reconnectionAttempts: 5, reconnectionDelay: 1000, forceNew: true });
    s.on("server-error", (e) => errors.push({ name, ...e }));
    return s;
  };
  const wait = (s, ev) => new Promise((r) => s.once(ev, r));
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  const alice = make("alice");
  const bob = make("bob");
  try {
    // EditorPage: emit JOIN inside the 'connect' handler
    await Promise.all([wait(alice, "connect"), wait(bob, "connect")]);
    const aliceJoined = wait(alice, JOINED);
    alice.emit(JOIN, { roomId: "a1b2c-3d4e5-f6a7b", username: "Alice" });
    const { clients, username, socketId } = await aliceJoined;
    assert.equal(username, "Alice");
    assert.equal(socketId, alice.id);
    assert.equal(clients.length, 1);

    const bobJoinedSeenByAlice = wait(alice, JOINED);
    bob.emit(JOIN, { roomId: "a1b2c-3d4e5-f6a7b", username: "Bob" });
    bob.emit(JOIN, { roomId: "a1b2c-3d4e5-f6a7b", username: "Bob" }); // userService.connectToRoom emits it again
    const seen = await bobJoinedSeenByAlice;
    assert.deepEqual(seen.clients.map((c) => c.username).sort(), ["Alice", "Bob"]);

    // useCollaboration: { roomId, code, author }; peers must get { code } only
    const remote = wait(bob, CODE_CHANGE);
    alice.emit(CODE_CHANGE, { roomId: "a1b2c-3d4e5-f6a7b", code: "console.log(1)", author: "Alice" });
    assert.deepEqual(await remote, { code: "console.log(1)" });

    // Events the frontend emits that the server has no handler for must be ignored, not error
    alice.emit(SYNC_REQUEST, { roomId: "a1b2c-3d4e5-f6a7b", requestor: "Alice" });
    bob.emit(SYNC_RESPONSE, { roomId: "a1b2c-3d4e5-f6a7b", code: "x", author: "Bob" });
    await settle();

    // cleanupRoomConnection: LEAVE then disconnect()
    const bobId = bob.id; // cleared by disconnect()
    const left = wait(alice, DISCONNECTED);
    bob.emit(LEAVE, { roomId: "a1b2c-3d4e5-f6a7b" });
    bob.disconnect();
    assert.deepEqual(await left, { socketId: bobId, username: "Bob" });

    assert.deepEqual(errors, [], "a normal frontend session must never trigger server-error");
  } finally {
    alice.close();
    bob.close();
    await new Promise((r) => io.close(r));
  }
});
