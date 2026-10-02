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
let currentRoomCode = localStorage.getItem("roomCode");
let currentReconnectToken = localStorage.getItem("reconnectToken");
let currentIsHost = false;
let currentAlias;
let currentRound;
let countdownInterval;
let matchTransitionTimeout;
let transitionTimeouts = [];
let lastLobbyPlayerNames = null;
const playedSoundEvents = new Set();
const soundToggle = document.querySelector("#sound-toggle");
const soundStorageKey = "behindAliasSoundEnabled";
let soundEnabled = localStorage.getItem(soundStorageKey) !== "off";
let audioContext = null;

const soundPatterns = {
  join: [[660, 0, 0.07]],
  gameStart: [[440, 0, 0.1], [587, 0.12, 0.12]],
  matchFound: [[698, 0, 0.07], [880, 0.09, 0.09]],
  timerTick: [[784, 0, 0.045]],
  timerEnd: [[523, 0, 0.12], [392, 0.14, 0.16]],
  guessLocked: [[587, 0, 0.09]],
  reveal: [[392, 0, 0.11], [523, 0.15, 0.13]],
  correct: [[659, 0, 0.09], [784, 0.11, 0.13]],
  wrong: [[311, 0, 0.17]],
  scoreboard: [[523, 0, 0.07], [659, 0.1, 0.12]],
  gameOver: [[523, 0, 0.09], [659, 0.11, 0.09], [784, 0.23, 0.18]]
};

function updateSoundControl() {
  soundToggle.setAttribute("aria-pressed", String(soundEnabled));
  soundToggle.setAttribute("aria-label", `Sound is ${soundEnabled ? "on" : "off"}`);
  document.querySelector("#sound-state").textContent = soundEnabled ? "ON" : "OFF";
}

function getAudioContext() {
  if (audioContext) return audioContext;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    audioContext = new AudioContextClass();
    return audioContext;
  } catch {
    return null;
  }
}

function unlockAudio() {
  if (!soundEnabled) return;
  const context = getAudioContext();
  if (context?.state === "suspended") context.resume().catch(() => {});
}

function playSound(name) {
  if (!soundEnabled) return;
  const context = audioContext;
  if (!context || context.state !== "running") return;
  const now = context.currentTime;
  for (const [frequency, delay, duration] of soundPatterns[name] || []) {
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    const start = now + delay;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    volume.gain.setValueAtTime(0.0001, start);
    volume.gain.linearRampToValueAtTime(0.035, start + 0.012);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(volume);
    volume.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }
}

function playSoundOnce(eventKey, name) {
  const storageKey = `behindAliasSound:${currentRoomCode || "home"}:${eventKey}`;
  if (playedSoundEvents.has(storageKey) || localStorage.getItem(storageKey) === "1") return;
  playedSoundEvents.add(storageKey);
  localStorage.setItem(storageKey, "1");
  playSound(name);
}

function updateTimerSound(round, seconds) {
  const key = `behindAliasTimerSound:${currentRoomCode}:${round}`;
  const previous = Number(localStorage.getItem(key) || 6);
  if (seconds > 0 && seconds <= 5 && seconds < previous) {
    localStorage.setItem(key, String(seconds));
    playSound("timerTick");
  } else if (seconds === 0 && previous !== 0) {
    localStorage.setItem(key, "0");
    playSoundOnce(`timer-end:${round}`, "timerEnd");
  }
}

function clearTransitionTimers() {
  clearTimeout(matchTransitionTimeout);
  for (const timeout of transitionTimeouts) clearTimeout(timeout);
  transitionTimeouts = [];
}

updateSoundControl();
document.addEventListener("pointerdown", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });
soundToggle.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem(soundStorageKey, soundEnabled ? "on" : "off");
  updateSoundControl();
  if (soundEnabled) unlockAudio();
  else if (audioContext?.state === "running") audioContext.suspend().catch(() => {});
});

function savePlayer() {
  localStorage.setItem("roomCode", currentRoomCode);
  localStorage.setItem("reconnectToken", currentReconnectToken);
}

function setButtonBusy(button, busy) {
  button.setAttribute("aria-busy", String(busy));
  button.disabled = busy;
}

