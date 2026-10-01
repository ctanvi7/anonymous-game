const express = require("express");
const path = require("path");
const { randomInt } = require("crypto");

const app = express();
const port = 3000;
const rooms = {};
const codeCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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

  rooms[roomCode] = {
    hostName: name,
    players: [{ name, isHost: true }],
    settings: { chatDuration, totalRounds },
    round: 0,
    phase: "lobby"
  };

  res.status(201).json({ roomCode, hostName: name, chatDuration, totalRounds });
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
