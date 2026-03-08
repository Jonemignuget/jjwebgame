const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const statsEl = document.getElementById("stats");
const inventoryEl = document.getElementById("inventory");
const messageEl = document.getElementById("message");
const nameInput = document.getElementById("nameInput");
const setNameBtn = document.getElementById("setNameBtn");
const selectedSeedEl = document.getElementById("selectedSeed");
const adminPanelEl = document.getElementById("adminPanel");
const adminPlayersEl = document.getElementById("adminPlayers");
const clearCropsBtn = document.getElementById("clearCropsBtn");
const respawnTreasuresBtn = document.getElementById("respawnTreasuresBtn");

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsProtocol}://${location.host}`);

const state = {
  yourId: null,
  world: null,
  crops: {},
  players: [],
  farmSlots: [],
  plots: [],
  treasures: [],
  selectedSeed: "carrot",
  isAdmin: false,
  connected: false,
  message: ""
};

const keys = new Set();
let lastMoveAt = 0;

function send(payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function showMessage(text) {
  state.message = text;
  messageEl.textContent = text;
}

function playerById(id) {
  return state.players.find((p) => p.id === id) || null;
}

function yourPlayer() {
  return playerById(state.yourId);
}

function keyToMove() {
  let dx = 0;
  let dy = 0;
  if (keys.has("ArrowLeft") || keys.has("a") || keys.has("A")) dx -= 1;
  if (keys.has("ArrowRight") || keys.has("d") || keys.has("D")) dx += 1;
  if (keys.has("ArrowUp") || keys.has("w") || keys.has("W")) dy -= 1;
  if (keys.has("ArrowDown") || keys.has("s") || keys.has("S")) dy += 1;
  return { dx, dy };
}

function drawTile(x, y, size, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x * size, y * size, size, size);
}

function drawWorld() {
  if (!state.world) {
    return;
  }

  const { width, height, tileSize, lobby, exits } = state.world;
  canvas.width = width * tileSize;
  canvas.height = height * tileSize;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      drawTile(x, y, tileSize, "#2f6f3b");
    }
  }

  for (const slot of state.farmSlots) {
    for (let y = slot.y; y < slot.y + slot.h; y++) {
      for (let x = slot.x; x < slot.x + slot.w; x++) {
        const isBorder = x === slot.x || x === slot.x + slot.w - 1 || y === slot.y || y === slot.y + slot.h - 1;
        if (isBorder) {
          drawTile(x, y, tileSize, "#6e4b2f");
        } else {
          drawTile(x, y, tileSize, "#7f5a38");
        }
      }
    }
  }

  for (let y = lobby.y; y < lobby.y + lobby.h; y++) {
    for (let x = lobby.x; x < lobby.x + lobby.w; x++) {
      const isBorder = x === lobby.x || x === lobby.x + lobby.w - 1 || y === lobby.y || y === lobby.y + lobby.h - 1;
      const isLeftExit = x === exits.left.x && y >= exits.left.y1 && y <= exits.left.y2;
      const isRightExit = x === exits.right.x && y >= exits.right.y1 && y <= exits.right.y2;
      if (isBorder && !(isLeftExit || isRightExit)) {
        drawTile(x, y, tileSize, "#58616e");
      } else {
        drawTile(x, y, tileSize, "#9aa7b8");
      }
    }
  }

  for (let y = exits.left.y1; y <= exits.left.y2; y++) {
    drawTile(exits.left.x, y, tileSize, "#d9f2ff");
  }
  for (let y = exits.right.y1; y <= exits.right.y2; y++) {
    drawTile(exits.right.x, y, tileSize, "#d9f2ff");
  }

  ctx.strokeStyle = "rgba(0,0,0,0.13)";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      ctx.strokeRect(x * tileSize, y * tileSize, tileSize, tileSize);
    }
  }

  ctx.fillStyle = "#ffffff";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("LOBBY", (lobby.x + lobby.w / 2) * tileSize, (lobby.y - 0.3) * tileSize);

  state.farmSlots.forEach((slot) => {
    const owner = playerById(slot.ownerId);
    const ownerName = owner ? owner.name : "Unclaimed";
    ctx.fillStyle = owner ? "#ffe9a7" : "#d6d6d6";
    ctx.fillText(
      `Plot ${slot.id} - ${ownerName}`,
      (slot.x + slot.w / 2) * tileSize,
      (slot.y - 0.2) * tileSize
    );
  });
}

