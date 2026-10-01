const express = require("express");
const path = require("path");
const { randomInt, randomUUID } = require("crypto");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const server = createServer(app);
const io = new Server(server);
const port = 3000;
const rooms = Object.create(null);
const codeCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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
    players: room.players.map(({ name, isHost }) => ({ name, isHost })),
    settings: room.settings
  };
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
    }))
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

function guessingForPlayer(room, player) {
  const submitted = Object.hasOwn(room.guesses, player.id);
  return {
    options: submitted ? [] : room.guessOptions[player.id],
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
  if (room.scoredRound === room.round) return;
  for (const player of room.players) {
    const result = revealForPlayer(room, player);
    player.roundScore = (result.correct ? 100 : 0) + (result.partnerCorrect ? 0 : 50);
    player.totalScore += player.roundScore;
  }
  room.scoredRound = room.round;
}

function scoreboardForPlayer(room, player) {
  const rows = room.players.map(({ name, roundScore, totalScore }) => ({
    name, roundScore, totalScore
  }));
  rows.sort((a, b) => b.totalScore - a.totalScore ||
    b.roundScore - a.roundScore || a.name.localeCompare(b.name));
  return {
    round: room.round,
    totalRounds: room.settings.totalRounds,
    rows,
    isHost: player.isHost
  };
}

function endChat(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== "chat") return;
  clearTimeout(room.chatTimer);
  room.chatTimer = null;
  room.phase = "guessing";
  room.guesses = Object.create(null);
  room.guessOptions = Object.create(null);
  for (const player of room.players) {
    room.guessOptions[player.id] = shuffledChoices(
      room.players.filter((other) => other.id !== player.id)
        .map(({ id, name }) => ({ id, name }))
    );
  }
  for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
    const playerSocket = io.sockets.sockets.get(socketId);
    const player = room.players.find((member) => member.id === playerSocket?.data.playerId);
    if (player) playerSocket.emit("chatEnded", guessingForPlayer(room, player));
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/rooms", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const chatDuration = Number(req.body?.chatDuration);
  const totalRounds = Number(req.body?.totalRounds);

  if (!name || name.length > 30 || ![2, 3, 5].includes(chatDuration) || ![1, 3, 5].includes(totalRounds)) {
    return res.status(400).json({ error: "Enter a name and choose valid room settings." });
  }

  let roomCode;
  do {
    roomCode = Array.from({ length: 5 }, () => codeCharacters[randomInt(codeCharacters.length)]).join("");
  } while (rooms[roomCode]);

  const playerId = randomUUID();
  rooms[roomCode] = {
    hostName: name,
    players: [{ id: playerId, name, isHost: true, roundScore: 0, totalScore: 0 }],
    settings: { chatDuration, totalRounds },
    round: 0,
    scoredRound: 0,
    phase: "lobby"
  };

  res.status(201).json({ roomCode, playerId });
});

