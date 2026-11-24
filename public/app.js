const $ = (id) => document.getElementById(id);
const COLORS = ["#635BFF", "#0EA5A4", "#E85D9E", "#F59E0B", "#3B82F6", "#8B5CF6"];
const THEMES = [
  { id: "violet", label: "Violet" },
  { id: "ocean", label: "Ocean" },
  { id: "sunset", label: "Sunset" },
  { id: "forest", label: "Forest" }
];
const PROFILE_KEY = "campuschat.profile";
const ACTIVE_ROOM_KEY = "campuschat.activeRoom";
const THEME_KEY = "campuschat.theme";

const state = {
  profile: readProfile(),
  selectedColor: COLORS[0],
  theme: readTheme(),
  socket: null,
  connected: false,
  connecting: false,
  hasConnected: false,
  rooms: [],
  activeRoomId: null,
  room: null,
  filter: "all",
  search: "",
  joinSequence: 0,
  renderedMessageIds: new Set(),
  pendingMessages: new Map(),
  typingUsers: new Map()
};

function readProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_KEY));
    if (profile && typeof profile.id === "string" && typeof profile.name === "string") {
      return {
        id: profile.id,
        name: profile.name,
        color: /^#[0-9a-f]{6}$/i.test(profile.color) ? profile.color : COLORS[0]
      };
    }
  } catch {}
  return null;
}

function readTheme() {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    return THEMES.some((item) => item.id === theme) ? theme : "violet";
  } catch {
    return "violet";
  }
}

function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

function icon(name) {
  return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function dateKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dateKey(date) === dateKey(today)) return "Today";
  if (dateKey(date) === dateKey(yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined }).format(date);
}

function setAvatar(element, profile) {
  element.textContent = initials(profile.name);
  element.style.background = profile.color;
}

function toast(message, type = "info") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.innerHTML = icon(type === "error" ? "info" : "check");
  const text = document.createElement("span");
  text.textContent = message;
  element.append(text);
  $("toastRegion").append(element);
  setTimeout(() => {
    element.classList.add("leaving");
    setTimeout(() => element.remove(), 200);
  }, 3500);
}

function emitWithAck(event, data) {
  return new Promise((resolve) => {
    if (!state.socket || !state.connected) {
      resolve({ error: "You are offline. Wait for the connection to return." });
      return;
    }
    state.socket.timeout(6000).emit(event, data, (error, response) => {
      resolve({ error: error ? "The server took too long to respond. Please try again." : null, response });
    });
  });
}

function updateStatus() {
  const profile = state.profile;
  $("sidebarName").textContent = profile ? profile.name : "Guest";
  if (profile) setAvatar($("sidebarAvatar"), profile);
  const status = $("sidebarStatus");
  status.innerHTML = `<i class="${state.connected ? "online" : state.connecting ? "" : "offline"}"></i>${state.connected ? "Online" : state.connecting ? "Connecting…" : "Reconnecting…"}`;
  document.querySelector(".online-dot").classList.toggle("offline", !state.connected);
  $("connectionBanner").hidden = !state.socket || state.connected;
  $("connectionText").textContent = state.hasConnected ? "Connection lost. Reconnecting to CampusChat…" : "Connecting to CampusChat…";
  updateComposer();
}

function updateComposer() {
  const disabled = !state.connected || !state.activeRoomId;
  $("messageInput").disabled = disabled;
  $("sendButton").disabled = disabled || !$("messageInput").value.trim();
}

function filteredRooms() {
  const query = state.search.toLowerCase();
  return state.rooms.filter((room) => {
    const matchesFilter = state.filter === "all" || room.mine || room.joined || room.id === "lobby";
    const matchesSearch = !query || `${room.name} ${room.description} ${room.code}`.toLowerCase().includes(query);
    return matchesFilter && matchesSearch;
  });
}

