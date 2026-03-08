const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const statsEl = document.getElementById("stats");
const inventorySummaryEl = document.getElementById("inventorySummary");
const messageEl = document.getElementById("message");
const growthTimersEl = document.getElementById("growthTimers");
const nameInput = document.getElementById("nameInput");
const setNameBtn = document.getElementById("setNameBtn");
const selectedSeedEl = document.getElementById("selectedSeed");
const healthFillEl = document.getElementById("healthFill");
const staminaFillEl = document.getElementById("staminaFill");
const inventoryModalEl = document.getElementById("inventoryModal");
const inventoryGridEl = document.getElementById("inventoryGrid");

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
  monsters: [],
  selectedSeed: "carrot",
  message: "",
  inventoryOpen: false
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
  const targetW = Math.min(1540, window.innerWidth - 380);
  const width = Math.max(760, targetW);
  const height = Math.max(520, Math.floor(window.innerHeight - 40));

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

  ctx.fillStyle = "#5e3f25";
  ctx.fillRect(tx + tileSize * 0.42, ty + tileSize * 0.62, tileSize * 0.16, tileSize * 0.28);

  ctx.fillStyle = "#1f8e3f";
  ctx.beginPath();
  ctx.arc(tx + tileSize * 0.5, ty + tileSize * 0.3, tileSize * 0.19, 0, Math.PI * 2);
  ctx.arc(tx + tileSize * 0.35, ty + tileSize * 0.38, tileSize * 0.17, 0, Math.PI * 2);
  ctx.arc(tx + tileSize * 0.64, ty + tileSize * 0.39, tileSize * 0.17, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#0f1113";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(tx + tileSize * 0.42, ty + tileSize * 0.62, tileSize * 0.16, tileSize * 0.28);
}

function drawGround() {
  const { tileSize, width, height, lobby } = state.world;
  const minTileX = Math.max(0, Math.floor(camera.x / tileSize) - 2);
  const minTileY = Math.max(0, Math.floor(camera.y / tileSize) - 2);
  const maxTileX = Math.min(width - 1, Math.ceil((camera.x + canvas.width) / tileSize) + 2);
  const maxTileY = Math.min(height - 1, Math.ceil((camera.y + canvas.height) / tileSize) + 2);

  ctx.fillStyle = "#2f6f3c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = minTileY; y <= maxTileY; y++) {
    for (let x = minTileX; x <= maxTileX; x++) {
      const p = worldToScreen(x, y, tileSize);

      if (isInRect(x, y, lobby)) {
        ctx.fillStyle = "#b5b9bf";
      } else {
        ctx.fillStyle = "#3a7d44";
      }
      ctx.fillRect(p.x, p.y, tileSize, tileSize);

      if (isForestTile(x, y)) {
        const h = tileHash(x, y) % 100;
        if (h < 20) {
          drawTreeAtTile(x, y, tileSize);
        }
      }
    }
  }

  const lp = worldToScreen(lobby.x, lobby.y, tileSize);
  ctx.strokeStyle = "#1f2328";
  ctx.lineWidth = 3;
  ctx.strokeRect(lp.x, lp.y, lobby.w * tileSize, lobby.h * tileSize);

  for (const slot of state.farmSlots) {
    const p = worldToScreen(slot.x, slot.y, tileSize);
    ctx.fillStyle = "#8a623f";
    ctx.fillRect(p.x, p.y, slot.w * tileSize, slot.h * tileSize);
    ctx.strokeStyle = "#2c1c12";
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, slot.w * tileSize, slot.h * tileSize);
  }
}

function drawPlots() {
  const tileSize = state.world.tileSize;

  for (const plot of state.plots) {
    const p = worldToScreen(plot.x, plot.y, tileSize);
    const crop = state.crops[plot.cropType];

    ctx.fillStyle = "#5f3f28";
    ctx.fillRect(p.x + 2, p.y + 2, tileSize - 4, tileSize - 4);

    const g = Math.max(0, Math.min(1, plot.growth));
    if (g < 0.33) {
      ctx.fillStyle = crop?.colorSeed || "#8a5a2b";
      ctx.fillRect(p.x + tileSize / 2 - 2, p.y + tileSize / 2 - 2, 4, 4);
    } else if (g < 1) {
      ctx.fillStyle = crop?.colorSprout || "#58c85d";
      ctx.fillRect(p.x + tileSize / 2 - 2, p.y + 5, 4, tileSize - 10);
      ctx.fillRect(p.x + tileSize / 2 - 6, p.y + 8, 4, 4);
      ctx.fillRect(p.x + tileSize / 2 + 2, p.y + 8, 4, 4);
    } else {
      ctx.fillStyle = crop?.colorReady || "#ff8b2b";
      ctx.fillRect(p.x + tileSize / 2 - 6, p.y + tileSize / 2 - 6, 12, 12);
    }
  }
}