io.on("connection", (socket) => {
  socket.on("enterRoom", (data, reply) => {
    if (typeof reply !== "function") return;
    const { roomCode, playerId } = data && typeof data === "object" ? data : {};
    const room = rooms[roomCode];
    const player = room?.players.find((player) => player.id === playerId);
    if (!player) {
      return reply({ error: "Room or player not found." });
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    if (room.phase === "chat" && Date.now() >= room.chatEndsAt) endChat(roomCode);
    if (room.phase === "chat") {
      return reply({ identity: matchForPlayer(room, player) });
    }
    if (room.phase === "guessing") return reply({ guessing: guessingForPlayer(room, player) });
    if (room.phase === "reveal") return reply({ reveal: revealForPlayer(room, player) });
    if (room.phase === "scoreboard") return reply({ scoreboard: scoreboardForPlayer(room, player) });
    reply({ room: publicRoom(roomCode) });
  });

  socket.on("joinRoom", (data, reply) => {
    if (typeof reply !== "function") return;
    const { name, roomCode } = data && typeof data === "object" ? data : {};
    const playerName = typeof name === "string" ? name.trim() : "";
    const code = typeof roomCode === "string" ? roomCode.trim().toUpperCase() : "";
    if (!playerName || playerName.length > 30) {
      return reply({ error: "Please enter a player name (up to 30 characters)." });
    }
    const room = rooms[code];
    if (!room) return reply({ error: "Room not found. Check the room code." });
    if (room.phase !== "lobby") return reply({ error: "This game has already started." });
    if (room.players.some((player) => player.name.toLowerCase() === playerName.toLowerCase())) {
      return reply({ error: "That player name is already taken in this room." });
    }

    const playerId = randomUUID();
    room.players.push({ id: playerId, name: playerName, isHost: false, roundScore: 0, totalScore: 0 });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    const visibleRoom = publicRoom(code);
    reply({ room: visibleRoom, playerId });
    socket.to(code).emit("roomUpdated", visibleRoom);
  });

  socket.on("startGame", (reply) => {
    if (typeof reply !== "function") return;
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    const player = room?.players.find((player) => player.id === socket.data.playerId);
    if (!player?.isHost) return reply({ error: "Only the host can start the game." });
    if (room.phase !== "lobby") return reply({ error: "The game has already started." });
    if (room.players.length < 2) return reply({ error: "At least 2 players are needed to start." });
    if (room.players.length % 2 !== 0) return reply({ error: "An even number of players is needed to start." });
    if (room.players.length > aliases.length) return reply({ error: "This room supports up to 16 players." });

    const availableAliases = [...aliases];
    for (const roomPlayer of room.players) {
      const index = randomInt(availableAliases.length);
      roomPlayer.alias = availableAliases.splice(index, 1)[0];
    }
    const shuffledIds = room.players.map((member) => member.id);
    for (let i = shuffledIds.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [shuffledIds[i], shuffledIds[j]] = [shuffledIds[j], shuffledIds[i]];
    }
    room.pairs = [];
    for (let i = 0; i < shuffledIds.length; i += 2) {
      room.pairs.push({ player1Id: shuffledIds[i], player2Id: shuffledIds[i + 1], messages: [] });
    }
    room.phase = "chat";
    room.round = 1;
    room.chatStartedAt = Date.now();
    room.chatEndsAt = room.chatStartedAt + room.settings.chatDuration * 60 * 1000;
    room.chatTimer = setTimeout(() => endChat(roomCode), room.chatEndsAt - room.chatStartedAt);

    for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
      const playerSocket = io.sockets.sockets.get(socketId);
      const ownPlayer = room.players.find((member) => member.id === playerSocket.data.playerId);
      if (ownPlayer) {
        playerSocket.emit("gameStarted", matchForPlayer(room, ownPlayer));
      }
    }
    reply({ ok: true });
  });

  socket.on("sendMessage", (messageText, reply) => {
    if (typeof reply !== "function") return;
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    const sender = room?.players.find((player) => player.id === socket.data.playerId);
    if (!sender) return reply({ error: "You are not in a valid room." });
    if (room.phase === "chat" && Date.now() >= room.chatEndsAt) endChat(roomCode);
    if (room.phase !== "chat") return reply({ error: "Chat is not active." });
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
    for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
      const playerSocket = io.sockets.sockets.get(socketId);
      if (playerSocket && [pair.player1Id, pair.player2Id].includes(playerSocket.data.playerId)) {
        playerSocket.emit("chatMessage", visibleMessage);
      }
    }
    reply({ ok: true });
  });

  socket.on("submitGuess", (selectedPlayerId, reply) => {
    if (typeof reply !== "function") return;
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    const player = room?.players.find((member) => member.id === socket.data.playerId);
    if (!player) return reply({ error: "You are not in a valid room." });
    if (room.guesses && Object.hasOwn(room.guesses, player.id)) {
      return reply({ error: "You have already submitted a guess." });
    }
    if (room.phase !== "guessing") return reply({ error: "Guessing is not active." });
    const selected = room.players.find((member) => member.id === selectedPlayerId);
    if (!selected) return reply({ error: "Choose a player from this room." });
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
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    const player = room?.players.find((member) => member.id === socket.data.playerId);
    if (!player) return reply({ error: "You are not in a valid room." });
    if (room.phase === "scoreboard") {
      return reply({ scoreboard: scoreboardForPlayer(room, player) });
    }
    if (room.phase !== "reveal") return reply({ error: "The reveal is not complete yet." });

    scoreRound(room);
    room.phase = "scoreboard";
    for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
      const playerSocket = io.sockets.sockets.get(socketId);
      const ownPlayer = room.players.find((member) => member.id === playerSocket?.data.playerId);
      if (ownPlayer) playerSocket.emit("scoreboardReady", scoreboardForPlayer(room, ownPlayer));
    }
    reply({ ok: true });
  });
});

server.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
