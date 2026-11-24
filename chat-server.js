const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const AVATAR_COLORS = ["#635BFF", "#0EA5A4", "#E85D9E", "#F59E0B", "#3B82F6", "#8B5CF6"];
const MAX_MESSAGE_LENGTH = 1000;

function cleanText(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maxLength)
    : "";
}

function makeRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function startChatServer(port = Number(process.env.PORT) || 3000) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  const rooms = new Map();

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/health", (req, res) => res.json({ ok: true, rooms: rooms.size }));

  rooms.set("lobby", {
    id: "lobby",
    name: "Campus Lobby",
    description: "The common room for introductions, questions, and campus conversations.",
    isPrivate: false,
    code: "PUBLIC",
    createdBy: "system",
    createdAt: Date.now(),
    members: new Map(),
    messages: []
  });

  function roomSummary(room, userId) {
    const membership = room.members.get(userId);
    return {
      id: room.id,
      name: room.name,
      description: room.description,
      isPrivate: room.isPrivate,
      code: room.code,
      createdBy: room.createdBy,
      createdAt: room.createdAt,
      memberCount: [...room.members.values()].filter((member) => member.sockets.size > 0).length,
      joined: Boolean(membership),
      mine: room.createdBy === userId || Boolean(membership)
    };
  }

  function visibleRooms(userId) {
    return [...rooms.values()]
      .filter((room) => !room.isPrivate || room.createdBy === userId || room.members.has(userId))
      .map((room) => roomSummary(room, userId));
  }

  function roomDetails(room) {
    return {
      id: room.id,
      name: room.name,
      description: room.description,
      isPrivate: room.isPrivate,
      code: room.code,
      createdBy: room.createdBy,
      createdAt: room.createdAt,
      memberCount: [...room.members.values()].filter((member) => member.sockets.size > 0).length,
      members: [...room.members.values()]
        .filter((member) => member.sockets.size > 0)
        .map((member) => ({
          id: member.profile.id,
          name: member.profile.name,
          color: member.profile.color,
          joinedAt: member.joinedAt,
          isOwner: member.profile.id === room.createdBy
        }))
    };
  }

  function snapshotFor(room, userId, includeMessages = false) {
    return {
      ...roomSummary(room, userId),
      ...roomDetails(room),
      ...(includeMessages ? { messages: room.messages } : {})
    };
  }

  function broadcastRoomLists() {
    for (const socket of io.sockets.sockets.values()) {
      socket.emit("room:list", visibleRooms(socket.data.profile.id));
    }
  }

  function broadcastRoomState(room) {
    io.to(room.id).emit("room:state", { room: roomDetails(room) });
    broadcastRoomLists();
  }

  function joinRoom(socket, room, suppliedCode = "") {
    const user = socket.data.profile;
    const membership = room.members.get(user.id);

    if (room.isPrivate && !membership && room.createdBy !== user.id) {
      if (cleanText(suppliedCode, 16).toUpperCase() !== room.code) {
        return { ok: false, error: "That invite code is not valid for this room." };
      }
    }

    if (!membership) {
      room.members.set(user.id, {
        profile: { ...user },
        sockets: new Set(),
        joinedAt: Date.now()
      });
    } else {
      membership.profile = { ...user };
    }

    room.members.get(user.id).sockets.add(socket.id);
    if (!socket.data.rooms) socket.data.rooms = new Set();
    socket.data.rooms.add(room.id);
    socket.join(room.id);
    broadcastRoomState(room);
    socket.emit("room:list", visibleRooms(user.id));

    return { ok: true, room: snapshotFor(room, user.id, true) };
  }

  function leaveRoom(socket, room, forget = false) {
    const userId = socket.data.profile.id;
    const membership = room.members.get(userId);
    if (!membership) return;

    membership.sockets.delete(socket.id);
    socket.leave(room.id);
    socket.data.rooms.delete(room.id);
    if (membership.sockets.size === 0 && forget) room.members.delete(userId);
    broadcastRoomState(room);
    socket.emit("room:list", visibleRooms(userId));
  }

  io.on("connection", (socket) => {
    const authProfile = socket.handshake.auth.profile || {};
    const id = cleanText(authProfile.id, 80) || crypto.randomUUID();
    const name = cleanText(authProfile.name, 24) || `Guest ${id.slice(0, 4).toUpperCase()}`;
    const color = /^#[0-9a-f]{6}$/i.test(authProfile.color)
      ? authProfile.color
      : AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

    socket.data.profile = { id, name, color };
    socket.data.rooms = new Set();
    socket.emit("room:list", visibleRooms(id));
    console.log(`Connected: ${name} · ${io.engine.clientsCount} online`);

    socket.on("profile:update", (input, callback) => {
      if (typeof callback !== "function") return;
      const updatedName = cleanText(input && input.name, 24);
      if (updatedName.length < 2) {
        return callback({ ok: false, error: "Your display name needs at least 2 characters." });
      }
      const updatedColor = /^#[0-9a-f]{6}$/i.test(input && input.color)
        ? input.color
        : socket.data.profile.color;
      socket.data.profile = { id, name: updatedName, color: updatedColor };

      for (const roomId of socket.data.rooms) {
        const room = rooms.get(roomId);
        const membership = room && room.members.get(id);
        if (membership) membership.profile = { ...socket.data.profile };
        if (room) broadcastRoomState(room);
      }
      callback({ ok: true, profile: socket.data.profile });
    });

    socket.on("room:create", (input, callback) => {
      if (typeof callback !== "function") return;
      const roomName = cleanText(input && input.name, 48);
      if (roomName.length < 3) {
        return callback({ ok: false, error: "Room names need at least 3 characters." });
      }

      let code = makeRoomCode();
      while ([...rooms.values()].some((room) => room.code === code)) code = makeRoomCode();
      const room = {
        id: crypto.randomUUID(),
        name: roomName,
        description: cleanText(input && input.description, 140) || "A personal space for your group.",
        isPrivate: input && input.isPrivate !== false,
        code,
        createdBy: id,
        createdAt: Date.now(),
        members: new Map(),
        messages: []
      };
      rooms.set(room.id, room);
      console.log(`Room created: ${room.name} (${room.isPrivate ? "private" : "public"})`);
      const result = joinRoom(socket, room);
      callback({ ok: result.ok, roomId: room.id, room: result.room, error: result.error });
    });

    socket.on("room:join", (input, callback) => {
      if (typeof callback !== "function") return;
      const code = cleanText(input && input.code, 16).toUpperCase();
      const roomId = cleanText(input && input.roomId, 80);
      const room = code
        ? [...rooms.values()].find((candidate) => candidate.code === code)
        : rooms.get(roomId);

      if (!room) {
        return callback({ ok: false, error: code ? "No room was found with that invite code." : "That room no longer exists." });
      }
      const result = joinRoom(socket, room, code);
      callback(result);
    });

    socket.on("room:leave", (input, callback) => {
      if (typeof callback !== "function") return;
      const room = rooms.get(cleanText(input && input.roomId, 80));
      if (!room || !socket.data.rooms.has(room.id)) {
        return callback({ ok: false, error: "You are not in that room." });
      }
      if (room.id === "lobby") {
        return callback({ ok: false, error: "The Campus Lobby is always available." });
      }
      leaveRoom(socket, room, true);
      callback({ ok: true });
    });

    socket.on("chat:message", (input, callback) => {
      if (typeof callback !== "function") return;
      const room = rooms.get(cleanText(input && input.roomId, 80));
      if (!room || !room.members.has(id)) {
        return callback({ ok: false, error: "Join this room before sending a message." });
      }
      const text = input && typeof input.text === "string" ? input.text.trim() : "";
      if (!text) return callback({ ok: false, error: "Write a message first." });
      if (text.length > MAX_MESSAGE_LENGTH) {
        return callback({ ok: false, error: `Messages can be up to ${MAX_MESSAGE_LENGTH} characters.` });
      }

      const clientId = cleanText(input.clientId, 80);
      const existing = clientId && room.messages.find((message) => message.clientId === clientId);
      if (existing) return callback({ ok: true, message: existing });

      const message = {
        id: crypto.randomUUID(),
        clientId: clientId || null,
        roomId: room.id,
        senderId: id,
        senderName: socket.data.profile.name,
        senderColor: socket.data.profile.color,
        text,
        createdAt: Date.now()
      };
      room.messages.push(message);
      if (room.messages.length > 200) room.messages.shift();
      io.to(room.id).emit("chat:message", message);
      callback({ ok: true, message });
    });

    socket.on("chat:typing", (input) => {
      const room = rooms.get(cleanText(input && input.roomId, 80));
      if (!room || !room.members.has(id)) return;
      socket.to(room.id).emit("chat:typing", {
        roomId: room.id,
        userId: id,
        name: socket.data.profile.name,
        isTyping: Boolean(input.isTyping)
      });
    });

    socket.on("disconnect", () => {
      for (const roomId of [...socket.data.rooms]) {
        const room = rooms.get(roomId);
        if (room) leaveRoom(socket, room);
      }
      console.log(`Disconnected: ${name} · ${io.engine.clientsCount} online`);
    });
  });

  httpServer.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Set the PORT environment variable to another port and run npm start again.`);
    } else {
      console.error(`CampusChat could not start: ${error.message}`);
    }
    process.exitCode = 1;
  });

  httpServer.listen(port, () => {
    const activePort = httpServer.address().port;
    console.log(`CampusChat is running at http://localhost:${activePort}`);
  });

  return { app, httpServer, io, rooms };
}

if (require.main === module) startChatServer();

module.exports = { startChatServer };
