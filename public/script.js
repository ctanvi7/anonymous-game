const socket = io();
const home = document.querySelector("#home");
const createScreen = document.querySelector("#create-screen");
const joinScreen = document.querySelector("#join-screen");
const lobby = document.querySelector("#lobby");
const createForm = document.querySelector("#create-form");
const joinForm = document.querySelector("#join-form");
let currentRoomCode;
let currentPlayerId;

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
  home.hidden = true;
  createScreen.hidden = true;
  joinScreen.hidden = true;
  lobby.hidden = false;
}

socket.on("roomUpdated", showLobby);
socket.on("connect", () => {
  if (currentRoomCode && currentPlayerId) {
    socket.emit("enterRoom", { roomCode: currentRoomCode, playerId: currentPlayerId }, (result) => {
      if (result.room) showLobby(result.room);
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
    showLobby(result.room);
  });
});