function renderSidebar() {
  const rooms = filteredRooms();
  $("roomCount").textContent = rooms.length;
  if (!state.rooms.length && state.connected) {
    $("roomList").innerHTML = '<div class="room-empty">No rooms yet.<br>Create one to get started.</div>';
    return;
  }
  if (!rooms.length) {
    $("roomList").innerHTML = `<div class="room-empty">No ${state.search ? "matching " : ""}rooms found.</div>`;
    return;
  }
  $("roomList").innerHTML = rooms.map((room) => {
    const active = room.id === state.activeRoomId;
    const detail = room.isPrivate ? "Private room" : `${room.memberCount} online`;
    return `<button class="room-item${active ? " active" : ""}" data-room-id="${escapeHtml(room.id)}" ${active ? 'aria-current="page"' : ""}>
      <span class="room-item-icon${room.isPrivate ? " private" : ""}">${icon(room.isPrivate ? "lock" : "hash")}</span>
      <span class="room-item-copy"><strong>${escapeHtml(room.name)}</strong><small>${room.isPrivate ? icon("lock") : "<i></i>"}${escapeHtml(detail)}</small></span>
      <span class="room-item-count">${room.memberCount}</span>
    </button>`;
  }).join("");
}

function renderHeader() {
  const room = state.room;
  $("roomAvatar").innerHTML = icon(room && room.isPrivate ? "lock" : "hash");
  $("roomAvatar").classList.toggle("private", Boolean(room && room.isPrivate));
  $("roomName").textContent = room ? room.name : "Campus Lobby";
  $("roomDescription").textContent = room ? room.description : state.connected ? "Choose a room to start talking." : "Connecting to your campus…";
  $("roomCodeBadge").hidden = !room || !room.isPrivate;
  $("roomCode").textContent = room ? room.code : "";
  $("headerMemberCount").textContent = room ? room.memberCount : 0;
  $("membersSubtitle").textContent = `${room ? room.memberCount : 0} online`;
}

function renderMembers() {
  const room = state.room;
  const members = room ? room.members : [];
  $("memberList").innerHTML = members.length ? members.map((member) => {
    const isSelf = state.profile && member.id === state.profile.id;
    return `<div class="member-item">
      <span class="avatar" style="background:${escapeHtml(member.color)}">${escapeHtml(initials(member.name))}</span>
      <span class="member-copy"><strong>${escapeHtml(member.name)}${isSelf ? " (You)" : ""}${member.isOwner ? '<span class="owner-badge">Owner</span>' : ""}</strong><small>Online now</small></span>
      <span class="member-status"></span>
    </div>`;
  }).join("") : '<div class="room-empty">No one else is here yet.<br>Invite someone to start the conversation.</div>';

  $("roomInfoDescription").textContent = room ? room.description : "";
  $("roomCreated").textContent = room ? formatDate(room.createdAt) : "—";
  $("roomAccess").textContent = room && room.isPrivate ? "Invite only" : "Public";
  $("copyCodeButton").hidden = !room || !room.isPrivate;
  $("infoRoomCode").textContent = room ? room.code : "";
  $("leaveRoomButton").hidden = !room || room.id === "lobby";
}

function welcomeMarkup(room) {
  const privateRoom = room.isPrivate;
  return `<div class="room-welcome">
    <div class="welcome-icon${privateRoom ? " private" : ""}">${icon(privateRoom ? "lock" : "hash")}</div>
    <h2>Welcome to ${escapeHtml(room.name)}</h2>
    <p>${privateRoom ? "This is your private corner of CampusChat. Share the invite code with your group and make yourself at home." : "Say hello, ask a question, or start a campus conversation. Everyone is welcome here."}</p>
    ${privateRoom ? `<button class="welcome-code" data-copy-code="${escapeHtml(room.code)}">${icon("copy")}<span>Invite code</span><strong>${escapeHtml(room.code)}</strong></button>` : `<div class="starter-prompts"><button data-prompt="Hi everyone!">Say hello</button><button data-prompt="Anyone want to form a study group?">Find a study group</button><button data-prompt="I have a question about the Web Dev assignment.">Ask a question</button></div>`}
  </div>`;
}

