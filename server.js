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
  width: 180,
  height: 120,
  tileSize: 20,
  lobby: { x: 58, y: 34, w: 64, h: 52 },
  exits: {
    left: { x: 58, y1: 56, y2: 63 },
    right: { x: 121, y1: 56, y2: 63 }
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
    colorSprout: "#68c95e",
    colorReady: "#f09b2d"
  }
};

const TREASURE_TARGET = 50;

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

function isInRect(x, y, rect) {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

function isExitTile(x, y) {
  const left = WORLD.exits.left;
  const right = WORLD.exits.right;
  return (
    (x === left.x && y >= left.y1 && y <= left.y2) ||
    (x === right.x && y >= right.y1 && y <= right.y2)
  );
}

function isLobbyWall(x, y) {
  const l = WORLD.lobby;
  const onBorder =
    x === l.x || x === l.x + l.w - 1 || y === l.y || y === l.y + l.h - 1;
  return onBorder && !isExitTile(x, y);
}

function isInsideWorld(x, y) {
  return x >= 0 && y >= 0 && x < WORLD.width && y < WORLD.height;
}

function isFarmTile(x, y) {
  return farmSlots.some((slot) => isInRect(x, y, slot));
}

function isForestTile(x, y) {
  return isInsideWorld(x, y) && !isInRect(x, y, WORLD.lobby) && !isFarmTile(x, y);
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

function buildFarmSlots() {
  const slots = [];
  const w = 8;
  const h = 5;
  const gapX = 3;
  const startX = 66;
  const rowTopY = 45;
  const rowBottomY = 69;

  let id = 1;
  for (let col = 0; col < 5; col++) {
    slots.push({ id, x: startX + col * (w + gapX), y: rowTopY, w, h, ownerId: null });
    id += 1;
  }
  for (let col = 0; col < 5; col++) {
    slots.push({ id, x: startX + col * (w + gapX), y: rowBottomY, w, h, ownerId: null });
    id += 1;
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

function sendTo(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function broadcastState() {
  broadcast({
    type: "state",
    world: WORLD,
    players: serializePlayers(),
    farmSlots: serializeFarmSlots(),
    plots: serializePlots(),
    treasures: Array.from(treasures.values())
  });
}

function colorFromId(id) {
  return `hsl(${(id * 67) % 360}, 70%, 55%)`;
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

function isNameTaken(name, exceptPlayerId = null) {
  const n = name.toLowerCase();
  for (const player of players.values()) {
    if (player.id === exceptPlayerId) {
      continue;
    }
    if (player.name.toLowerCase() === n) {
      return true;
    }
  }
  return false;
}

function findOpenSpawnInLobby() {
  const l = WORLD.lobby;
  for (let i = 0; i < 200; i++) {
    const x = randomInt(l.x + 2, l.x + l.w - 3);
    const y = randomInt(l.y + 2, l.y + l.h - 3);
    if (farmSlots.some((slot) => isInRect(x, y, slot))) {
      continue;
    }
    const occupied = Array.from(players.values()).some((p) => p.x === x && p.y === y);
    if (!occupied) {
      return { x, y };
    }
  }
  return { x: l.x + Math.floor(l.w / 2), y: l.y + Math.floor(l.h / 2) };
}

function assignFarmSlot(playerId) {
  const slot = farmSlots.find((s) => s.ownerId === null);
  if (!slot) {
    return null;
  }
  slot.ownerId = playerId;
  return slot.id;
}

function releaseFarmSlot(playerId) {
  const slot = farmSlots.find((s) => s.ownerId === playerId);
  if (slot) {
    slot.ownerId = null;
  }

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

function getFarmSlotForPlayer(player) {
  if (!player.farmSlotId) {
    return null;
  }
  return farmSlots.find((s) => s.id === player.farmSlotId) || null;
}

function isInsideOwnedFarm(player, x, y) {
  const slot = getFarmSlotForPlayer(player);
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

function spawnTreasure() {
  for (let i = 0; i < 300; i++) {
    const x = randomInt(0, WORLD.width - 1);
    const y = randomInt(0, WORLD.height - 1);
    if (!isForestTile(x, y)) {
      continue;
    }
    const key = tileKey(x, y);
    if (treasures.has(key)) {
      continue;
    }
    if (Array.from(players.values()).some((p) => p.x === x && p.y === y)) {
      continue;
    }
    treasures.set(key, { key, x, y, kind: "chest" });
    return true;
  }
  return false;
}

function fillTreasures() {
  while (treasures.size < TREASURE_TARGET) {
    if (!spawnTreasure()) {
      break;
    }
  }
}

function awardTreasure(player) {
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
  const coins = randomInt(4, 9);
  player.money += coins;
  return `Found $${coins}`;
}

function handleMove(player, msg) {
  const dx = clamp(Number(msg.dx) || 0, -1, 1);
  const dy = clamp(Number(msg.dy) || 0, -1, 1);
  const nextX = clamp(player.x + dx, 0, WORLD.width - 1);
  const nextY = clamp(player.y + dy, 0, WORLD.height - 1);
  if (!isWalkable(nextX, nextY)) {
    return;
  }
  player.x = nextX;
  player.y = nextY;
}

function handleRename(player, msg, ws) {
  const parsed = parseNameAndRole(msg.name);
  if (!parsed.ok) {
    sendTo(ws, { type: "error", message: parsed.error });
    return;
  }

  if (isNameTaken(parsed.name, player.id)) {
    sendTo(ws, { type: "error", message: "Name already taken." });
    return;
  }

  player.name = parsed.name;
  player.isAdmin = parsed.isAdmin;
  sendTo(ws, { type: "rename_ok", name: player.name, isAdmin: player.isAdmin });
}

function handleSelectSeed(player, msg) {
  const cropType = String(msg.cropType || "");
  if (CROP_TYPES[cropType]) {
    player.selectedSeed = cropType;
  }
}

function handlePlant(player, msg, ws) {
  const cropType = String(msg.cropType || player.selectedSeed || "carrot");
  const crop = CROP_TYPES[cropType];
  if (!crop) {
    return;
  }

  const x = clamp(Math.floor(Number(msg.x)), 0, WORLD.width - 1);
  const y = clamp(Math.floor(Number(msg.y)), 0, WORLD.height - 1);

  if (!isInsideOwnedFarm(player, x, y)) {
    sendTo(ws, { type: "error", message: "Plant only inside your farm slot." });
    return;
  }

  if ((player.inventory[crop.seedKey] || 0) < 1) {
    sendTo(ws, { type: "error", message: `No ${cropType} seeds.` });
    return;
  }

  const key = tileKey(x, y);
  if (plots.has(key)) {
    sendTo(ws, { type: "error", message: "Plot already used." });
    return;
  }

  player.inventory[crop.seedKey] -= 1;
  plots.set(key, {
    x,
    y,
    ownerId: player.id,
    cropType,
    plantedAt: Date.now()
  });
}

function handleHarvest(player, msg, ws) {
  const x = clamp(Math.floor(Number(msg.x)), 0, WORLD.width - 1);
  const y = clamp(Math.floor(Number(msg.y)), 0, WORLD.height - 1);
  const key = tileKey(x, y);
  const plot = plots.get(key);
  if (!plot || plot.ownerId !== player.id) {
    return;
  }

  const crop = CROP_TYPES[plot.cropType];
  const growth = (Date.now() - plot.plantedAt) / crop.growthMs;
  if (growth < 1) {
    sendTo(ws, { type: "error", message: "Crop not ready." });
    return;
  }

  plots.delete(key);
  player.money += crop.price;
  player.harvested += 1;

  if (Math.random() < 0.35) {
    player.inventory[crop.seedKey] += 1;
    sendTo(ws, { type: "info", message: `Harvest bonus +1 ${crop.seedKey}` });
  }
}

function handleGather(player, ws) {
  const key = tileKey(player.x, player.y);
  if (!treasures.has(key)) {
    sendTo(ws, { type: "error", message: "No treasure chest on this tile." });
    return;
  }
  treasures.delete(key);
  const loot = awardTreasure(player);
  sendTo(ws, { type: "info", message: loot });
  fillTreasures();
}

function handleAdmin(player, msg, ws) {
  if (!player.isAdmin) {
    sendTo(ws, { type: "error", message: "Admin required." });
    return;
  }

  const action = String(msg.action || "");

  if (action === "clear_crops") {
    plots.clear();
    sendTo(ws, { type: "info", message: "All crops cleared." });
    return;
  }

  if (action === "respawn_treasures") {
    treasures.clear();
    fillTreasures();
    sendTo(ws, { type: "info", message: "Treasures respawned." });
    return;
  }

  if (action === "kick_player") {
    const targetId = Number(msg.targetId);
    if (!Number.isInteger(targetId) || targetId === player.id) {
      sendTo(ws, { type: "error", message: "Invalid target." });
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
}

function handleMessage(player, ws, msg) {
  switch (msg.type) {
    case "move":
      handleMove(player, msg);
      break;
    case "rename":
      handleRename(player, msg, ws);
      break;
    case "select_seed":
      handleSelectSeed(player, msg);
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