function renderLobby(room, announceJoins = false) {
  const names = new Set(room.players.map((player) => player.name));
  if (announceJoins && lastLobbyPlayerNames) {
    for (const name of names) {
      if (!lastLobbyPlayerNames.has(name)) playSoundOnce(`player-joined:${name}`, "join");
    }
  }
  lastLobbyPlayerNames = names;
  document.querySelector("#room-code").textContent = room.roomCode;
  document.querySelector("#player-count").textContent = `${room.players.length} / 12`;
  const playerList = document.querySelector("#player-list");
  playerList.replaceChildren();
  for (const player of room.players) {
    const item = document.createElement("li");
    const playerName = document.createElement("span");
    playerName.className = "player-name-wrap";
    const connectionDot = document.createElement("span");
    const connectionState = player.left ? "left" : player.connected ? "connected" : "disconnected";
    connectionDot.className = "connection-dot";
    connectionDot.dataset.state = connectionState;
    connectionDot.setAttribute("aria-label", connectionState);
    const name = document.createElement("span");
    name.textContent = player.name;
    playerName.append(connectionDot, name);
    const status = document.createElement("span");
    status.className = "connection-label";
    status.textContent = player.left ? "Left" : player.connected ? "Connected" : "Reconnecting";
    item.append(playerName, status);
    if (player.isHost) {
      const badge = document.createElement("span");
      badge.className = "host-badge";
      badge.textContent = "HOST";
      item.append(badge);
    }
    playerList.append(item);
  }
  document.querySelector("#lobby-duration").textContent = room.settings.chatDuration;
  document.querySelector("#lobby-rounds").textContent = room.settings.totalRounds;
  currentIsHost = Boolean(room.isHost);
  document.querySelector("#start-game").hidden = !currentIsHost;
  document.querySelector("#waiting-for-players").hidden = currentIsHost;
}

function showLobby(room) {
  clearTransitionTimers();
  renderLobby(room);
  setPartnerStatus(null);
  setRoundBlocked(false);
  home.hidden = true;
  createScreen.hidden = true;
  joinScreen.hidden = true;
  lobby.hidden = false;
  document.querySelector("#lobby-title").focus();
}

function setPartnerStatus(status) {
  const banner = document.querySelector("#partner-status");
  banner.textContent = status === "disconnected"
    ? "Your partner disconnected. Waiting for them to reconnect..."
    : status === "left" ? "Your partner left the game." : "";
  banner.hidden = !banner.textContent;
}

function setRoundBlocked(blocked) {
  const controls = document.querySelector("#round-control");
  controls.dataset.blocked = String(blocked);
  controls.hidden = !blocked || !currentIsHost;
  document.querySelector("#skip-round-error").textContent = "";
}

function showMessage(message) {
  const item = document.createElement("p");
  item.className = message.senderAlias === currentAlias ? "message message--mine" : "message";
  const label = document.createElement("strong");
  label.textContent = message.senderAlias === currentAlias ? "You: " : `${message.senderAlias}: `;
  item.append(label, document.createTextNode(message.text));
  document.querySelector("#messages").append(item);
}

function showIdentity(identity, freshStart = false) {
  clearTransitionTimers();
  setPartnerStatus(identity.partnerStatus);
  currentAlias = identity.alias;
  currentRound = identity.round;
  document.querySelector("#match-own-alias").textContent = identity.alias;
  document.querySelector("#match-partner-alias").textContent = identity.partnerAlias;
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
    document.querySelector("#countdown").classList.toggle("is-urgent", seconds <= 10);
    updateTimerSound(identity.round, seconds);
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
  document.querySelector("#messages").scrollTop = document.querySelector("#messages").scrollHeight;
  lobby.hidden = true;
  guessingScreen.hidden = true;
  revealScreen.hidden = true;
  scoreboardScreen.hidden = true;
  gameOverScreen.hidden = true;
  identityScreen.hidden = false;
  const matchFound = document.querySelector("#match-found");
  const activeChat = document.querySelector("#active-chat");
  matchFound.hidden = !freshStart;
  activeChat.hidden = freshStart;
  if (freshStart) {
    playSoundOnce(`game-start:${identity.round}`, "gameStart");
    transitionTimeouts.push(setTimeout(() => playSoundOnce(`match-found:${identity.round}`, "matchFound"), 270));
    document.querySelector("#match-found-title").focus();
    const matchDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 800;
    matchTransitionTimeout = setTimeout(() => {
      matchFound.hidden = true;
      activeChat.hidden = false;
      document.querySelector("#my-alias").focus();
    }, matchDelay);
  } else {
    document.querySelector("#my-alias").focus();
  }
}