function drawPlots() {
  if (!state.world) return;
  const tileSize = state.world.tileSize;

  for (const plot of state.plots) {
    const crop = state.crops[plot.cropType];
    const px = plot.x * tileSize;
    const py = plot.y * tileSize;

    ctx.fillStyle = "#5e3d24";
    ctx.fillRect(px + 2, py + 2, tileSize - 4, tileSize - 4);

    const g = Math.max(0, Math.min(1, plot.growth));
    if (g < 0.33) {
      ctx.fillStyle = crop?.colorSeed || "#8a5a2b";
      ctx.fillRect(px + tileSize / 2 - 2, py + tileSize / 2 - 2, 4, 4);
    } else if (g < 1) {
      ctx.fillStyle = crop?.colorSprout || "#4fbf4f";
      ctx.fillRect(px + tileSize / 2 - 2, py + 6, 4, tileSize - 12);
      ctx.fillRect(px + tileSize / 2 - 6, py + 8, 4, 4);
      ctx.fillRect(px + tileSize / 2 + 2, py + 8, 4, 4);
    } else {
      ctx.fillStyle = crop?.colorReady || "#ff8b2b";
      ctx.fillRect(px + tileSize / 2 - 6, py + tileSize / 2 - 6, 12, 12);
    }
  }
}

function drawTreasures() {
  if (!state.world) return;
  const tileSize = state.world.tileSize;

  for (const t of state.treasures) {
    const px = t.x * tileSize;
    const py = t.y * tileSize;

    ctx.fillStyle = "#f4d35e";
    ctx.fillRect(px + 3, py + 3, tileSize - 6, tileSize - 6);
    ctx.strokeStyle = "#9a7b1f";
    ctx.strokeRect(px + 3, py + 3, tileSize - 6, tileSize - 6);
  }
}

function drawPlayers() {
  if (!state.world) return;
  const tileSize = state.world.tileSize;

  for (const p of state.players) {
    const px = p.x * tileSize;
    const py = p.y * tileSize;

    ctx.fillStyle = p.id === state.yourId ? "#ffffff" : p.color;
    ctx.fillRect(px + 2, py + 2, tileSize - 4, tileSize - 4);

    ctx.strokeStyle = "#000000";
    ctx.strokeRect(px + 2, py + 2, tileSize - 4, tileSize - 4);

    const tag = p.isAdmin ? `[ADMIN] ${p.name}` : p.name;
    ctx.fillStyle = "#ffffff";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(tag, px + tileSize / 2, py - 2);
  }
}

