const express = require("express");
const path = require("path");
const { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } = require("crypto");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const server = createServer(app);
const io = new Server(server);
const port = 3000;
const rooms = Object.create(null);
const disconnectGraceMs = 60 * 1000;
const abandonedRoomCleanupMs = 5 * 60 * 1000;
const MAX_PLAYERS = 12;
const codeCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const roomCodePattern = /^[A-HJ-NP-Z2-9]{5}$/;
const aliases = [
  "NeonToast", "SilentPanda", "CrimsonFox", "MangoWizard",
  "CosmicPenguin", "VelvetTiger", "PixelGhost", "LunarKoala",
  "TurboSloth", "MysticOtter", "ElectricLlama", "ShadowPeach",
  "GoldenRaven", "FrostyCactus", "BananaKnight", "PurpleMeteor"
];

function publicRoom(roomCode) {
  const room = rooms[roomCode];
  return {
    roomCode,
    players: room.players.map(({ name, isHost, connected, left }) => ({ name, isHost, connected, left })),
    settings: room.settings
  };
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest();
}

function playerForSocket(room, socket) {
  const player = room?.players.find((member) => member.id === socket?.data?.playerId);
  return player?.connected && player.socketId === socket.id ? player : null;
}

function requireRoomPhase(room, phases, reply, message = "That action is not available right now.") {
  if (phases.includes(room.phase)) return true;
  reply({ error: message });
  return false;
}

function actionContext(socket, reply, phases, hostOnly = false) {
  const roomCode = socket?.data?.roomCode;
  const room = rooms[roomCode];
  const player = playerForSocket(room, socket);
  if (!room || !player) {
    reply({ error: "You are not in a valid room." });
    return null;
  }
  if (!requireRoomPhase(room, phases, reply)) return null;
  if (hostOnly && !player.isHost) {
    reply({ error: "Only the host can do that." });
    return null;
  }
  return { roomCode, room, player };
}

function cleanPlayerName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 30 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
  return name;
}

function deleteRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  clearTimeout(room.chatTimer);
  clearTimeout(room.emptyTimer);
  for (const player of room.players) clearTimeout(player.disconnectTimer);
  delete rooms[roomCode];
}

function scheduleEmptyRoomCleanup(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.players.some((player) => player.connected && !player.left)) return;
  clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    const current = rooms[roomCode];
    if (current && !current.players.some((player) => player.connected && !player.left)) {
      deleteRoom(roomCode);
    }
  }, abandonedRoomCleanupMs);
}

function roomView(roomCode, player) {
  return { ...publicRoom(roomCode), isHost: Boolean(player?.isHost) };
}

function broadcastRoom(roomCode) {
  const room = rooms[roomCode];
  for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
    const socket = io.sockets.sockets.get(socketId);
    const player = playerForSocket(room, socket);
    if (player) socket.emit("roomUpdated", roomView(roomCode, player));
  }
}

function notifyHostStatus(roomCode) {
  const room = rooms[roomCode];
  for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
    const socket = io.sockets.sockets.get(socketId);
    const player = playerForSocket(room, socket);
    if (player) socket.emit("hostStatus", { isHost: player.isHost });
  }
}

function partnerStatus(room, player) {
  const pair = room.pairs?.find(({ player1Id, player2Id }) =>
    player1Id === player.id || player2Id === player.id
  );
  if (!pair) return null;
  const partnerId = pair.player1Id === player.id ? pair.player2Id : pair.player1Id;
  const partner = room.players.find((member) => member.id === partnerId);
  return partner?.left ? "left" : partner?.connected ? "connected" : "disconnected";
}

function notifyPartnerStatus(room, player) {
  const pair = room.pairs?.find(({ player1Id, player2Id }) =>
    player1Id === player.id || player2Id === player.id
  );
  if (!pair) return;
  const partnerId = pair.player1Id === player.id ? pair.player2Id : pair.player1Id;
  const partner = room.players.find((member) => member.id === partnerId);
  const partnerSocket = partner?.socketId && io.sockets.sockets.get(partner.socketId);
  if (partnerSocket && partner.connected && !partner.left) {
    partnerSocket.emit("partnerStatus", partnerStatus(room, partner));
  }
}

function assignNewHost(roomCode) {
  const room = rooms[roomCode];
  if (room.players.some((player) => player.isHost && player.connected && !player.left)) return false;
  const nextHost = room.players.find((player) => player.connected && !player.left);
  if (!nextHost) return false;
  room.players.forEach((player) => { player.isHost = player.id === nextHost.id; });
  notifyHostStatus(roomCode);
  return true;
}