function createMessageRow(message, compact = false) {
  const row = document.createElement("div");
  const own = state.profile && message.senderId === state.profile.id;
  row.className = `message-row${own ? " own" : ""}${compact ? " compact" : ""}${message.id.startsWith("temp-") ? " pending" : ""}`;
  row.dataset.messageId = message.id;
  if (message.clientId) row.dataset.clientId = message.clientId;
  row.dataset.date = dateKey(message.createdAt);
  row.innerHTML = `<span class="message-avatar" style="background:${escapeHtml(message.senderColor)}">${escapeHtml(initials(message.senderName))}</span>
    <div class="message-content">${compact ? "" : `<div class="message-meta"><strong>${escapeHtml(message.senderName)}</strong><time>${formatTime(message.createdAt)}</time></div>`}<div class="message-bubble">${escapeHtml(message.text)}</div></div>`;
  return row;
}

function renderMessages() {
  const room = state.room;
  const list = $("messageList");
  list.replaceChildren();
  state.renderedMessageIds.clear();
  if (!room) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon("chat")}</div><h2>Pick a conversation</h2><p>Choose a room from the sidebar to start chatting.</p></div>`;
    return;
  }
  if (!room.messages.length) {
    list.innerHTML = welcomeMarkup(room);
    return;
  }

  const fragment = document.createDocumentFragment();
  let previous = null;
  let previousDate = null;
  for (const message of room.messages) {
    const currentDate = dateKey(message.createdAt);
    if (currentDate !== previousDate) {
      const divider = document.createElement("div");
      divider.className = "date-divider";
      divider.textContent = formatDate(message.createdAt);
      fragment.append(divider);
    }
    const compact = previous && previous.senderId === message.senderId && currentDate === previousDate && message.createdAt - previous.createdAt < 300000;
    fragment.append(createMessageRow(message, compact));
    state.renderedMessageIds.add(message.id);
    previous = message;
    previousDate = currentDate;
  }
  list.append(fragment);
}

function renderTyping() {
  const users = [...state.typingUsers.values()];
  $("typingIndicator").hidden = users.length === 0;
  if (!users.length) return;
  const names = users.map((user) => user.name);
  $("typingText").textContent = names.length === 1
    ? `${names[0]} is typing…`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are typing…`
      : `${names[0]} and ${names.length - 1} others are typing…`;
}

function renderRoom() {
  renderSidebar();
  renderHeader();
  renderMembers();
  renderMessages();
  renderTyping();
  updateComposer();
  requestAnimationFrame(() => scrollToBottom(false));
}

function isNearBottom() {
  const list = $("messageList");
  return list.scrollHeight - list.scrollTop - list.clientHeight < 120;
}

function scrollToBottom(animate = true) {
  const list = $("messageList");
  list.scrollTo({ top: list.scrollHeight, behavior: animate ? "smooth" : "auto" });
  $("newMessagesButton").hidden = true;
}

function appendMessage(message) {
  if (state.renderedMessageIds.has(message.id)) return;
  const room = state.room;
  if (!room) return;
  const nearBottom = isNearBottom();
  const rows = $("messageList").querySelectorAll(".message-row");
  const previousRow = rows[rows.length - 1];
  const previousMessage = previousRow ? room.messages.find((item) => item.id === previousRow.dataset.messageId) : null;
  const currentDate = dateKey(message.createdAt);
  if (!previousRow || previousRow.dataset.date !== currentDate) {
    const welcome = $("messageList").querySelector(".room-welcome");
    if (welcome) welcome.remove();
    const divider = document.createElement("div");
    divider.className = "date-divider";
    divider.textContent = formatDate(message.createdAt);
    $("messageList").append(divider);
  }
  const compact = previousMessage && previousMessage.senderId === message.senderId && currentDate === dateKey(previousMessage.createdAt) && message.createdAt - previousMessage.createdAt < 300000;
  $("messageList").append(createMessageRow(message, compact));
  room.messages.push(message);
  if (room.messages.length > 200) room.messages.shift();
  state.renderedMessageIds.add(message.id);
  if (nearBottom || (state.profile && message.senderId === state.profile.id)) scrollToBottom();
  else $("newMessagesButton").hidden = false;
}

