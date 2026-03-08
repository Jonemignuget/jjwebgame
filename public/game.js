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
  message: ""
};

const keys = new Set();
let lastMoveAt = 0;
const camera = { x: 0, y: 0 };

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

function isInRect(x, y, rect) {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

function isFarmTile(x, y) {
  return state.farmSlots.some((slot) => isInRect(x, y, slot));
}

function isForestTile(x, y) {
  return Boolean(state.world) && !isInRect(x, y, state.world.lobby) && !isFarmTile(x, y);
}

function tileHash(x, y) {
  let n = x * 374761393 + y * 668265263;
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return (n ^ (n >>> 16)) >>> 0;
}

function resizeCanvas() {
  const targetW = Math.min(1400, window.innerWidth - 380);
  const width = Math.max(700, targetW);
  const height = Math.max(500, Math.floor(window.innerHeight - 40));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
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

function worldToScreen(wx, wy, tileSize) {
  return {
    x: wx * tileSize - camera.x,
    y: wy * tileSize - camera.y
  };
}

function updateCamera() {
  const you = yourPlayer();
  if (!you || !state.world) {
    return;
  }

  const tileSize = state.world.tileSize;
  const worldPxW = state.world.width * tileSize;
  const worldPxH = state.world.height * tileSize;

  const targetX = you.x * tileSize - canvas.width / 2 + tileSize / 2;
  const targetY = you.y * tileSize - canvas.height / 2 + tileSize / 2;

  camera.x = Math.max(0, Math.min(targetX, Math.max(0, worldPxW - canvas.width)));
  camera.y = Math.max(0, Math.min(targetY, Math.max(0, worldPxH - canvas.height)));
}

function drawTreeAtTile(x, y, tileSize) {
  const p = worldToScreen(x, y, tileSize);
  const tx = p.x;
  const ty = p.y;

  if (tx < -tileSize || ty < -tileSize || tx > canvas.width + tileSize || ty > canvas.height + tileSize) {
    return;
  }

  ctx.fillStyle = "#7a4e2e";
  ctx.fillRect(tx + tileSize * 0.42, ty + tileSize * 0.62, tileSize * 0.16, tileSize * 0.28);

  ctx.fillStyle = "#2bd463";
  ctx.beginPath();
  ctx.arc(tx + tileSize * 0.5, ty + tileSize * 0.3, tileSize * 0.19, 0, Math.PI * 2);
  ctx.arc(tx + tileSize * 0.35, ty + tileSize * 0.38, tileSize * 0.17, 0, Math.PI * 2);
  ctx.arc(tx + tileSize * 0.64, ty + tileSize * 0.39, tileSize * 0.17, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#0f1113";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(tx + tileSize * 0.42, ty + tileSize * 0.62, tileSize * 0.16, tileSize * 0.28);
}

function drawWorld() {
  if (!state.world) {
    return;
  }

  const { tileSize, width, height, lobby, exits } = state.world;
  const minTileX = Math.max(0, Math.floor(camera.x / tileSize) - 2);
  const minTileY = Math.max(0, Math.floor(camera.y / tileSize) - 2);
  const maxTileX = Math.min(width - 1, Math.ceil((camera.x + canvas.width) / tileSize) + 2);
  const maxTileY = Math.min(height - 1, Math.ceil((camera.y + canvas.height) / tileSize) + 2);

  ctx.fillStyle = "#d9d9d9";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = minTileY; y <= maxTileY; y++) {
    for (let x = minTileX; x <= maxTileX; x++) {
      const p = worldToScreen(x, y, tileSize);

      if (isInRect(x, y, lobby)) {
        ctx.fillStyle = "#ececec";
      } else {
        ctx.fillStyle = "#d0d0d0";
      }
      ctx.fillRect(p.x, p.y, tileSize, tileSize);

      if (isForestTile(x, y)) {
        const h = tileHash(x, y) % 100;
        if (h < 22) {
          drawTreeAtTile(x, y, tileSize);
        }
      }
    }
  }

  const lp = worldToScreen(lobby.x, lobby.y, tileSize);
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 3;
  ctx.strokeRect(lp.x, lp.y, lobby.w * tileSize, lobby.h * tileSize);

  const leftExitP = worldToScreen(exits.left.x, exits.left.y1, tileSize);
  ctx.fillStyle = "#b8e8ff";
  ctx.fillRect(leftExitP.x, leftExitP.y, tileSize, (exits.left.y2 - exits.left.y1 + 1) * tileSize);
  ctx.strokeStyle = "#0f1113";
  ctx.strokeRect(leftExitP.x, leftExitP.y, tileSize, (exits.left.y2 - exits.left.y1 + 1) * tileSize);

  const rightExitP = worldToScreen(exits.right.x, exits.right.y1, tileSize);
  ctx.fillRect(rightExitP.x, rightExitP.y, tileSize, (exits.right.y2 - exits.right.y1 + 1) * tileSize);
  ctx.strokeRect(rightExitP.x, rightExitP.y, tileSize, (exits.right.y2 - exits.right.y1 + 1) * tileSize);

  for (const slot of state.farmSlots) {
    const p = worldToScreen(slot.x, slot.y, tileSize);
    const owner = playerById(slot.ownerId);
    ctx.fillStyle = owner ? "#f7f1cf" : "#f0f0f0";
    ctx.fillRect(p.x, p.y, slot.w * tileSize, slot.h * tileSize);
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(p.x, p.y, slot.w * tileSize, slot.h * tileSize);
  }

  const labelP = worldToScreen(lobby.x + Math.floor(lobby.w / 2), lobby.y + Math.floor(lobby.h / 2), tileSize);
  ctx.fillStyle = "#111111";
  ctx.font = "30px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Lobby", labelP.x, labelP.y);
}

function drawPlots() {
  if (!state.world) return;
  const tileSize = state.world.tileSize;

  for (const plot of state.plots) {
    const p = worldToScreen(plot.x, plot.y, tileSize);
    const crop = state.crops[plot.cropType];

    ctx.fillStyle = "#6a4428";
    ctx.fillRect(p.x + 2, p.y + 2, tileSize - 4, tileSize - 4);

    const g = Math.max(0, Math.min(1, plot.growth));
    if (g < 0.33) {
      ctx.fillStyle = crop?.colorSeed || "#8a5a2b";
      ctx.fillRect(p.x + tileSize / 2 - 2, p.y + tileSize / 2 - 2, 4, 4);
    } else if (g < 1) {
      ctx.fillStyle = crop?.colorSprout || "#4fbf4f";
      ctx.fillRect(p.x + tileSize / 2 - 2, p.y + 5, 4, tileSize - 10);
      ctx.fillRect(p.x + tileSize / 2 - 6, p.y + 8, 4, 4);
      ctx.fillRect(p.x + tileSize / 2 + 2, p.y + 8, 4, 4);
    } else {
      ctx.fillStyle = crop?.colorReady || "#ff8b2b";
      ctx.fillRect(p.x + tileSize / 2 - 6, p.y + tileSize / 2 - 6, 12, 12);
    }
  }
}

function drawTreasures() {
  if (!state.world) return;
  const tileSize = state.world.tileSize;

  for (const chest of state.treasures) {
    const p = worldToScreen(chest.x, chest.y, tileSize);
    ctx.fillStyle = "#8f5a2e";
    ctx.fillRect(p.x + 3, p.y + 7, tileSize - 6, tileSize - 9);
    ctx.fillStyle = "#f2cf66";
    ctx.fillRect(p.x + 3, p.y + 5, tileSize - 6, 4);
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x + 3, p.y + 5, tileSize - 6, tileSize - 7);
  }
}