function removeDisconnectedPlayer(roomCode, playerId) {
  const room = rooms[roomCode];
  const player = room?.players.find((member) => member.id === playerId);
  if (!player || player.connected || player.left) return;
  player.disconnectTimer = null;
  player.left = true;
  if (room.phase === "lobby") room.players = room.players.filter((member) => member.id !== playerId);
  else if (room.phase === "chat" ||
    (room.phase === "guessing" && !Object.hasOwn(room.guesses, player.id))) {
    room.roundBlocked = true;
  }
  if (room.phase === "guessing") {
    for (const member of room.players) {
      if (!Object.hasOwn(room.guesses, member.id)) {
        room.guessOptions[member.id] = (room.guessOptions[member.id] || [])
          .filter((option) => option.id !== player.id);
      }
    }
  }
  notifyPartnerStatus(room, player);
  assignNewHost(roomCode);
  broadcastRoom(roomCode);
  if (room.roundBlocked) io.to(roomCode).emit("roundBlocked", { isHostActionAvailable: true });
  scheduleEmptyRoomCleanup(roomCode);
}

function restoreRoomState(room, player) {
  if (room.phase === "chat" && Date.now() >= room.chatEndsAt) endChat(room.roomCode, room.round);
  const status = partnerStatus(room, player);
  const state = room.phase === "chat"
    ? { identity: { ...matchForPlayer(room, player), partnerStatus: status } }
    : room.phase === "guessing" ? { guessing: guessingForPlayer(room, player) }
      : room.phase === "reveal" ? { reveal: revealForPlayer(room, player) }
        : room.phase === "scoreboard" ? { scoreboard: scoreboardForPlayer(room, player) }
          : room.phase === "game_over" ? { gameOver: finalResults(room) }
            : { room: roomView(room.roomCode, player) };
  return { ...state, partnerStatus: status, roundBlocked: Boolean(room.roundBlocked), isHost: player.isHost };
}

function skipBlockedRound(roomCode) {
  const room = rooms[roomCode];
  clearTimeout(room.chatTimer);
  room.chatTimer = null;
  room.chatStartedAt = null;
  room.chatEndsAt = null;
  room.roundBlocked = false;
  room.scoredRound = room.round;
  for (const player of room.players) player.roundScore = 0;
  const remaining = room.players.filter((player) => !player.left);
  if (room.round >= room.settings.totalRounds || remaining.length < 2 || remaining.length % 2) {
    room.phase = "game_over";
    for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
      const socket = io.sockets.sockets.get(socketId);
      if (playerForSocket(room, socket)) socket.emit("gameOver", finalResults(room));
    }
    return;
  }
  room.phase = "scoreboard";
  for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
    const socket = io.sockets.sockets.get(socketId);
    const player = playerForSocket(room, socket);
    if (player) socket.emit("scoreboardReady", scoreboardForPlayer(room, player));
  }
}

function matchForPlayer(room, player) {
  const pair = room.pairs.find(({ player1Id, player2Id }) =>
    player1Id === player.id || player2Id === player.id
  );
  const partnerId = pair.player1Id === player.id ? pair.player2Id : pair.player1Id;
  const partner = room.players.find((member) => member.id === partnerId);
  return {
    alias: player.alias,
    partnerAlias: partner.alias,
    round: room.round,
    totalRounds: room.settings.totalRounds,
    chatDuration: room.settings.chatDuration,
    chatEndsAt: room.chatEndsAt,
    serverNow: Date.now(),
    messages: pair.messages.map(({ senderId, text }) => ({
      senderAlias: room.players.find((member) => member.id === senderId).alias,
      text
    })),
    partnerStatus: partnerStatus(room, player)
  };
}