function drawDarkness() {
  const you = yourPlayer();
  if (!you || !state.world) {
    return;
  }

  const tileSize = state.world.tileSize;
  const lobby = state.world.lobby;

  if (isInRect(you.x, you.y, lobby)) {
    const lp = worldToScreen(lobby.x, lobby.y, tileSize);
    const lw = lobby.w * tileSize;
    const lh = lobby.h * tileSize;

    ctx.save();
    ctx.fillStyle = "rgba(4, 8, 6, 0.78)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillRect(lp.x - 24, lp.y - 24, lw + 48, lh + 48);
    ctx.restore();
    return;
  }

  const p = worldToScreen(you.x, you.y, tileSize);
  const cx = p.x + tileSize / 2;
  const cy = p.y + tileSize / 2;
  const radius = 220;

  ctx.save();
  ctx.fillStyle = "rgba(8, 12, 8, 0.86)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalCompositeOperation = "destination-out";
  const gradient = ctx.createRadialGradient(cx, cy, 35, cx, cy, radius);
  gradient.addColorStop(0, "rgba(0,0,0,1)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawChest(chest) {
  const tileSize = state.world.tileSize;
  const p = worldToScreen(chest.x, chest.y, tileSize);

  let top = "#9f6a3e";
  if (chest.rarity === "rare") {
    top = "#4c7cff";
  } else if (chest.rarity === "legendary") {
    top = "#ffd44c";
  }

  ctx.fillStyle = "#6f4527";
  ctx.fillRect(p.x + 3, p.y + 7, tileSize - 6, tileSize - 9);
  ctx.fillStyle = top;
  ctx.fillRect(p.x + 3, p.y + 5, tileSize - 6, 4);
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(p.x + 3, p.y + 5, tileSize - 6, tileSize - 7);
}

function drawMonsters() {
  const tileSize = state.world.tileSize;
  for (const m of state.monsters) {
    const p = worldToScreen(m.x, m.y, tileSize);
    ctx.fillStyle = "#de2f2f";
    ctx.fillRect(p.x + 2, p.y + 2, tileSize - 4, tileSize - 4);
    ctx.strokeStyle = "#220909";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x + 2, p.y + 2, tileSize - 4, tileSize - 4);
  }
}

function drawPlayers() {
  const tileSize = state.world.tileSize;
  for (const p of state.players) {
    const pos = worldToScreen(p.x, p.y, tileSize);

    ctx.fillStyle = p.id === state.yourId ? "#ffffff" : p.color;
    ctx.fillRect(pos.x + 2, pos.y + 2, tileSize - 4, tileSize - 4);

    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pos.x + 2, pos.y + 2, tileSize - 4, tileSize - 4);

    ctx.fillStyle = "#ffffff";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.name, pos.x + tileSize / 2, pos.y - 3);
  }
}

function updateInventoryGrid(you) {
  const slots = [
    { label: "Carrot Seed", count: you.inventory.carrotSeed },
    { label: "Pumpkin Seed", count: you.inventory.pumpkinSeed },
    { label: "Gear", count: you.inventory.gear },
    { label: "Money", count: you.money }
  ];

  const cells = [];
  for (let i = 0; i < 27; i++) {
    const item = slots[i] || null;
    if (item) {
      cells.push(`<div class="slot">${item.label}<br>x${item.count}</div>`);
    } else {
      cells.push('<div class="slot"></div>');
    }
  }
  inventoryGridEl.innerHTML = cells.join("");
}

