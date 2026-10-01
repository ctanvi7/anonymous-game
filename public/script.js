const socket = io();
const home = document.querySelector("#home");
const createScreen = document.querySelector("#create-screen");
const joinScreen = document.querySelector("#join-screen");
const lobby = document.querySelector("#lobby");
const identityScreen = document.querySelector("#identity-screen");
const guessingScreen = document.querySelector("#guessing-screen");
const revealScreen = document.querySelector("#reveal-screen");
const scoreboardScreen = document.querySelector("#scoreboard-screen");
const gameOverScreen = document.querySelector("#game-over-screen");
const createForm = document.querySelector("#create-form");
const joinForm = document.querySelector("#join-form");
const chatForm = document.querySelector("#chat-form");
const guessForm = document.querySelector("#guess-form");
let currentRoomCode = sessionStorage.getItem("roomCode");
let currentPlayerId = sessionStorage.getItem("playerId");
let currentPlayerName = sessionStorage.getItem("playerName");
let currentAlias;
let currentRound;
let countdownInterval;

function savePlayer() {
  sessionStorage.setItem("roomCode", currentRoomCode);
  sessionStorage.setItem("playerId", currentPlayerId);
  sessionStorage.setItem("playerName", currentPlayerName);
}

function showLobby(room) {
  document.querySelector("#room-code").textContent = room.roomCode;
  const playerList = document.querySelector("#player-list");
  playerList.replaceChildren();
  for (const player of room.players) {
    const item = document.createElement("li");
    item.textContent = `${player.name} `;
    if (player.isHost) {
      const badge = document.createElement("span");
      badge.className = "host-badge";
      badge.textContent = "Host";
      item.append(badge);
    }
    playerList.append(item);
  }
  document.querySelector("#lobby-duration").textContent = room.settings.chatDuration;
  document.querySelector("#lobby-rounds").textContent = room.settings.totalRounds;
  document.querySelector("#start-game").hidden = !room.players.some((player) => player.isHost && player.name === currentPlayerName);
  home.hidden = true;
  createScreen.hidden = true;
  joinScreen.hidden = true;
  lobby.hidden = false;
}

function showMessage(message) {
  const item = document.createElement("p");
  const label = document.createElement("strong");
  label.textContent = message.senderAlias === currentAlias ? "You: " : `${message.senderAlias}: `;
  item.append(label, document.createTextNode(message.text));
  document.querySelector("#messages").append(item);
}

