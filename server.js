const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const WORLD = {
  width: 72,
  height: 40,
  tileSize: 20,
  lobby: { x: 26, y: 14, w: 20, h: 12 },
  exits: {
    left: { x: 26, y1: 18, y2: 21 },
    right: { x: 45, y1: 18, y2: 21 }
  }
};

const CROP_TYPES = {
  carrot: {
    growthMs: 12000,
    price: 4,
    seedKey: "carrotSeed",
    colorSeed: "#8a5a2b",
    colorSprout: "#4fbf4f",
    colorReady: "#ff8b2b"
  },
  pumpkin: {
    growthMs: 18000,
    price: 8,
    seedKey: "pumpkinSeed",
    colorSeed: "#7a4d23",
    colorSprout: "#6bcf5f",
    colorReady: "#f39a2d"
  }
};

const TREASURE_TARGET = 30;

const players = new Map();
const socketsByPlayerId = new Map();
const plots = new Map();
const treasures = new Map();
const farmSlots = buildFarmSlots();

let nextPlayerId = 1;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function tileKey(x, y) {
  return `${x},${y}`;
}

function parseTileKey(key) {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

function buildFarmSlots() {
  const slots = [];
  const slotW = 10;
  const slotH = 5;
  const startX = 7;
  const gapX = 2;

  const rows = [3, 9, 28, 34];
  let id = 1;

  for (const rowY of rows) {
    for (let col = 0; col < 5; col++) {
      slots.push({
        id,
        x: startX + col * (slotW + gapX),
        y: rowY,
        w: slotW,
        h: slotH,
        ownerId: null
      });
      id += 1;
    }
  }

  return slots;
}

function serializeFarmSlots() {
  return farmSlots.map((slot) => ({
    id: slot.id,
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: slot.h,
    ownerId: slot.ownerId
  }));
}

function serializePlayers() {
  return Array.from(players.values()).map((player) => ({
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    color: player.color,
    money: player.money,
    harvested: player.harvested,
    isAdmin: player.isAdmin,
    farmSlotId: player.farmSlotId,
    inventory: player.inventory,
    gearPower: player.gearPower
  }));
}

function serializePlots(now = Date.now()) {
  const out = [];
  for (const [key, plot] of plots) {
    const crop = CROP_TYPES[plot.cropType];
    const growth = clamp((now - plot.plantedAt) / crop.growthMs, 0, 1);
    out.push({
      key,
      x: plot.x,
      y: plot.y,
      ownerId: plot.ownerId,
      cropType: plot.cropType,
      growth,
      ready: growth >= 1
    });
  }
  return out;
}

function serializeTreasures() {
  return Array.from(treasures.values());
}

function sendTo(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const encoded = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(encoded);
    }
  }
}

function playerByName(name, exceptPlayerId = null) {
  const normalized = String(name).trim().toLowerCase();
  for (const player of players.values()) {
    if (player.id === exceptPlayerId) {
      continue;
    }
    if (player.name.toLowerCase() === normalized) {
      return player;
    }
  }
  return null;
}

