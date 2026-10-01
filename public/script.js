const home = document.querySelector("#home");
const createScreen = document.querySelector("#create-screen");
const lobby = document.querySelector("#lobby");
const form = document.querySelector("#create-form");

document.querySelector("#show-create-form").addEventListener("click", () => {
  home.hidden = true;
  createScreen.hidden = false;
  document.querySelector("#player-name").focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = form.elements.namedItem("name").value.trim();
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
        chatDuration: Number(form.elements.namedItem("chatDuration").value),
        totalRounds: Number(form.elements.namedItem("totalRounds").value)
      })
    });
    const room = await response.json();
    if (!response.ok) throw new Error(room.error || "Could not create room.");

    document.querySelector("#room-code").textContent = room.roomCode;
    const player = document.createElement("li");
    player.textContent = `${room.hostName} `;
    const badge = document.createElement("span");
    badge.className = "host-badge";
    badge.textContent = "Host";
    player.append(badge);
    document.querySelector("#player-list").append(player);
    document.querySelector("#lobby-duration").textContent = room.chatDuration;
    document.querySelector("#lobby-rounds").textContent = room.totalRounds;
    createScreen.hidden = true;
    lobby.hidden = false;
  } catch (problem) {
    error.textContent = problem.message;
  }
});