function activateRoom(room) {
  state.activeRoomId = room.id;
  state.room = room;
  try { localStorage.setItem(ACTIVE_ROOM_KEY, room.id); } catch {}
  state.typingUsers.clear();
  $("messageInput").value = "";
  updateCharacterCount();
  closeSidebar();
  renderRoom();
}

async function requestJoin(roomId) {
  if (!state.connected) return;
  const sequence = ++state.joinSequence;
  const { error, response } = await emitWithAck("room:join", { roomId });
  if (sequence !== state.joinSequence) return;
  if (error || !response || !response.ok) {
    toast(error || (response && response.error) || "Could not join that room.", "error");
    return;
  }
  activateRoom(response.room);
}

function connect() {
  if (!state.profile) {
    openProfileModal();
    return;
  }
  if (state.socket) return;
  state.connecting = true;
  updateStatus();
  const socket = io({ auth: { profile: state.profile }, reconnection: true, reconnectionDelay: 800 });
  state.socket = socket;

  socket.on("connect", () => {
    state.connected = true;
    state.connecting = false;
    state.hasConnected = true;
    updateStatus();
    let roomId = "lobby";
    try { roomId = localStorage.getItem(ACTIVE_ROOM_KEY) || roomId; } catch {}
    requestJoin(roomId);
  });

  socket.on("disconnect", () => {
    state.connected = false;
    state.typingUsers.clear();
    renderTyping();
    updateStatus();
  });

  socket.on("connect_error", () => {
    state.connecting = false;
    updateStatus();
  });

  socket.on("room:list", (rooms) => {
    state.rooms = rooms;
    renderSidebar();
  });

  socket.on("room:state", ({ room }) => {
    const summary = state.rooms.find((item) => item.id === room.id);
    if (summary) Object.assign(summary, room);
    if (state.activeRoomId === room.id && state.room) state.room = { ...state.room, ...room };
    renderSidebar();
    renderHeader();
    renderMembers();
  });

  socket.on("chat:message", (message) => {
    if (!state.room || message.roomId !== state.room.id) return;
    const pending = message.clientId && state.pendingMessages.get(message.clientId);
    if (pending) {
      if (pending.element.isConnected) {
        const compact = pending.element.classList.contains("compact");
        const confirmed = createMessageRow(message, compact);
        pending.element.replaceWith(confirmed);
        state.renderedMessageIds.delete(pending.tempId);
        state.renderedMessageIds.add(message.id);
      }
      state.pendingMessages.delete(message.clientId);
      const tempIndex = state.room.messages.findIndex((item) => item.id === pending.tempId);
      if (tempIndex >= 0) state.room.messages.splice(tempIndex, 1, message);
      else if (!state.room.messages.some((item) => item.id === message.id)) state.room.messages.push(message);
      return;
    }
    appendMessage(message);
  });

  socket.on("chat:typing", ({ roomId, userId, name, isTyping }) => {
    if (roomId !== state.activeRoomId || (state.profile && userId === state.profile.id)) return;
    const existing = state.typingUsers.get(userId);
    if (existing) clearTimeout(existing.timer);
    if (!isTyping) {
      state.typingUsers.delete(userId);
    } else {
      const timer = setTimeout(() => {
        state.typingUsers.delete(userId);
        renderTyping();
      }, 4500);
      state.typingUsers.set(userId, { name, timer });
    }
    renderTyping();
  });
}

function updateCharacterCount() {
  const length = $("messageInput").value.length;
  $("characterCount").textContent = `${length} / 1000`;
  $("characterCount").classList.toggle("warning", length > 900);
  $("messageInput").style.height = "auto";
  $("messageInput").style.height = `${Math.min($("messageInput").scrollHeight, 120)}px`;
  updateComposer();
}

function stopTyping() {
  clearTimeout(state.typingTimer);
  if (state.socket && state.connected && state.activeRoomId) {
    state.socket.emit("chat:typing", { roomId: state.activeRoomId, isTyping: false });
  }
}