function showGuessProgress(progress) {
  document.querySelector("#guess-progress").textContent =
    `${progress.submittedCount} of ${progress.totalPlayers} players have submitted`;
}

function showWaiting() {
  document.querySelector("#guess-choices").hidden = true;
  document.querySelector("#guess-waiting").hidden = false;
  const selected = guessForm.querySelector('input[name="guess"]:checked');
  document.querySelector("#chosen-guess").textContent = selected
    ? `You chose: ${selected.nextElementSibling.textContent}` : "Your guess is locked.";
  document.querySelector("#guess-waiting-title").focus();
}

function showGuessing(state, liveTimerEnd = false) {
  clearTransitionTimers();
  if (liveTimerEnd) playSoundOnce(`timer-end:${state.round}`, "timerEnd");
  currentRound = state.round;
  document.querySelector("#guess-round").textContent = state.round;
  document.querySelector("#guess-rounds").textContent = document.querySelector("#game-rounds").textContent;
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
    label.className = "guess-option";
    const name = document.createElement("span");
    name.textContent = player.name;
    label.append(input, name);
    options.append(label);
  }
  document.querySelector("#guess-error").textContent = "";
  document.querySelector("#guess-choices").hidden = state.submitted;
  document.querySelector("#guess-waiting").hidden = !state.submitted;
  document.querySelector("#chosen-guess").textContent = state.submitted
    ? "Your guess is locked." : "";
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
  document.querySelector(state.submitted ? "#guess-waiting-title" : "#guess-title").focus();
}

function showReveal(result, liveEvent = false) {
  clearTransitionTimers();
  clearInterval(countdownInterval);
  revealScreen.classList.remove("is-sequencing", "reveal-stage-name", "reveal-stage-result", "reveal-stage-outcome", "reveal-stage-ready");
  document.querySelector("#revealed-alias").textContent = result.partnerAlias;
  document.querySelector("#revealed-name").textContent = result.partnerName;
  document.querySelector("#guessed-name").textContent = result.guessedName;
  document.querySelector("#guess-result").textContent = result.correct ? "CORRECT!" : "WRONG!";
  document.querySelector("#guess-result").classList.toggle("is-wrong", !result.correct);
  document.querySelector("#partner-result").textContent = result.partnerCorrect
    ? "Your partner guessed you correctly."
    : "You fooled your partner!";
  document.querySelector("#round-points").textContent = "Your round score is tallied on the scoreboard.";
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
  document.querySelector("#reveal-title").focus();

  const continueButton = document.querySelector("#continue-to-scoreboard");
  continueButton.disabled = false;
  if (!liveEvent) return;

  playSoundOnce(`reveal-start:${currentRound}`, "reveal");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    revealScreen.classList.add("is-sequencing", "reveal-stage-name", "reveal-stage-result", "reveal-stage-outcome", "reveal-stage-ready");
    playSoundOnce(`guess-result:${currentRound}`, result.correct ? "correct" : "wrong");
    return;
  }

  revealScreen.classList.add("is-sequencing");
  continueButton.disabled = true;
  transitionTimeouts.push(setTimeout(() => revealScreen.classList.add("reveal-stage-name"), 420));
  transitionTimeouts.push(setTimeout(() => {
    revealScreen.classList.add("reveal-stage-result");
    playSoundOnce(`guess-result:${currentRound}`, result.correct ? "correct" : "wrong");
  }, 920));
  transitionTimeouts.push(setTimeout(() => revealScreen.classList.add("reveal-stage-outcome"), 1380));
  transitionTimeouts.push(setTimeout(() => {
    revealScreen.classList.add("reveal-stage-ready");
    continueButton.disabled = false;
  }, 1760));
}