function shuffledChoices(choices) {
  const result = [...choices];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function pairKey(player1Id, player2Id) {
  return [player1Id, player2Id].sort().join("|");
}

function choosePairs(playerIds, pairHistory) {
  let bestPairs;
  let fewestRepeats = Infinity;

  function search(remaining, pairs, repeats) {
    if (remaining.length === 0) {
      bestPairs = [...pairs];
      fewestRepeats = repeats;
      return repeats === 0;
    }

    const first = remaining[0];
    const candidates = shuffledChoices(remaining.slice(1));
    candidates.sort((a, b) =>
      Number(pairHistory.has(pairKey(first, a))) - Number(pairHistory.has(pairKey(first, b)))
    );
    for (const second of candidates) {
      const nextRepeats = repeats + Number(pairHistory.has(pairKey(first, second)));
      if (nextRepeats >= fewestRepeats) continue;
      pairs.push({ player1Id: first, player2Id: second });
      const next = remaining.filter((id) => id !== first && id !== second);
      if (search(next, pairs, nextRepeats)) return true;
      pairs.pop();
    }
    return false;
  }

  search(shuffledChoices(playerIds), [], 0);
  return bestPairs;
}

function guessingForPlayer(room, player) {
  const submitted = Object.hasOwn(room.guesses, player.id);
  return {
    options: submitted ? [] : room.guessOptions[player.id],
    round: room.round,
    submitted,
    submittedCount: Object.keys(room.guesses).length,
    totalPlayers: room.players.length
  };
}

function revealForPlayer(room, player) {
  const pair = room.pairs?.find(({ player1Id, player2Id }) =>
    player1Id === player.id || player2Id === player.id
  );
  const partnerId = pair && (pair.player1Id === player.id ? pair.player2Id : pair.player1Id);
  const partner = room.players.find((member) => member.id === partnerId);
  const guessed = room.players.find((member) => member.id === room.guesses?.[player.id]);
  return {
    partnerAlias: partner?.alias || "Unknown",
    partnerName: partner?.name || "Unknown",
    guessedName: guessed?.name || "No guess submitted",
    correct: Boolean(partner && room.guesses?.[player.id] === partner.id),
    partnerCorrect: Boolean(partner && room.guesses?.[partner.id] === player.id)
  };
}

function scoreRound(room) {
  if (room.phase !== "reveal" || room.round < 1 || room.scoredRound >= room.round) return false;
  for (const player of room.players) {
    const result = revealForPlayer(room, player);
    player.roundScore = (result.correct ? 100 : 0) + (result.partnerCorrect ? 0 : 50);
    player.totalScore += player.roundScore;
    if (result.correct) player.correctGuesses += 1;
    if (!result.partnerCorrect) player.timesFooledPartner += 1;
  }
  room.scoredRound = room.round;
  return true;
}

function compareScores(a, b) {
  return b.totalScore - a.totalScore ||
    b.roundScore - a.roundScore || a.name.localeCompare(b.name);
}

function scoreboardForPlayer(room, player) {
  const rows = room.players.map(({ name, roundScore, totalScore }) => ({
    name, roundScore, totalScore
  }));
  rows.sort(compareScores);
  return {
    round: room.round,
    totalRounds: room.settings.totalRounds,
    rows,
    isHost: player.isHost
  };
}

function finalResults(room) {
  const ranked = [...room.players].sort(compareScores);
  if (ranked.length === 0) {
    return { winners: [], rows: [], bestDetectives: [], mostMysterious: [] };
  }
  const highestScore = ranked[0].totalScore;
  const mostCorrect = Math.max(...ranked.map((player) => player.correctGuesses));
  const mostFooled = Math.max(...ranked.map((player) => player.timesFooledPartner));
  return {
    winners: ranked.filter((player) => player.totalScore === highestScore)
      .map((player) => player.name),
    rows: ranked.map(({ name, roundScore, totalScore, correctGuesses, timesFooledPartner }) => ({
      name, roundScore, totalScore, correctGuesses, timesFooledPartner
    })),
    bestDetectives: ranked.filter((player) => player.correctGuesses === mostCorrect)
      .map((player) => player.name),
    mostMysterious: ranked.filter((player) => player.timesFooledPartner === mostFooled)
      .map((player) => player.name)
  };
}

function beginRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return false;
  clearTimeout(room.chatTimer);
  room.chatTimer = null;
  room.chatStartedAt = null;
  room.chatEndsAt = null;
  room.guesses = Object.create(null);
  room.guessOptions = Object.create(null);
  room.pairs = [];
  for (const player of room.players) player.roundScore = 0;

  let newAliases;
  do {
    newAliases = shuffledChoices(aliases).slice(0, room.players.length);
  } while (room.players.some((player, index) => player.alias === newAliases[index]));
  room.players.forEach((player, index) => { player.alias = newAliases[index]; });

  const newPairs = choosePairs(room.players.map((player) => player.id), room.pairHistory);
  for (const pair of newPairs) {
    room.pairs.push({ ...pair, messages: [] });
    room.pairHistory.add(pairKey(pair.player1Id, pair.player2Id));
  }
  room.round += 1;
  room.phase = "chat";
  room.chatStartedAt = Date.now();
  room.chatEndsAt = room.chatStartedAt + room.settings.chatDuration * 60 * 1000;
  const timerRound = room.round;
  room.chatTimer = setTimeout(() => endChat(roomCode, timerRound), room.chatEndsAt - room.chatStartedAt);

  for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
    const playerSocket = io.sockets.sockets.get(socketId);
    const player = playerForSocket(room, playerSocket);
    if (player) playerSocket.emit("gameStarted", matchForPlayer(room, player));
  }
  return true;
}