function updatePanels() {
  const you = yourPlayer();
  if (!you) {
    statsEl.innerHTML = "Waiting for player state...";
    inventoryEl.innerHTML = "";
    selectedSeedEl.textContent = "Selected seed: carrot";
    adminPanelEl.classList.add("hidden");
    return;
  }

  state.isAdmin = Boolean(you.isAdmin);

  statsEl.innerHTML = [
    `Name: <b>${you.name}</b>${you.isAdmin ? " (ADMIN)" : ""}`,
    `Money: <b>$${you.money}</b>`,
    `Harvested: <b>${you.harvested}</b>`,
    `Gear: <b>${you.inventory.gear}</b>`,
    `Farm slot: <b>${you.farmSlotId || "None"}</b>`,
    `Online players: <b>${state.players.length}</b>`
  ].join("<br>");

  inventoryEl.innerHTML = [
    `<b>Inventory</b>`,
    `Carrot Seeds: <b>${you.inventory.carrotSeed}</b> (press 1)`,
    `Pumpkin Seeds: <b>${you.inventory.pumpkinSeed}</b> (press 2)`
  ].join("<br>");

  selectedSeedEl.textContent = `Selected seed: ${state.selectedSeed}`;

  if (!state.isAdmin) {
    adminPanelEl.classList.add("hidden");
    adminPlayersEl.innerHTML = "";
    return;
  }

  adminPanelEl.classList.remove("hidden");
  adminPlayersEl.innerHTML = state.players
    .filter((p) => p.id !== state.yourId)
    .map((p) => `<div class="admin-row"><span>${p.name}</span><button data-kick="${p.id}">Kick</button></div>`)
    .join("");

  adminPlayersEl.querySelectorAll("button[data-kick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = Number(btn.getAttribute("data-kick"));
      send({ type: "admin", action: "kick_player", targetId });
    });
  });
}

function render() {
  if (!state.world) {
    return;
  }
  drawWorld();
  drawPlots();
  drawTreasures();
  drawPlayers();
  updatePanels();
}

function gameLoop() {
  const now = performance.now();
  const move = keyToMove();

  if ((move.dx !== 0 || move.dy !== 0) && now - lastMoveAt > 90) {
    send({ type: "move", dx: move.dx, dy: move.dy });
    lastMoveAt = now;
  }

  render();
  requestAnimationFrame(gameLoop);
}

window.addEventListener("keydown", (e) => {
  keys.add(e.key);

  if (e.key === "1") {
    state.selectedSeed = "carrot";
    send({ type: "select_seed", cropType: "carrot" });
  }

  if (e.key === "2") {
    state.selectedSeed = "pumpkin";
    send({ type: "select_seed", cropType: "pumpkin" });
  }

  const you = yourPlayer();
  if (!you) {
    return;
  }

  if (e.key === "e" || e.key === "E") {
    send({ type: "plant", x: you.x, y: you.y, cropType: state.selectedSeed });
  }

  if (e.key === "f" || e.key === "F") {
    send({ type: "harvest", x: you.x, y: you.y });
  }

  if (e.key === "g" || e.key === "G") {
    send({ type: "gather" });
  }
});

window.addEventListener("keyup", (e) => {
  keys.delete(e.key);
});

setNameBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) {
    return;
  }
  send({ type: "rename", name });
});

clearCropsBtn.addEventListener("click", () => {
  send({ type: "admin", action: "clear_crops" });
});

respawnTreasuresBtn.addEventListener("click", () => {
  send({ type: "admin", action: "clear_treasures" });
});

ws.addEventListener("open", () => {
  state.connected = true;
  showMessage("Connected. Set your name and start exploring.");
  gameLoop();
});

ws.addEventListener("close", () => {
  state.connected = false;
  showMessage("Disconnected from server.");
});

ws.addEventListener("message", (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }

  if (msg.type === "welcome") {
    state.yourId = msg.yourId;
    state.world = msg.world;
    state.crops = msg.crops || {};
    if (msg.note) {
      showMessage(msg.note);
    }
  }

  if (msg.type === "state") {
    state.world = msg.world;
    state.players = msg.players || [];
    state.farmSlots = msg.farmSlots || [];
    state.plots = msg.plots || [];
    state.treasures = msg.treasures || [];
  }

  if (msg.type === "rename_ok") {
    showMessage(`Name set to ${msg.name}${msg.isAdmin ? " (ADMIN)" : ""}.`);
  }

  if (msg.type === "error") {
    showMessage(msg.message || "Action failed.");
  }

  if (msg.type === "info") {
    showMessage(msg.message || "Done.");
  }

  if (msg.type === "kicked") {
    showMessage(msg.reason || "You were kicked.");
    ws.close();
  }
});