function showScoreboard(scoreboard, liveEvent = false) {
  clearTransitionTimers();
  setRoundBlocked(false);
  currentRound = scoreboard.round;
  document.querySelector("#round-complete").textContent = `Round ${scoreboard.round} Complete`;
  document.querySelector("#scoreboard-round").textContent =
    `Round ${scoreboard.round} of ${scoreboard.totalRounds}`;
  const rows = document.querySelector("#scoreboard-rows");
  rows.replaceChildren();
  scoreboard.rows.forEach((player, index) => {
    const row = document.createElement("tr");
    [index + 1, player.name, `+${player.roundScore}`, player.totalScore].forEach((value, cellIndex) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      cell.dataset.label = ["Rank", "Player", "Round points", "Total points"][cellIndex];
      row.append(cell);
    });
    rows.append(row);
  });
  const nextRoundButton = document.querySelector("#next-round");
  nextRoundButton.hidden = !scoreboard.isHost;
  nextRoundButton.disabled = false;
  const waiting = document.querySelector("#waiting-for-host");
  waiting.hidden = scoreboard.isHost;
  waiting.textContent = "Waiting for host to start the next round...";
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
  document.querySelector("#round-complete").focus();
  scoreboardScreen.classList.toggle("is-entering", liveEvent);
  if (liveEvent) playSoundOnce(`scoreboard:${scoreboard.round}`, "scoreboard");
}

function showGameOver(results, liveEvent = false) {
  clearTransitionTimers();
  setRoundBlocked(false);
  setPartnerStatus(null);
  clearInterval(countdownInterval);
  document.querySelector("#winner-label").textContent =
    results.winners.length === 1 ? "Winner:" : "WINNERS";
  document.querySelector("#winners").textContent = results.winners.join(" & ");
  const rows = document.querySelector("#final-rows");
  rows.replaceChildren();
  results.rows.forEach((player, index) => {
    const row = document.createElement("tr");
    [index + 1, player.name, `+${player.roundScore}`, player.totalScore,
      player.correctGuesses, player.timesFooledPartner].forEach((value, cellIndex) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      cell.dataset.label = ["Rank", "Player", "Round score", "Total score", "Correct guesses", "Times fooled"][cellIndex];
      row.append(cell);
    });
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
  document.querySelector("#game-over-title").focus();
  gameOverScreen.classList.toggle("is-entering", liveEvent);
  if (liveEvent) playSoundOnce("game-over", "gameOver");
}

socket.on("roomUpdated", (room) => {
  if (!lobby.hidden) renderLobby(room, true);
  else currentIsHost = Boolean(room.isHost);
});
socket.on("gameStarted", (identity) => showIdentity(identity, true));
socket.on("chatMessage", showMessage);
socket.on("chatEnded", (state) => showGuessing(state, true));
socket.on("guessProgress", showGuessProgress);
socket.on("revealResult", (result) => showReveal(result, true));
socket.on("scoreboardReady", (scoreboard) => showScoreboard(scoreboard, true));
socket.on("gameOver", (results) => showGameOver(results, true));
socket.on("partnerStatus", setPartnerStatus);
socket.on("roundBlocked", () => setRoundBlocked(true));
socket.on("hostStatus", (state) => {
  currentIsHost = state.isHost;
  document.querySelector("#start-game").hidden = !currentIsHost;
  document.querySelector("#waiting-for-players").hidden = currentIsHost;
  const scoreboard = document.querySelector("#scoreboard-screen");
  if (!scoreboard.hidden) {
    const next = document.querySelector("#next-round");
    next.hidden = !currentIsHost;
    document.querySelector("#waiting-for-host").hidden = currentIsHost;
  }
  setRoundBlocked(document.querySelector("#round-control").dataset.blocked === "true");
});
socket.on("connect", () => {
  if (currentRoomCode && currentReconnectToken) {
    socket.emit("enterRoom", { roomCode: currentRoomCode, reconnectToken: currentReconnectToken }, (result) => {
      if (result.isHost !== undefined) currentIsHost = result.isHost;
      setPartnerStatus(result.partnerStatus);
      setRoundBlocked(Boolean(result.roundBlocked));
      if (result.room) showLobby(result.room);
      if (result.identity) showIdentity(result.identity);
      if (result.guessing) showGuessing(result.guessing);
      if (result.reveal) showReveal(result.reveal);
      if (result.scoreboard) showScoreboard(result.scoreboard);
      if (result.gameOver) showGameOver(result.gameOver);
      if (result.error) {
        localStorage.removeItem("roomCode");
        localStorage.removeItem("reconnectToken");
        currentRoomCode = currentReconnectToken = null;
        window.location.reload();
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

document.querySelectorAll("[data-go-home]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    home.hidden = false;
    createScreen.hidden = true;
    joinScreen.hidden = true;
    document.querySelector("#home-title").focus();
  });
});

document.querySelectorAll('.site-footer a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => event.preventDefault());
});

document.querySelector("#copy-room-code").addEventListener("click", async () => {
  const feedback = document.querySelector("#copy-feedback");
  try {
    await navigator.clipboard.writeText(document.querySelector("#room-code").textContent);
    feedback.textContent = "Copied.";
  } catch {
    feedback.textContent = "Select the code to copy it.";
  }
});

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = createForm.elements.namedItem("name").value.trim();
  const error = document.querySelector("#form-error");
  const submitButton = createForm.querySelector('button[type="submit"]');
  error.textContent = "";
  if (!name) {
    error.textContent = "Please enter your name.";
    return;
  }

  setButtonBusy(submitButton, true);
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
    currentReconnectToken = created.reconnectToken;
    savePlayer();
    socket.emit("enterRoom", { roomCode: currentRoomCode, reconnectToken: currentReconnectToken }, (result) => {
      setButtonBusy(submitButton, false);
      if (result.error) error.textContent = result.error;
      else showLobby(result.room);
    });
  } catch (problem) {
    setButtonBusy(submitButton, false);
    error.textContent = problem.message;
  }
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = joinForm.elements.namedItem("name").value.trim();
  const roomCode = joinForm.elements.namedItem("roomCode").value.trim().toUpperCase();
  const error = document.querySelector("#join-error");
  const submitButton = joinForm.querySelector('button[type="submit"]');
  error.textContent = "";
  if (!name) {
    error.textContent = "Please enter your name.";
    return;
  }

  setButtonBusy(submitButton, true);
  socket.emit("joinRoom", { name, roomCode }, (result) => {
    setButtonBusy(submitButton, false);
    if (result.error) {
      error.textContent = result.error;
      return;
    }
    currentRoomCode = result.room.roomCode;
    currentReconnectToken = result.reconnectToken;
    savePlayer();
    showLobby(result.room);
  });
});