function showIdentity(identity) {
  currentAlias = identity.alias;
  currentRound = identity.round;
  document.querySelector("#my-alias").textContent = identity.alias;
  document.querySelector("#partner-alias").textContent = identity.partnerAlias;
  document.querySelector("#current-round").textContent = identity.round;
  document.querySelector("#game-rounds").textContent = identity.totalRounds;
  document.querySelector("#game-duration").textContent = identity.chatDuration;
  const messageInput = document.querySelector("#message-input");
  messageInput.value = "";
  document.querySelector("#chat-error").textContent = "";
  messageInput.disabled = false;
  chatForm.querySelector("button").disabled = false;
  clearInterval(countdownInterval);
  const localDeadline = Date.now() + Math.max(0, identity.chatEndsAt - identity.serverNow);
  function updateCountdown() {
    const seconds = Math.max(0, Math.ceil((localDeadline - Date.now()) / 1000));
    document.querySelector("#countdown").textContent =
      `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    if (seconds === 0) {
      messageInput.disabled = true;
      chatForm.querySelector("button").disabled = true;
      clearInterval(countdownInterval);
    }
  }
  updateCountdown();
  if (localDeadline > Date.now()) countdownInterval = setInterval(updateCountdown, 250);
  document.querySelector("#messages").replaceChildren();
  for (const message of identity.messages) showMessage(message);
  lobby.hidden = true;
  guessingScreen.hidden = true;
  revealScreen.hidden = true;
  scoreboardScreen.hidden = true;
  gameOverScreen.hidden = true;
  identityScreen.hidden = false;
}

function showGuessProgress(progress) {
  document.querySelector("#guess-progress").textContent =
    `${progress.submittedCount} of ${progress.totalPlayers} players have submitted`;
}

function showWaiting() {
  document.querySelector("#guess-choices").hidden = true;
  document.querySelector("#guess-waiting").hidden = false;
}

function showGuessing(state) {
  currentRound = state.round;
  clearInterval(countdownInterval);
  document.querySelector("#message-input").disabled = true;
  chatForm.querySelector("button").disabled = true;
  const options = document.querySelector("#guess-options");
  options.replaceChildren();
  for (const player of state.options) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "guess";
    input.value = player.id;
    label.append(input, document.createTextNode(` ${player.name}`));
    options.append(label, document.createElement("br"));
  }
  document.querySelector("#guess-error").textContent = "";
  document.querySelector("#guess-choices").hidden = state.submitted;
  document.querySelector("#guess-waiting").hidden = !state.submitted;
  showGuessProgress(state);
  home.hidden = true;
  createScreen.hidden = true;
  joinScreen.hidden = true;
  lobby.hidden = true;
  identityScreen.hidden = true;
  revealScreen.hidden = true;
  scoreboardScreen.hidden = true;
  gameOverScreen.hidden = true;
  guessingScreen.hidden = false;
}

function showReveal(result) {
  clearInterval(countdownInterval);
  document.querySelector("#revealed-alias").textContent = result.partnerAlias;
  document.querySelector("#revealed-name").textContent = result.partnerName;
  document.querySelector("#guessed-name").textContent = result.guessedName;
  document.querySelector("#guess-result").textContent = result.correct ? "CORRECT!" : "WRONG!";
  document.querySelector("#partner-result").textContent = result.partnerCorrect
    ? "Your partner guessed you correctly."
    : "You fooled your partner!";
  document.querySelector("#message-input").disabled = true;
  chatForm.querySelector("button").disabled = true;
  home.hidden = true;
  createScreen.hidden = true;
  joinScreen.hidden = true;
  lobby.hidden = true;
  identityScreen.hidden = true;
  guessingScreen.hidden = true;
  scoreboardScreen.hidden = true;
  gameOverScreen.hidden = true;
  revealScreen.hidden = false;
}

function showScoreboard(scoreboard) {
  currentRound = scoreboard.round;
  document.querySelector("#round-complete").textContent = `Round ${scoreboard.round} Complete`;
  document.querySelector("#scoreboard-round").textContent =
    `Round ${scoreboard.round} of ${scoreboard.totalRounds}`;
  const rows = document.querySelector("#scoreboard-rows");
  rows.replaceChildren();
  scoreboard.rows.forEach((player, index) => {
    const row = document.createElement("tr");
    for (const value of [index + 1, player.name, `+${player.roundScore}`, player.totalScore]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    rows.append(row);
  });
  const nextRoundButton = document.querySelector("#next-round");
  nextRoundButton.hidden = !scoreboard.isHost;
  nextRoundButton.disabled = scoreboard.round >= scoreboard.totalRounds;
  const waiting = document.querySelector("#waiting-for-host");
  waiting.hidden = scoreboard.isHost;
  waiting.textContent = scoreboard.round < scoreboard.totalRounds
    ? "Waiting for host to start the next round..."
    : "All rounds complete.";
  document.querySelector("#next-round-error").textContent = "";
  home.hidden = true;
  createScreen.hidden = true;
  joinScreen.hidden = true;
  lobby.hidden = true;
  identityScreen.hidden = true;
  guessingScreen.hidden = true;
  revealScreen.hidden = true;
  gameOverScreen.hidden = true;
  scoreboardScreen.hidden = false;
}

function showGameOver(results) {
  clearInterval(countdownInterval);
  document.querySelector("#winner-label").textContent =
    results.winners.length === 1 ? "Winner:" : "WINNERS";
  document.querySelector("#winners").textContent = results.winners.join(" & ");
  const rows = document.querySelector("#final-rows");
  rows.replaceChildren();
  results.rows.forEach((player, index) => {
    const row = document.createElement("tr");
    for (const value of [index + 1, player.name, `+${player.roundScore}`, player.totalScore,
      player.correctGuesses, player.timesFooledPartner]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    rows.append(row);
  });
  document.querySelector("#best-detectives").textContent = results.bestDetectives.join(" & ");
  document.querySelector("#most-mysterious").textContent = results.mostMysterious.join(" & ");
  home.hidden = true;
  createScreen.hidden = true;
  joinScreen.hidden = true;
  lobby.hidden = true;
  identityScreen.hidden = true;
  guessingScreen.hidden = true;
  revealScreen.hidden = true;
  scoreboardScreen.hidden = true;
  gameOverScreen.hidden = false;
}

socket.on("roomUpdated", showLobby);
socket.on("gameStarted", showIdentity);
socket.on("chatMessage", showMessage);
socket.on("chatEnded", showGuessing);
socket.on("guessProgress", showGuessProgress);
socket.on("revealResult", showReveal);
socket.on("scoreboardReady", showScoreboard);
socket.on("gameOver", showGameOver);
socket.on("connect", () => {
  if (currentRoomCode && currentPlayerId) {
    socket.emit("enterRoom", { roomCode: currentRoomCode, playerId: currentPlayerId }, (result) => {
      if (result.room) showLobby(result.room);
      if (result.identity) showIdentity(result.identity);
      if (result.guessing) showGuessing(result.guessing);
      if (result.reveal) showReveal(result.reveal);
      if (result.scoreboard) showScoreboard(result.scoreboard);
      if (result.gameOver) showGameOver(result.gameOver);
      if (result.error) {
        sessionStorage.removeItem("roomCode");
        sessionStorage.removeItem("playerId");
        sessionStorage.removeItem("playerName");
        currentRoomCode = currentPlayerId = currentPlayerName = null;
      }
    });
  }
});

document.querySelector("#show-create-form").addEventListener("click", () => {
  home.hidden = true;
  createScreen.hidden = false;
  document.querySelector("#player-name").focus();
});

document.querySelector("#show-join-form").addEventListener("click", () => {
  home.hidden = true;
  joinScreen.hidden = false;
  document.querySelector("#join-name").focus();
});

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = createForm.elements.namedItem("name").value.trim();
  const error = document.querySelector("#form-error");
  error.textContent = "";
  if (!name) {
    error.textContent = "Please enter your name.";
    return;
  }

  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        chatDuration: Number(createForm.elements.namedItem("chatDuration").value),
        totalRounds: Number(createForm.elements.namedItem("totalRounds").value)
      })
    });
    const created = await response.json();
    if (!response.ok) throw new Error(created.error || "Could not create room.");

    currentRoomCode = created.roomCode;
    currentPlayerId = created.playerId;
    currentPlayerName = name;
    savePlayer();
    socket.emit("enterRoom", { roomCode: currentRoomCode, playerId: currentPlayerId }, (result) => {
      if (result.error) error.textContent = result.error;
      else showLobby(result.room);
    });
  } catch (problem) {
    error.textContent = problem.message;
  }
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = joinForm.elements.namedItem("name").value.trim();
  const roomCode = joinForm.elements.namedItem("roomCode").value.trim().toUpperCase();
  const error = document.querySelector("#join-error");
  error.textContent = "";
  if (!name) {
    error.textContent = "Please enter your name.";
    return;
  }

  socket.emit("joinRoom", { name, roomCode }, (result) => {
    if (result.error) {
      error.textContent = result.error;
      return;
    }
    currentRoomCode = result.room.roomCode;
    currentPlayerId = result.playerId;
    currentPlayerName = name;
    savePlayer();
    showLobby(result.room);
  });
});

document.querySelector("#start-game").addEventListener("click", () => {
  const error = document.querySelector("#start-error");
  error.textContent = "";
  socket.emit("startGame", (result) => {
    if (result.error) error.textContent = result.error;
  });
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#message-input");
  const error = document.querySelector("#chat-error");
  error.textContent = "";
  socket.emit("sendMessage", input.value, currentRound, (result) => {
    if (result.error) error.textContent = result.error;
    else input.value = "";
  });
});

guessForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const selected = guessForm.querySelector('input[name="guess"]:checked');
  const error = document.querySelector("#guess-error");
  error.textContent = "";
  if (!selected) {
    error.textContent = "Choose a player before submitting.";
    return;
  }
  socket.emit("submitGuess", selected.value, currentRound, (result) => {
    if (result.error) error.textContent = result.error;
    else if (!result.reveal) showWaiting();
  });
});

document.querySelector("#continue-to-scoreboard").addEventListener("click", () => {
  const error = document.querySelector("#reveal-error");
  error.textContent = "";
  socket.emit("continueToScoreboard", (result) => {
    if (result.error) error.textContent = result.error;
    if (result.scoreboard) showScoreboard(result.scoreboard);
    if (result.gameOver) showGameOver(result.gameOver);
  });
});

document.querySelector("#next-round").addEventListener("click", () => {
  const error = document.querySelector("#next-round-error");
  error.textContent = "";
  socket.emit("nextRound", (result) => {
    if (result.error) error.textContent = result.error;
  });
});

document.querySelector("#back-home").addEventListener("click", () => {
  sessionStorage.removeItem("roomCode");
  sessionStorage.removeItem("playerId");
  sessionStorage.removeItem("playerName");
  window.location.reload();
});