async function sendMessage() {
  const input = $("messageInput");
  const text = input.value.trim();
  if (!text || !state.connected || !state.room) return;
  const clientId = createId();
  const tempId = `temp-${clientId}`;
  const message = {
    id: tempId,
    clientId,
    roomId: state.room.id,
    senderId: state.profile.id,
    senderName: state.profile.name,
    senderColor: state.profile.color,
    text,
    createdAt: Date.now()
  };
  appendMessage(message);
  const pending = { tempId, roomId: state.room.id, element: $("messageList").querySelector(`[data-message-id="${tempId}"]`) };
  state.pendingMessages.set(clientId, pending);
  input.value = "";
  updateCharacterCount();
  stopTyping();
  input.focus();

  const { error, response } = await emitWithAck("chat:message", { roomId: message.roomId, text, clientId });
  const current = state.pendingMessages.get(clientId);
  if (!current) return;
  state.pendingMessages.delete(clientId);
  if (error || !response || !response.ok) {
    if (current.element.isConnected) {
      current.element.classList.remove("pending");
      current.element.classList.add("failed");
    }
    if (state.activeRoomId === message.roomId && !input.value) input.value = text;
    updateCharacterCount();
    toast(error || (response && response.error) || "Message was not sent.", "error");
  }
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy failed");
}

function inviteText(room) {
  return room.isPrivate
    ? `Join my CampusChat room "${room.name}" with invite code ${room.code}.\n${location.origin}`
    : `Join me in ${room.name} on CampusChat.\n${location.origin}`;
}

async function copyInvite() {
  if (!state.room) return;
  try {
    await copyText(inviteText(state.room));
    toast(state.room.isPrivate ? "Room invite copied to your clipboard." : "Room link copied to your clipboard.", "success");
  } catch {
    toast("Could not copy automatically. Select the room code instead.", "error");
  }
}

async function copyRoomCode() {
  if (!state.room) return;
  try {
    await copyText(state.room.code);
    toast(`Invite code ${state.room.code} copied.`, "success");
  } catch {
    toast("Could not copy the code automatically.", "error");
  }
}

function applyTheme(themeId, animate = false) {
  const theme = THEMES.find((item) => item.id === themeId);
  if (!theme) return;
  state.theme = theme.id;
  document.documentElement.dataset.theme = theme.id;
  try { localStorage.setItem(THEME_KEY, theme.id); } catch {}
  document.querySelectorAll("#themeMenu [data-theme]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.theme === theme.id));
  });
  if (animate && document.documentElement.animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.documentElement.animate([
      { filter: "saturate(1)" },
      { filter: "saturate(1.35)" },
      { filter: "saturate(1)" }
    ], { duration: 420, easing: "ease-out" });
  }
}

function closeThemeMenu() {
  $("themeMenu").hidden = true;
  $("themeButton").setAttribute("aria-expanded", "false");
}

function renderColorOptions() {
  $("colorOptions").innerHTML = COLORS.map((color, index) => `<label class="color-option" title="Avatar color ${index + 1}"><input type="radio" name="avatarColor" value="${color}" ${color === state.selectedColor ? "checked" : ""}><span style="background:${color}">${icon("check")}</span></label>`).join("");
}

function updateProfilePreview() {
  const name = $("profileName").value.trim() || "?";
  $("profilePreview").textContent = initials(name);
  $("profilePreview").style.background = state.selectedColor;
}

function openProfileModal() {
  state.selectedColor = state.profile ? state.profile.color : COLORS[0];
  $("profileName").value = state.profile ? state.profile.name : "";
  $("profileEyebrow").textContent = state.profile ? "YOUR CAMPUS IDENTITY" : "WELCOME TO CAMPUSCHAT";
  $("profileTitle").textContent = state.profile ? "Make yourself at home." : "Good conversations start here.";
  $("profileSubtitle").textContent = state.profile ? "Update how your name and avatar appear to other room members." : "Choose a name and jump into your campus community. No sign-up needed.";
  $("profileSubmit").innerHTML = `${state.profile ? "Save profile" : "Enter CampusChat"}${icon("arrow")}`;
  $("closeProfile").hidden = !state.profile;
  $("profileError").textContent = "";
  renderColorOptions();
  updateProfilePreview();
  $("profileModal").showModal();
  setTimeout(() => $("profileName").focus(), 50);
}