document.querySelector("#start-game").addEventListener("click", () => {
  const error = document.querySelector("#start-error");
  const button = document.querySelector("#start-game");
  error.textContent = "";
  setButtonBusy(button, true);
  socket.emit("startGame", (result) => {
    setButtonBusy(button, false);
    if (result.error) error.textContent = result.error;
  });
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#message-input");
  const sendButton = chatForm.querySelector('button[type="submit"]');
  if (sendButton.disabled) return;
  const error = document.querySelector("#chat-error");
  error.textContent = "";
  setButtonBusy(sendButton, true);
  socket.emit("sendMessage", input.value, (result) => {
    setButtonBusy(sendButton, false);
    sendButton.disabled = input.disabled;
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
  const submitButton = guessForm.querySelector('button[type="submit"]');
  setButtonBusy(submitButton, true);
  socket.emit("submitGuess", selected.value, currentRound, (result) => {
    if (result.error) {
      setButtonBusy(submitButton, false);
      error.textContent = result.error;
    } else {
      playSoundOnce(`guess-locked:${currentRound}`, "guessLocked");
      if (!result.reveal) showWaiting();
    }
  });
});

document.querySelector("#continue-to-scoreboard").addEventListener("click", () => {
  const error = document.querySelector("#reveal-error");
  const button = document.querySelector("#continue-to-scoreboard");
  error.textContent = "";
  setButtonBusy(button, true);
  socket.emit("continueToScoreboard", (result) => {
    setButtonBusy(button, false);
    if (result.error) error.textContent = result.error;
    if (result.scoreboard) showScoreboard(result.scoreboard);
    if (result.gameOver) showGameOver(result.gameOver);
  });
});

document.querySelector("#next-round").addEventListener("click", () => {
  const error = document.querySelector("#next-round-error");
  const button = document.querySelector("#next-round");
  error.textContent = "";
  setButtonBusy(button, true);
  socket.emit("nextRound", (result) => {
    setButtonBusy(button, false);
    if (result.error) error.textContent = result.error;
  });
});

document.querySelector("#back-home").addEventListener("click", () => {
  localStorage.removeItem("roomCode");
  localStorage.removeItem("reconnectToken");
  window.location.reload();
});

document.querySelector("#skip-round").addEventListener("click", () => {
  const error = document.querySelector("#skip-round-error");
  const button = document.querySelector("#skip-round");
  error.textContent = "";
  setButtonBusy(button, true);
  socket.emit("skipRound", (result) => {
    setButtonBusy(button, false);
    if (result.error) error.textContent = result.error;
    else setRoundBlocked(false);
  });
});