function parseNameAndRole(rawName) {
  const raw = String(rawName || "").trim();
  if (!raw) {
    return { ok: false, error: "Name cannot be empty." };
  }

  const adminMatch = raw.match(/^\(\(admin\)\s*\(?\s*(.+?)\s*\)?$/i);
  const isAdmin = Boolean(adminMatch);
  const name = (adminMatch ? adminMatch[1] : raw).trim();

  if (!name) {
    return { ok: false, error: "Name cannot be empty." };
  }
  if (name.length > 16) {
    return { ok: false, error: "Name must be 16 characters or less." };
  }

  return { ok: true, name, isAdmin };
}

function colorFromId(id) {
  return `hsl(${(id * 67) % 360}, 70%, 55%)`;
}

function isInRect(x, y, rect) {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

function isExitTile(x, y) {
  const left = WORLD.exits.left;
  const right = WORLD.exits.right;
  if (x === left.x && y >= left.y1 && y <= left.y2) {
    return true;
  }
  if (x === right.x && y >= right.y1 && y <= right.y2) {
    return true;
  }
  return false;
}

function isLobbyWall(x, y) {
  const l = WORLD.lobby;
  const onBorder =
    x === l.x || x === l.x + l.w - 1 || y === l.y || y === l.y + l.h - 1;

  if (!onBorder) {
    return false;
  }

  return !isExitTile(x, y);
}

function isInsideWorld(x, y) {
  return x >= 0 && y >= 0 && x < WORLD.width && y < WORLD.height;
}

function isFarmTile(x, y) {
  return farmSlots.some((slot) => isInRect(x, y, slot));
}

function isForestTile(x, y) {
  if (!isInsideWorld(x, y)) {
    return false;
  }
  if (isInRect(x, y, WORLD.lobby)) {
    return false;
  }
  if (isFarmTile(x, y)) {
    return false;
  }
  return true;
}

function isWalkable(x, y) {
  if (!isInsideWorld(x, y)) {
    return false;
  }
  if (isLobbyWall(x, y)) {
    return false;
  }
  return true;
}

function findOpenSpawnInLobby() {
  const l = WORLD.lobby;
  for (let i = 0; i < 100; i++) {
    const x = randomInt(l.x + 2, l.x + l.w - 3);
    const y = randomInt(l.y + 2, l.y + l.h - 3);
    const occupied = Array.from(players.values()).some((p) => p.x === x && p.y === y);
    if (!occupied) {
      return { x, y };
    }
  }
  return { x: l.x + Math.floor(l.w / 2), y: l.y + Math.floor(l.h / 2) };
}

function assignFarmSlot(playerId) {
  const free = farmSlots.find((slot) => slot.ownerId === null);
  if (!free) {
    return null;
  }
  free.ownerId = playerId;
  return free.id;
}

function releaseFarmSlot(playerId) {
  const slot = farmSlots.find((s) => s.ownerId === playerId);
  if (!slot) {
    return;
  }
  slot.ownerId = null;

  const keysToDelete = [];
  for (const [key, plot] of plots) {
    if (plot.ownerId === playerId) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    plots.delete(key);
  }
}

function getFarmSlotByPlayer(player) {
  if (!player.farmSlotId) {
    return null;
  }
  return farmSlots.find((slot) => slot.id === player.farmSlotId) || null;
}

function isInsideOwnedFarm(player, x, y) {
  const slot = getFarmSlotByPlayer(player);
  if (!slot) {
    return false;
  }

  const inner = {
    x: slot.x + 1,
    y: slot.y + 1,
    w: Math.max(1, slot.w - 2),
    h: Math.max(1, slot.h - 2)
  };
  return isInRect(x, y, inner);
}

function spawnTreasureAtRandom() {
  for (let tries = 0; tries < 120; tries++) {
    const x = randomInt(0, WORLD.width - 1);
    const y = randomInt(0, WORLD.height - 1);
    if (!isForestTile(x, y)) {
      continue;
    }

    const key = tileKey(x, y);
    if (treasures.has(key)) {
      continue;
    }

    const occupiedByPlayer = Array.from(players.values()).some((p) => p.x === x && p.y === y);
    if (occupiedByPlayer) {
      continue;
    }

    treasures.set(key, {
      key,
      x,
      y,
      kind: "treasure"
    });
    return true;
  }

  return false;
}

function fillTreasures() {
  while (treasures.size < TREASURE_TARGET) {
    if (!spawnTreasureAtRandom()) {
      break;
    }
  }
}

function awardTreasureLoot(player) {
  const roll = Math.random();

  if (roll < 0.45) {
    const qty = randomInt(2, 5);
    player.inventory.carrotSeed += qty;
    return `Found ${qty} carrot seeds`;
  }

  if (roll < 0.75) {
    const qty = randomInt(1, 3);
    player.inventory.pumpkinSeed += qty;
    return `Found ${qty} pumpkin seeds`;
  }

  if (roll < 0.92) {
    player.inventory.gear += 1;
    player.gearPower += 1;
    return "Found 1 gear upgrade";
  }

  const coins = randomInt(4, 10);
  player.money += coins;
  return `Found $${coins}`;
}

function broadcastState() {
  broadcast({
    type: "state",
    world: WORLD,
    players: serializePlayers(),
    farmSlots: serializeFarmSlots(),
    plots: serializePlots(),
    treasures: serializeTreasures(),
    serverTime: Date.now()
  });
}

function handleMove(player, message) {
  const dx = clamp(Number(message.dx) || 0, -1, 1);
  const dy = clamp(Number(message.dy) || 0, -1, 1);

  const nextX = clamp(player.x + dx, 0, WORLD.width - 1);
  const nextY = clamp(player.y + dy, 0, WORLD.height - 1);

  if (!isWalkable(nextX, nextY)) {
    return;
  }

  player.x = nextX;
  player.y = nextY;
}

function handleRename(player, message, ws) {
  const parsed = parseNameAndRole(message.name);
  if (!parsed.ok) {
    sendTo(ws, { type: "error", message: parsed.error });
    return;
  }

  if (playerByName(parsed.name, player.id)) {
    sendTo(ws, { type: "error", message: "Name already taken." });
    return;
  }

  player.name = parsed.name;
  player.isAdmin = parsed.isAdmin;
  sendTo(ws, {
    type: "rename_ok",
    name: player.name,
    isAdmin: player.isAdmin
  });
}

function handlePlant(player, message, ws) {
  const cropType = String(message.cropType || "carrot");
  const crop = CROP_TYPES[cropType];
  if (!crop) {
    return;
  }

  const x = clamp(Math.floor(Number(message.x)), 0, WORLD.width - 1);
  const y = clamp(Math.floor(Number(message.y)), 0, WORLD.height - 1);

  if (!isInsideOwnedFarm(player, x, y)) {
    sendTo(ws, { type: "error", message: "You can only plant in your own farm slot." });
    return;
  }

  const seedKey = crop.seedKey;
  if ((player.inventory[seedKey] || 0) <= 0) {
    sendTo(ws, { type: "error", message: `No ${cropType} seeds in inventory.` });
    return;
  }

  const key = tileKey(x, y);
  if (plots.has(key)) {
    sendTo(ws, { type: "error", message: "That plot already has a crop." });
    return;
  }

  player.inventory[seedKey] -= 1;
  plots.set(key, {
    x,
    y,
    ownerId: player.id,
    cropType,
    plantedAt: Date.now()
  });
}

function handleHarvest(player, message, ws) {
  const x = clamp(Math.floor(Number(message.x)), 0, WORLD.width - 1);
  const y = clamp(Math.floor(Number(message.y)), 0, WORLD.height - 1);
  const key = tileKey(x, y);
  const plot = plots.get(key);

  if (!plot || plot.ownerId !== player.id) {
    return;
  }

  const crop = CROP_TYPES[plot.cropType];
  const growth = (Date.now() - plot.plantedAt) / crop.growthMs;
  if (growth < 1) {
    sendTo(ws, { type: "error", message: "Crop is not ready yet." });
    return;
  }

  plots.delete(key);
  player.money += crop.price;
  player.harvested += 1;

  if (Math.random() < 0.35) {
    player.inventory[crop.seedKey] += 1;
    sendTo(ws, { type: "info", message: `Harvest bonus: +1 ${crop.seedKey}` });
  }
}

function handleGather(player, ws) {
  const key = tileKey(player.x, player.y);
  const treasure = treasures.get(key);
  if (!treasure) {
    sendTo(ws, { type: "error", message: "No treasure on this tile." });
    return;
  }

  treasures.delete(key);
  const loot = awardTreasureLoot(player);
  sendTo(ws, { type: "info", message: loot });
  fillTreasures();
}

function handleSelectSeed(player, message) {
  const cropType = String(message.cropType || "");
  if (!CROP_TYPES[cropType]) {
    return;
  }
  player.selectedSeed = cropType;
}

function handleAdmin(player, message, ws) {
  if (!player.isAdmin) {
    sendTo(ws, { type: "error", message: "Admin required." });
    return;
  }

  const action = String(message.action || "");

  if (action === "clear_crops") {
    plots.clear();
    sendTo(ws, { type: "info", message: "All crops cleared." });
    return;
  }

  if (action === "clear_treasures") {
    treasures.clear();
    fillTreasures();
    sendTo(ws, { type: "info", message: "Treasures respawned." });
    return;
  }

  if (action === "kick_player") {
    const targetId = Number(message.targetId);
    if (!Number.isInteger(targetId) || targetId === player.id) {
      sendTo(ws, { type: "error", message: "Invalid kick target." });
      return;
    }

    const targetSocket = socketsByPlayerId.get(targetId);
    if (!targetSocket) {
      sendTo(ws, { type: "error", message: "Player not online." });
      return;
    }

    sendTo(targetSocket, { type: "kicked", reason: `Kicked by admin ${player.name}` });
    targetSocket.close();
    return;
  }

  sendTo(ws, { type: "error", message: "Unknown admin action." });
}

function handleMessage(player, ws, msg) {
  switch (msg.type) {
    case "move":
      handleMove(player, msg);
      break;
    case "rename":
      handleRename(player, msg, ws);
      break;
    case "plant":
      handlePlant(player, msg, ws);
      break;
    case "harvest":
      handleHarvest(player, msg, ws);
      break;
    case "gather":
      handleGather(player, ws);
      break;
    case "select_seed":
      handleSelectSeed(player, msg);
      break;
    case "admin":
      handleAdmin(player, msg, ws);
      break;
    default:
      break;
  }
}

fillTreasures();

wss.on("connection", (ws) => {
  const id = nextPlayerId++;
  const spawn = findOpenSpawnInLobby();
  const farmSlotId = assignFarmSlot(id);

  const player = {
    id,
    name: `Farmer${id}`,
    x: spawn.x,
    y: spawn.y,
    color: colorFromId(id),
    isAdmin: false,
    money: 0,
    harvested: 0,
    farmSlotId,
    selectedSeed: "carrot",
    inventory: {
      carrotSeed: 2,
      pumpkinSeed: 1,
      gear: 0
    },
    gearPower: 0
  };

  players.set(id, player);
  socketsByPlayerId.set(id, ws);

  sendTo(ws, {
    type: "welcome",
    yourId: id,
    world: WORLD,
    crops: CROP_TYPES,
    note: farmSlotId ? `Farm slot #${farmSlotId} assigned.` : "No farm slot available."
  });

  broadcastState();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!msg || typeof msg !== "object") {
      return;
    }

    handleMessage(player, ws, msg);
    broadcastState();
  });

  ws.on("close", () => {
    players.delete(id);
    socketsByPlayerId.delete(id);
    releaseFarmSlot(id);
    broadcastState();
  });
});

setInterval(() => {
  fillTreasures();
  broadcastState();
}, 700);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