function drawPlayers() {
  if (!state.world) return;
  const tileSize = state.world.tileSize;

  for (const p of state.players) {
    const pos = worldToScreen(p.x, p.y, tileSize);

    ctx.fillStyle = p.id === state.yourId ? "#ffffff" : p.color;
    ctx.fillRect(pos.x + 2, pos.y + 2, tileSize - 4, tileSize - 4);

    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pos.x + 2, pos.y + 2, tileSize - 4, tileSize - 4);

    ctx.fillStyle = "#111111";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    const tag = p.isAdmin ? `[ADMIN] ${p.name}` : p.name;
    ctx.fillText(tag, pos.x + tileSize / 2, pos.y - 3);
  }
}

function updatePanels() {
  const you = yourPlayer();
  if (!you) {
    statsEl.innerHTML = "Connecting...";
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
    `Farm slot: <b>${you.farmSlotId || "None"}</b>`,
    `Online: <b>${state.players.length}</b>`
  ].join("<br>");

  inventoryEl.innerHTML = [
    "<b>Inventory</b>",
    `Carrot Seeds: <b>${you.inventory.carrotSeed}</b>`,
    `Pumpkin Seeds: <b>${you.inventory.pumpkinSeed}</b>`,
    `Gear: <b>${you.inventory.gear}</b>`
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

  resizeCanvas();
  updateCamera();
  drawWorld();
  drawPlots();
  drawTreasures();
  drawPlayers();
  updatePanels();
}

function gameLoop() {
  const now = performance.now();
  const move = keyToMove();

  if ((move.dx !== 0 || move.dy !== 0) && now - lastMoveAt > 85) {
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
  if (!you) return;

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

window.addEventListener("resize", () => {
  resizeCanvas();
});

setNameBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) return;
  send({ type: "rename", name });
});

clearCropsBtn.addEventListener("click", () => {
  send({ type: "admin", action: "clear_crops" });
});

respawnTreasuresBtn.addEventListener("click", () => {
  send({ type: "admin", action: "respawn_treasures" });
});

ws.addEventListener("open", () => {
  showMessage("Connected. Use G to open treasure chests in the forest.");
  resizeCanvas();
  gameLoop();
});

ws.addEventListener("close", () => {
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
    state.world = msg.world || state.world;
    state.players = msg.players || [];
    state.farmSlots = msg.farmSlots || [];
    state.plots = msg.plots || [];
    state.treasures = msg.treasures || [];
  }

  if (msg.type === "rename_ok") {
    showMessage(`Name set: ${msg.name}${msg.isAdmin ? " (ADMIN)" : ""}`);
  }
  if (msg.type === "info") {
    showMessage(msg.message || "Done");
  }
  if (msg.type === "error") {
    showMessage(msg.message || "Action failed");
  }
  if (msg.type === "kicked") {
    showMessage(msg.reason || "Kicked");
    ws.close();
  }
});
