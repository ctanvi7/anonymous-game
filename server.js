const express = require("express");
const path = require("path");
const { randomInt, randomUUID } = require("crypto");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const server = createServer(app);
const io = new Server(server);
const port = 3000;
const rooms = {};
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
    players: [{ id: playerId, name, isHost: true }],
    settings: { chatDuration, totalRounds },
    round: 0,
    phase: "lobby"
  };

  res.status(201).json({ roomCode, playerId });
});

io.on("connection", (socket) => {
  socket.on("enterRoom", ({ roomCode, playerId }, reply) => {
    const room = rooms[roomCode];
    const player = room?.players.find((player) => player.id === playerId);
    if (!player) {
      return reply({ error: "Room or player not found." });
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    if (room.phase === "game_started") {
      return reply({ identity: {
        alias: player.alias,
        round: room.round,
        totalRounds: room.settings.totalRounds,
        chatDuration: room.settings.chatDuration
      } });
    }
    reply({ room: publicRoom(roomCode) });
  });

  socket.on("joinRoom", ({ name, roomCode }, reply) => {
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
    room.players.push({ id: playerId, name: playerName, isHost: false });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    const visibleRoom = publicRoom(code);
    reply({ room: visibleRoom, playerId });
    socket.to(code).emit("roomUpdated", visibleRoom);
  });

  socket.on("startGame", (reply) => {
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
    room.phase = "game_started";
    room.round = 1;

    for (const socketId of io.sockets.adapter.rooms.get(roomCode) || []) {
      const playerSocket = io.sockets.sockets.get(socketId);
      const ownPlayer = room.players.find((member) => member.id === playerSocket.data.playerId);
      if (ownPlayer) {
        playerSocket.emit("gameStarted", {
          alias: ownPlayer.alias,
          round: room.round,
          totalRounds: room.settings.totalRounds,
          chatDuration: room.settings.chatDuration
        });
      }
    }
    reply({ ok: true });
  });
});

server.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