function endChat(roomCode, expectedRound) {
  const room = rooms[roomCode];
  if (!room || room.phase !== "chat" || room.round !== expectedRound) return false;
  clearTimeout(room.chatTimer);
  room.chatTimer = null;
  room.chatStartedAt = null;
  room.phase = "guessing";
  room.guesses = Object.create(null);
  room.guessOptions = Object.create(null);
  for (const player of room.players) {
    room.guessOptions[player.id] = shuffledChoices(
      room.players.filter((other) => other.id !== player.id && !other.left)
        .map(({ id, name }) => ({ id, name }))
    );
  }
  for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
    const playerSocket = io.sockets.sockets.get(socketId);
    const player = playerForSocket(room, playerSocket);
    if (player) playerSocket.emit("chatEnded", guessingForPlayer(room, player));
  }
  return true;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/rooms", (req, res) => {
  const name = cleanPlayerName(req.body?.name);
  const chatDuration = req.body?.chatDuration;
  const totalRounds = req.body?.totalRounds;

  if (!name || ![2, 3, 5].includes(chatDuration) || ![1, 3, 5].includes(totalRounds)) {
    return res.status(400).json({ error: "Enter a name and choose valid room settings." });
  }

  let roomCode;
  do {
    roomCode = Array.from({ length: 5 }, () => codeCharacters[randomInt(codeCharacters.length)]).join("");
  } while (rooms[roomCode]);

  const playerId = randomUUID();
  rooms[roomCode] = {
    hostName: name,
    players: [{ id: playerId, name, tokenHash: null, isHost: true,
      connected: false, socketId: null, disconnectedAt: null, disconnectTimer: null,
      left: false, roundScore: 0, totalScore: 0, correctGuesses: 0, timesFooledPartner: 0 }],
    roomCode,
    settings: { chatDuration, totalRounds },
    round: 0,
    scoredRound: 0,
    roundBlocked: false,
    pairHistory: new Set(),
    chatTimer: null,
    emptyTimer: null,
    phase: "lobby"
  };

  const reconnectToken = randomBytes(32).toString("base64url");
  rooms[roomCode].players[0].tokenHash = tokenHash(reconnectToken);
  scheduleEmptyRoomCleanup(roomCode);
  res.status(201).json({ roomCode, reconnectToken });
});

app.use((error, req, res, next) => {
  console.error("Request rejected:", error.message);
  if (res.headersSent) return next(error);
  res.status(400).json({ error: "Invalid request." });
});

