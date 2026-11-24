const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const memoryStorage = new Map();
global.localStorage = {
  getItem: (key) => memoryStorage.get(key) || null,
  setItem: (key, value) => memoryStorage.set(key, value),
  removeItem: (key) => memoryStorage.delete(key)
};

const { startChatServer } = require("../chat-server");
const io = require("../node_modules/socket.io/client-dist/socket.io.js");

let server;
let baseUrl;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  server = startChatServer(0);
  if (!server.httpServer.listening) await once(server.httpServer, "listening");
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.io.close(resolve));
});

async function connect(profile) {
  const socket = io(baseUrl, {
    auth: { profile },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true
  });
  socket.visibleRooms = [];
  socket.on("room:list", (rooms) => { socket.visibleRooms = rooms; });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

function ack(socket, event, data) {
  return new Promise((resolve, reject) => {
    socket.timeout(4000).emit(event, data, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function waitUntil(predicate, label) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test("CampusChat integration", async (t) => {
  await t.test("serves the frontend and health endpoint", async () => {
    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.ok(health.rooms >= 1);
    const page = await fetch(baseUrl).then((response) => response.text());
    assert.match(page, /CampusChat/);
    assert.match(page, /\/app\.js/);
  });

  await t.test("enforces private-room access and message validation", async (t) => {
    const sockets = [];
    t.after(() => sockets.forEach((socket) => socket.disconnect()));
    const owner = await connect({ id: "test-owner", name: "Test Owner", color: "#635BFF" });
    const outsider = await connect({ id: "test-outsider", name: "Test Outsider", color: "#3B82F6" });
    const member = await connect({ id: "test-member", name: "Test Member", color: "#E85D9E" });
    sockets.push(owner, outsider, member);

    const created = await ack(owner, "room:create", {
      name: "Private Test Room",
      description: "Automated integration test",
      isPrivate: true
    });
    assert.equal(created.ok, true, created.error);
    assert.match(created.room.code, /^[A-F0-9]{6}$/);
    await waitUntil(() => outsider.visibleRooms.length > 0, "outsider room list");
    assert.equal(outsider.visibleRooms.some((room) => room.id === created.roomId), false);

    assert.equal((await ack(outsider, "room:join", { code: "ZZZZZZ" })).ok, false);
    assert.equal((await ack(outsider, "chat:message", { roomId: created.roomId, text: "Blocked" })).ok, false);

    const joined = await ack(member, "room:join", { code: created.room.code });
    assert.equal(joined.ok, true, joined.error);
    assert.equal(joined.room.members.length, 2);

    const received = once(member, "chat:message");
    const sent = await ack(owner, "chat:message", {
      roomId: created.roomId,
      text: "Hello from the owner",
      clientId: "test-client-message"
    });
    assert.equal(sent.ok, true, sent.error);
    const [message] = await received;
    assert.equal(message.text, "Hello from the owner");

    const duplicate = await ack(owner, "chat:message", {
      roomId: created.roomId,
      text: "Duplicate",
      clientId: "test-client-message"
    });
    assert.equal(duplicate.message.id, sent.message.id);
    assert.equal((await ack(owner, "chat:message", { roomId: created.roomId, text: "   " })).ok, false);
    assert.equal((await ack(owner, "chat:message", { roomId: created.roomId, text: "x".repeat(1001) })).ok, false);

    member.disconnect();
    await delay(100);
    const reconnected = await connect({ id: "test-member", name: "Test Member", color: "#E85D9E" });
    sockets.push(reconnected);
    await waitUntil(() => reconnected.visibleRooms.some((room) => room.id === created.roomId), "private room after reconnect");
    const rejoined = await ack(reconnected, "room:join", { roomId: created.roomId });
    assert.equal(rejoined.ok, true, rejoined.error);
    assert.equal(rejoined.room.messages.some((item) => item.text === "Hello from the owner"), true);

    const left = await ack(reconnected, "room:leave", { roomId: created.roomId });
    assert.equal(left.ok, true, left.error);
    await waitUntil(() => !reconnected.visibleRooms.some((room) => room.id === created.roomId), "room list after leaving");
  });

  await t.test("publishes new public rooms and isolates messages by room", async (t) => {
    const sockets = [];
    t.after(() => sockets.forEach((socket) => socket.disconnect()));
    const owner = await connect({ id: "public-owner", name: "Public Owner", color: "#0EA5A4" });
    const guest = await connect({ id: "public-guest", name: "Public Guest", color: "#F59E0B" });
    const outsider = await connect({ id: "public-outsider", name: "Public Outsider", color: "#3B82F6" });
    sockets.push(owner, guest, outsider);

    const created = await ack(owner, "room:create", {
      name: "Public Test Room",
      description: "Visible to everyone",
      isPrivate: false
    });
    assert.equal(created.ok, true, created.error);
    await waitUntil(() => guest.visibleRooms.some((room) => room.id === created.roomId), "public room discovery");
    assert.equal((await ack(guest, "room:join", { roomId: created.roomId })).ok, true);

    let receivedOutsideRoom = false;
    outsider.on("chat:message", () => { receivedOutsideRoom = true; });
    await ack(guest, "chat:message", { roomId: created.roomId, text: "Public hello" });
    await delay(100);
    assert.equal(receivedOutsideRoom, false);
  });

  await t.test("broadcasts typing state only inside the active room", async (t) => {
    const sockets = [];
    t.after(() => sockets.forEach((socket) => socket.disconnect()));
    const first = await connect({ id: "typing-first", name: "Typing First", color: "#8B5CF6" });
    const second = await connect({ id: "typing-second", name: "Typing Second", color: "#E85D9E" });
    sockets.push(first, second);
    const created = await ack(first, "room:create", { name: "Typing Test Room", isPrivate: true });
    await ack(second, "room:join", { code: created.room.code });

    const typing = once(first, "chat:typing");
    second.emit("chat:typing", { roomId: created.roomId, isTyping: true });
    const [event] = await typing;
    assert.equal(event.userId, "typing-second");
    assert.equal(event.isTyping, true);
  });
});
