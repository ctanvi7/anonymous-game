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
    if (!room || !room.players.some((player) => player.id === playerId)) {
      return reply({ error: "Room or player not found." });
    }

    socket.join(roomCode);
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
    if (room.players.some((player) => player.name.toLowerCase() === playerName.toLowerCase())) {
      return reply({ error: "That player name is already taken in this room." });
    }

    const playerId = randomUUID();
    room.players.push({ id: playerId, name: playerName, isHost: false });
    socket.join(code);
    const visibleRoom = publicRoom(code);
    reply({ room: visibleRoom, playerId });
    socket.to(code).emit("roomUpdated", visibleRoom);
  });
});

server.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