io.on("connection", (socket) => {
  socket.on("enterRoom", (data, reply) => {
    if (typeof reply !== "function") return;
    const { roomCode: requestedRoomCode, reconnectToken } = data && typeof data === "object" ? data : {};
    const roomCode = typeof requestedRoomCode === "string" && roomCodePattern.test(requestedRoomCode)
      ? requestedRoomCode : "";
    const room = rooms[roomCode];
    const suppliedHash = typeof reconnectToken === "string" && reconnectToken.length === 43
      ? tokenHash(reconnectToken) : Buffer.alloc(32);
    const player = room?.players.find((member) => {
      if (member.left || !member.tokenHash) return false;
      return timingSafeEqual(member.tokenHash, suppliedHash);
    });
    if (!player) {
      return reply({ error: "Room or reconnect token not found." });
    }
    const currentPlayer = playerForSocket(rooms[socket.data.roomCode], socket);
    if (currentPlayer && currentPlayer.id !== player.id) {
      return reply({ error: "This connection already belongs to another player." });
    }

    if (player.disconnectedAt && Date.now() - player.disconnectedAt >= disconnectGraceMs) {
      removeDisconnectedPlayer(roomCode, player.id);
      return reply({ error: "The reconnect period has expired." });
    }
    clearTimeout(player.disconnectTimer);
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
    player.disconnectTimer = null;
    const previousSocket = player.socketId && io.sockets.sockets.get(player.socketId);
    player.connected = true;
    player.socketId = socket.id;
    player.disconnectedAt = null;
    player.left = false;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = player.id;
    if (previousSocket && previousSocket.id !== socket.id) previousSocket.disconnect(true);
    const state = restoreRoomState(room, player);
    if (state.room) state.room.reconnectToken = reconnectToken;
    notifyPartnerStatus(room, player);
    broadcastRoom(roomCode);
    reply(state);
  });

  socket.on("joinRoom", (data, reply) => {
    if (typeof reply !== "function") return;
    if (playerForSocket(rooms[socket.data.roomCode], socket)) {
      return reply({ error: "This connection already belongs to a player." });
    }
    const { name, roomCode } = data && typeof data === "object" ? data : {};
    const playerName = cleanPlayerName(name);
    const code = typeof roomCode === "string" ? roomCode.trim().toUpperCase() : "";
    if (!playerName) {
      return reply({ error: "Please enter a player name (up to 30 characters)." });
    }
    if (!roomCodePattern.test(code)) return reply({ error: "Enter a valid 5-character room code." });
    const room = rooms[code];
    if (!room) return reply({ error: "Room not found. Check the room code." });
    if (!requireRoomPhase(room, ["lobby"], reply, "This game has already started.")) return;
    if (room.players.length >= MAX_PLAYERS) return reply({ error: "This room is full." });
    if (room.players.some((player) => player.name.toLowerCase() === playerName.toLowerCase())) {
      return reply({ error: "That player name is already taken in this room." });
    }

    const playerId = randomUUID();
    const reconnectToken = randomBytes(32).toString("base64url");
    const player = { id: playerId, name: playerName, tokenHash: tokenHash(reconnectToken),
      isHost: false, connected: true, socketId: socket.id, disconnectedAt: null,
      disconnectTimer: null, left: false, roundScore: 0, totalScore: 0,
      correctGuesses: 0, timesFooledPartner: 0 };
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    reply({ room: roomView(code, player), reconnectToken });
    broadcastRoom(code);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    const player = room?.players.find((member) => member.id === socket.data.playerId);
    if (!player || player.socketId !== socket.id || !player.connected) return;
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    player.disconnectTimer = setTimeout(
      () => removeDisconnectedPlayer(roomCode, player.id), disconnectGraceMs
    );
    notifyPartnerStatus(room, player);
    broadcastRoom(roomCode);
  });

  socket.on("startGame", (reply) => {
    if (typeof reply !== "function") return;
    const context = actionContext(socket, reply, ["lobby"], true);
    if (!context) return;
    const { roomCode, room } = context;
    if (room.players.length < 2) return reply({ error: "At least 2 players are needed to start." });
    if (room.players.length % 2 !== 0) return reply({ error: "An even number of players is needed to start." });
    if (room.players.length > MAX_PLAYERS) return reply({ error: `This room supports up to ${MAX_PLAYERS} players.` });
    if (room.players.some((member) => !member.connected || member.left)) {
      return reply({ error: "Wait for all players to reconnect before starting." });
    }

    beginRound(roomCode);
    reply({ ok: true });
  });

  socket.on("sendMessage", (...args) => {
    const reply = typeof args.at(-1) === "function" ? args.pop() : null;
    if (!reply) return;
    if (args.length !== 1) return reply({ error: "Send only a message." });
    const [messageText] = args;
    const context = actionContext(socket, reply, ["chat"]);
    if (!context) return;
    const { roomCode, room, player: sender } = context;
    if (Date.now() >= room.chatEndsAt) {
      endChat(roomCode, room.round);
      return reply({ error: "Chat is not active." });
    }
    const pair = room.pairs.find(({ player1Id, player2Id }) =>
      player1Id === sender.id || player2Id === sender.id
    );
    if (!pair) return reply({ error: "You do not have a partner." });
    if (typeof messageText !== "string" || !messageText.trim()) {
      return reply({ error: "Enter a message before sending." });
    }
    const text = messageText.trim();
    if (text.length > 500) return reply({ error: "Messages must be 500 characters or fewer." });

    pair.messages.push({ senderId: sender.id, text });
    const visibleMessage = { senderAlias: sender.alias, text };
    for (const playerId of [pair.player1Id, pair.player2Id]) {
      const recipient = room.players.find((member) => member.id === playerId);
      const playerSocket = recipient?.socketId && io.sockets.sockets.get(recipient.socketId);
      if (playerForSocket(room, playerSocket)?.id === playerId) {
        playerSocket.emit("chatMessage", visibleMessage);
      }
    }
    reply({ ok: true });
  });

  socket.on("submitGuess", (...args) => {
    const reply = typeof args.at(-1) === "function" ? args.pop() : null;
    if (!reply) return;
    if (args.length !== 2) return reply({ error: "Choose one player for this round." });
    const [selectedPlayerId, actionRound] = args;
    const context = actionContext(socket, reply, ["guessing"]);
    if (!context) return;
    const { roomCode, room, player } = context;
    if (typeof selectedPlayerId !== "string" || !Number.isInteger(actionRound)) {
      return reply({ error: "Choose a valid player for this round." });
    }
    if (actionRound !== room.round) return reply({ error: "This action belongs to an earlier round." });
    if (room.guesses && Object.hasOwn(room.guesses, player.id)) {
      return reply({ error: "You have already submitted a guess." });
    }
    const isValidOption = room.guessOptions?.[player.id]?.some((option) => option.id === selectedPlayerId);
    const selected = room.players.find((member) => member.id === selectedPlayerId && !member.left);
    if (!isValidOption || !selected) return reply({ error: "Choose a valid player from the list." });
    if (selected.id === player.id) return reply({ error: "You cannot choose yourself." });

    room.guesses[player.id] = selected.id;
    const submittedCount = Object.keys(room.guesses).length;
    io.to(roomCode).emit("guessProgress", { submittedCount, totalPlayers: room.players.length });
    if (submittedCount === room.players.length) {
      room.phase = "reveal";
      for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
        const playerSocket = io.sockets.sockets.get(socketId);
        const ownPlayer = room.players.find((member) => member.id === playerSocket?.data.playerId);
        if (ownPlayer) playerSocket.emit("revealResult", revealForPlayer(room, ownPlayer));
      }
    }
    reply({ ok: true, reveal: room.phase === "reveal" });
  });

  socket.on("continueToScoreboard", (reply) => {
    if (typeof reply !== "function") return;
    const context = actionContext(socket, reply, ["reveal", "scoreboard", "game_over"]);
    if (!context) return;
    const { roomCode, room, player } = context;
    if (room.phase === "scoreboard") {
      return reply({ scoreboard: scoreboardForPlayer(room, player) });
    }
    if (room.phase === "game_over") return reply({ gameOver: finalResults(room) });
    if (room.phase !== "reveal") return reply({ error: "The reveal is not complete yet." });

    scoreRound(room);
    if (room.round === room.settings.totalRounds) {
      room.phase = "game_over";
      for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
        const playerSocket = io.sockets.sockets.get(socketId);
        if (playerForSocket(room, playerSocket)) {
          playerSocket.emit("gameOver", finalResults(room));
        }
      }
      return reply({ ok: true });
    }
    room.phase = "scoreboard";
    for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
      const playerSocket = io.sockets.sockets.get(socketId);
      const ownPlayer = playerForSocket(room, playerSocket);
      if (ownPlayer) playerSocket.emit("scoreboardReady", scoreboardForPlayer(room, ownPlayer));
    }
    reply({ ok: true });
  });

  socket.on("nextRound", (reply) => {
    if (typeof reply !== "function") return;
    const context = actionContext(socket, reply, ["scoreboard"], true);
    if (!context) return;
    const { roomCode, room } = context;
    if (room.round >= room.settings.totalRounds) return reply({ error: "All rounds are complete." });

    const remainingPlayers = room.players.filter((member) => !member.left);
    if (remainingPlayers.length < 2 || remainingPlayers.length % 2) {
      room.phase = "game_over";
      io.to(roomCode).emit("gameOver", finalResults(room));
      return reply({ error: "There are not enough connected players to continue." });
    }

    room.players = remainingPlayers;
    beginRound(roomCode);
    reply({ ok: true });
  });

  socket.on("skipRound", (reply) => {
    if (typeof reply !== "function") return;
    const context = actionContext(socket, reply, ["chat", "guessing"], true);
    if (!context) return;
    const { roomCode, room } = context;
    if (!room.roundBlocked || !["chat", "guessing"].includes(room.phase)) {
      return reply({ error: "There is no blocked round to skip." });
    }
    skipBlockedRound(roomCode);
    reply({ ok: true });
  });
});

server.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