function setRoomTab(tab) {
  const create = tab === "create";
  $("createTab").classList.toggle("active", create);
  $("joinTab").classList.toggle("active", !create);
  $("createTab").setAttribute("aria-selected", String(create));
  $("joinTab").setAttribute("aria-selected", String(!create));
  $("createRoomPanel").hidden = !create;
  $("joinRoomPanel").hidden = create;
  $("createRoomError").textContent = "";
  $("joinRoomError").textContent = "";
  setTimeout(() => $(create ? "newRoomName" : "joinCode").focus(), 30);
}

function openRoomModal(tab = "create") {
  if (!state.connected) {
    toast("Wait until you are connected before creating a room.", "error");
    return;
  }
  $("createRoomPanel").reset();
  $("joinRoomPanel").reset();
  setRoomTab(tab);
  $("roomModal").showModal();
}

function openSidebar() {
  $("sidebar").classList.add("open");
  $("sidebarBackdrop").hidden = false;
  syncPanelAccess();
}

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebarBackdrop").hidden = true;
  syncPanelAccess();
}

function openMembers() {
  $("membersPanel").classList.add("open");
  syncPanelAccess();
  $("closeMembers").focus();
}

function closeMembers() {
  $("membersPanel").classList.remove("open");
  syncPanelAccess();
}

function syncPanelAccess() {
  const mobileSidebar = window.innerWidth <= 780;
  const compactMembers = window.innerWidth <= 1180;
  $("sidebar").inert = mobileSidebar && !$("sidebar").classList.contains("open");
  $("membersPanel").inert = compactMembers && !$("membersPanel").classList.contains("open");
}

$("themeButton").addEventListener("click", (event) => {
  event.stopPropagation();
  const opening = $("themeMenu").hidden;
  $("themeMenu").hidden = !opening;
  $("themeButton").setAttribute("aria-expanded", String(opening));
});
$("themeMenu").addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme]");
  if (!button) return;
  const theme = THEMES.find((item) => item.id === button.dataset.theme);
  applyTheme(theme.id, true);
  closeThemeMenu();
  toast(`${theme.label} theme applied.`, "success");
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#themeMenu") && !event.target.closest("#themeButton")) closeThemeMenu();
});

$("colorOptions").addEventListener("change", (event) => {
  if (event.target.name !== "avatarColor") return;
  state.selectedColor = event.target.value;
  updateProfilePreview();
});
$("profileName").addEventListener("input", updateProfilePreview);

$("profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("profileName").value.trim();
  if (name.length < 2) {
    $("profileError").textContent = "Your display name needs at least 2 characters.";
    return;
  }
  const wasConnected = Boolean(state.socket);
  const profile = { id: state.profile ? state.profile.id : createId(), name, color: state.selectedColor };
  const button = $("profileSubmit");
  button.disabled = true;
  if (wasConnected) {
    const { error, response } = await emitWithAck("profile:update", { name, color: state.selectedColor });
    button.disabled = false;
    if (error || !response || !response.ok) {
      $("profileError").textContent = error || (response && response.error) || "Could not update your profile.";
      return;
    }
  }
  state.profile = profile;
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch {}
  $("profileModal").close();
  renderSidebar();
  updateStatus();
  if (state.profile) setAvatar($("sidebarAvatar"), state.profile);
  if (!wasConnected) connect();
  else toast("Profile updated.", "success");
});

$("profileModal").addEventListener("cancel", (event) => {
  if (!state.profile) event.preventDefault();
});
$("closeProfile").addEventListener("click", () => $("profileModal").close());
$("profileButton").addEventListener("click", openProfileModal);

$("newRoomButton").addEventListener("click", () => openRoomModal("create"));
$("joinRoomButton").addEventListener("click", () => openRoomModal("join"));
$("closeRoomModal").addEventListener("click", () => $("roomModal").close());
$("createTab").addEventListener("click", () => setRoomTab("create"));
$("joinTab").addEventListener("click", () => setRoomTab("join"));