function updatePanels() {
  const you = yourPlayer();
  if (!you) {
    statsEl.innerHTML = "Connecting...";
    inventorySummaryEl.innerHTML = "";
    selectedSeedEl.textContent = "Selected seed: carrot";
    growthTimersEl.innerHTML = "";
    healthFillEl.style.width = "100%";
    staminaFillEl.style.width = "100%";
    return;
  }

  const hpPct = Math.max(0, Math.min(100, (you.health / you.maxHealth) * 100));
  const stPct = Math.max(0, Math.min(100, you.stamina));
  healthFillEl.style.width = `${hpPct}%`;
  staminaFillEl.style.width = `${stPct}%`;

  statsEl.innerHTML = [
    `Name: <b>${you.name}</b>`,
    `Health: <b>${Math.round(you.health)}</b> / ${you.maxHealth}`,
    `Stamina: <b>${Math.round(you.stamina)}</b>`,
    `Money: <b>$${you.money}</b>`,
    `Harvested: <b>${you.harvested}</b>`,
    `Farm slot: <b>${you.farmSlotId || "None"}</b>`,
    `Online: <b>${state.players.length}</b>`
  ].join("<br>");

  inventorySummaryEl.innerHTML = [
    "<b>Inventory</b>",
    `Carrot Seeds: <b>${you.inventory.carrotSeed}</b>`,
    `Pumpkin Seeds: <b>${you.inventory.pumpkinSeed}</b>`,
    `Gear: <b>${you.inventory.gear}</b>`
  ].join("<br>");

  selectedSeedEl.textContent = `Selected seed: ${state.selectedSeed}`;

  const now = Date.now();
  const ownPlots = state.plots.filter((plot) => plot.ownerId === you.id);
  if (ownPlots.length === 0) {
    growthTimersEl.innerHTML = "<b>Growth Timers</b><br>No crops planted.";
  } else {
    const lines = ownPlots.map((plot) => {
      const crop = state.crops[plot.cropType];
      const totalMs = crop?.growthMs || 30000;
      const remain = Math.max(0, Math.ceil((totalMs - (now - plot.plantedAt)) / 1000));
      return `${plot.cropType}: <b>${remain}s</b>`;
    });
    growthTimersEl.innerHTML = `<b>Growth Timers</b><br>${lines.join("<br>")}`;
  }

  updateInventoryGrid(you);
}

function render() {
  if (!state.world) {
    return;
  }

  resizeCanvas();
  updateCamera();
  drawGround();
  drawPlots();
  drawDarkness();

  for (const chest of state.treasures) {
    drawChest(chest);
  }

  drawMonsters();
  drawPlayers();
  updatePanels();
}

function gameLoop() {
  const now = performance.now();
  const move = keyToMove();
  const sprint = keys.has("Shift");

  if (!state.inventoryOpen && (move.dx !== 0 || move.dy !== 0) && now - lastMoveAt > 80) {
    send({ type: "move", dx: move.dx, dy: move.dy, sprint });
    lastMoveAt = now;
  }

  render();
  requestAnimationFrame(gameLoop);
}

window.addEventListener("keydown", (e) => {
  keys.add(e.key);

  if (e.key === "i" || e.key === "I") {
    state.inventoryOpen = !state.inventoryOpen;
    inventoryModalEl.classList.toggle("hidden", !state.inventoryOpen);
    e.preventDefault();
    return;
  }

  if (e.key === "1") {
    state.selectedSeed = "carrot";
    send({ type: "select_seed", cropType: "carrot" });
  }
  if (e.key === "2") {
    state.selectedSeed = "pumpkin";
    send({ type: "select_seed", cropType: "pumpkin" });
  }

  const you = yourPlayer();
  if (!you || state.inventoryOpen) return;

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

inventoryModalEl.addEventListener("click", (e) => {
  if (e.target === inventoryModalEl) {
    state.inventoryOpen = false;
    inventoryModalEl.classList.add("hidden");
  }
});

ws.addEventListener("open", () => {
  showMessage("Connected. Brown=common chest, Blue=rare, Yellow=legendary.");
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
    state.monsters = msg.monsters || [];
  }

  if (msg.type === "rename_ok") {
    showMessage(`Name set: ${msg.name}`);
  }
  if (msg.type === "info") {
    showMessage(msg.message || "Done");
  }
  if (msg.type === "error") {
    showMessage(msg.message || "Action failed");
  }
});