$("createRoomPanel").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("newRoomName").value.trim();
  if (name.length < 3) {
    $("createRoomError").textContent = "Room names need at least 3 characters.";
    return;
  }
  const button = event.submitter || event.currentTarget.querySelector("[type='submit']");
  button.disabled = true;
  const { error, response } = await emitWithAck("room:create", {
    name,
    description: $("newRoomDescription").value.trim(),
    isPrivate: $("privateRoom").checked
  });
  button.disabled = false;
  if (error || !response || !response.ok) {
    $("createRoomError").textContent = error || (response && response.error) || "Could not create the room.";
    return;
  }
  $("roomModal").close();
  activateRoom(response.room);
  toast("Your room is ready. Invite your people.", "success");
});

$("joinRoomPanel").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("joinCode").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    $("joinRoomError").textContent = "Enter the 6-character invite code.";
    return;
  }
  const button = event.submitter || event.currentTarget.querySelector("[type='submit']");
  button.disabled = true;
  const { error, response } = await emitWithAck("room:join", { code });
  button.disabled = false;
  if (error || !response || !response.ok) {
    $("joinRoomError").textContent = error || (response && response.error) || "Could not join the room.";
    return;
  }
  $("roomModal").close();
  activateRoom(response.room);
  toast(`Joined ${response.room.name}.`, "success");
});

$("roomList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-room-id]");
  if (button) requestJoin(button.dataset.roomId);
});
document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
    renderSidebar();
  });
});
$("roomSearch").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderSidebar();
});

$("messageForm").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});
$("messageInput").addEventListener("input", () => {
  updateCharacterCount();
  if (!state.connected || !state.activeRoomId) return;
  if (!$("messageInput").value.trim()) {
    stopTyping();
    return;
  }
  state.socket.emit("chat:typing", { roomId: state.activeRoomId, isTyping: true });
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(stopTyping, 1300);
});
$("messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});
$("messageInput").addEventListener("blur", stopTyping);
$("messageList").addEventListener("scroll", () => {
  if (isNearBottom()) $("newMessagesButton").hidden = true;
}, { passive: true });
$("newMessagesButton").addEventListener("click", () => scrollToBottom());

$("messageList").addEventListener("click", (event) => {
  const codeButton = event.target.closest("[data-copy-code]");
  if (codeButton) copyRoomCode();
  const prompt = event.target.closest("[data-prompt]");
  if (prompt && state.connected) {
    $("messageInput").value = prompt.dataset.prompt;
    updateCharacterCount();
    sendMessage();
    $("messageInput").focus();
  }
});

$("inviteButton").addEventListener("click", copyInvite);
$("roomCodeBadge").addEventListener("click", copyRoomCode);
$("copyCodeButton").addEventListener("click", copyInvite);
$("leaveRoomButton").addEventListener("click", async () => {
  if (!state.room || state.room.id === "lobby") return;
  const roomId = state.room.id;
  const { error, response } = await emitWithAck("room:leave", { roomId });
  if (error || !response || !response.ok) {
    toast(error || (response && response.error) || "Could not leave the room.", "error");
    return;
  }
  try { localStorage.removeItem(ACTIVE_ROOM_KEY); } catch {}
  state.activeRoomId = null;
  state.room = null;
  closeMembers();
  renderRoom();
  requestJoin("lobby");
  toast("You left the room.", "success");
});

$("openSidebar").addEventListener("click", openSidebar);
$("closeSidebar").addEventListener("click", closeSidebar);
$("sidebarBackdrop").addEventListener("click", closeSidebar);
$("membersButton").addEventListener("click", openMembers);
$("closeMembers").addEventListener("click", closeMembers);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeThemeMenu();
  closeSidebar();
  if (window.innerWidth <= 1180) closeMembers();
});
window.addEventListener("resize", syncPanelAccess);

applyTheme(state.theme);
syncPanelAccess();
renderSidebar();
updateStatus();
if (state.profile) connect();
else openProfileModal();
