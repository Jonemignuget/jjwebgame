const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const SAVE_PATH = path.join(__dirname, "save-data.json");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const WORLD = {
  width: 260,
  height: 180,
  tileSize: 20,
  lobby: { x: 98, y: 62, w: 64, h: 56 }
};

const CROP_TYPES = {
  carrot: {
    growthMs: 30000,
    price: 4,
    seedKey: "carrotSeed",
    colorSeed: "#8a5a2b",
    colorSprout: "#58c85d",
    colorReady: "#ff8b2b"
  },
  pumpkin: {
    growthMs: 30000,
    price: 8,
    seedKey: "pumpkinSeed",
    colorSeed: "#7a4d23",
    colorSprout: "#61b655",
    colorReady: "#f09b2d"
  }
};

const TREASURE_TARGET = 90;
const TREASURE_MIN_DIST = 8;
const MONSTER_MAX_GLOBAL = 20;
const MONSTER_PER_FOREST_PLAYER = 4;
const MONSTER_SPAWN_RING_MIN = 10;
const MONSTER_SPAWN_RING_MAX = 24;
const MONSTER_DESPAWN_DIST = 45;

const players = new Map();
const socketsByPlayerId = new Map();
const plots = new Map();
const treasures = new Map();
const monsters = new Map();
const farmSlots = buildFarmSlots();
let nextPlayerId = 1;
let nextMonsterId = 1;

let saveData = loadSaveData();

function loadSaveData() {
  try {
    if (!fs.existsSync(SAVE_PATH)) {
      return { profiles: {} };
    }
    const raw = fs.readFileSync(SAVE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { profiles: {} };
    }
    if (!parsed.profiles || typeof parsed.profiles !== "object") {
      parsed.profiles = {};
    }
    return parsed;
  } catch {
    return { profiles: {} };
  }
}

function persistSaveData() {
  fs.writeFileSync(SAVE_PATH, JSON.stringify(saveData, null, 2), "utf8");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function tileKey(x, y) {
  return `${x},${y}`;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isInRect(x, y, rect) {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
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
  return isInsideWorld(x, y);
}

function buildFarmSlots() {
  const slots = [];
  const w = 8;
  const h = 5;
  const gapX = 3;
  const startX = 106;
  const rowTopY = 76;
  const rowBottomY = 100;

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
    farmSlotId: player.farmSlotId,
    inventory: player.inventory,
    stamina: player.stamina,
    health: player.health,
    maxHealth: player.maxHealth,
    equippedItem: player.equippedItem
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
      plantedAt: plot.plantedAt,
      growth,
      ready: growth >= 1
    });
  }
  return out;
}

function serializeTreasures() {
  return Array.from(treasures.values());
}

function serializeMonsters() {
  return Array.from(monsters.values());
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
    treasures: serializeTreasures(),
    monsters: serializeMonsters(),
    serverTime: Date.now()
  });
}

function colorFromId(id) {
  return `hsl(${(id * 67) % 360}, 70%, 55%)`;
}

function parseName(rawName) {
  const name = String(rawName || "").trim();
  if (!name) {
    return { ok: false, error: "Name cannot be empty." };
  }
  if (name.length > 16) {
    return { ok: false, error: "Name must be 16 characters or less." };
  }
  return { ok: true, name };
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
  for (let i = 0; i < 300; i++) {
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

function assignFarmSlot(playerId, preferredSlotId = null) {
  if (preferredSlotId) {
    const preferred = farmSlots.find((s) => s.id === preferredSlotId && s.ownerId === null);
    if (preferred) {
      preferred.ownerId = playerId;
      return preferred.id;
    }
  }

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

function lobbyCenter() {
  return {
    x: WORLD.lobby.x + WORLD.lobby.w / 2,
    y: WORLD.lobby.y + WORLD.lobby.h / 2
  };
}

function chestRarityForPosition(x, y) {
  const center = lobbyCenter();
  const d = dist({ x, y }, center);

  let rareWeight = 0.09;
  let legendaryWeight = 0.01;

  if (d > 60) {
    rareWeight = 0.18;
    legendaryWeight = 0.04;
  }
  if (d > 95) {
    rareWeight = 0.28;
    legendaryWeight = 0.12;
  }

  const roll = Math.random();
  if (roll < legendaryWeight) {
    return "legendary";
  }
  if (roll < legendaryWeight + rareWeight) {
    return "rare";
  }
  return "common";
}

function spawnTreasure() {
  for (let i = 0; i < 600; i++) {
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

    let tooClose = false;
    for (const chest of treasures.values()) {
      if (Math.abs(chest.x - x) + Math.abs(chest.y - y) < TREASURE_MIN_DIST) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) {
      continue;
    }

    treasures.set(key, {
      key,
      x,
      y,
      rarity: chestRarityForPosition(x, y)
    });
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

function treasureReward(player, chest) {
  if (chest.rarity === "legendary") {
    const seeds = randomInt(5, 9);
    player.inventory.pumpkinSeed += seeds;
    player.inventory.gear += 2;
    player.inventory.sword += 1;
    player.money += randomInt(20, 35);
    return `Legendary chest: +${seeds} pumpkin seeds, +1 sword`;
  }

  if (chest.rarity === "rare") {
    const seeds = randomInt(3, 6);
    player.inventory.carrotSeed += seeds;
    player.inventory.pumpkinSeed += randomInt(1, 3);
    player.inventory.gear += 1;
    if (Math.random() < 0.35) {
      player.inventory.sword += 1;
    }
    player.money += randomInt(8, 18);
    return "Rare chest loot found";
  }

  const roll = Math.random();
  if (roll < 0.5) {
    const qty = randomInt(2, 5);
    player.inventory.carrotSeed += qty;
    return `Common chest: +${qty} carrot seeds`;
  }
  if (roll < 0.8) {
    const qty = randomInt(1, 3);
    player.inventory.pumpkinSeed += qty;
    return `Common chest: +${qty} pumpkin seeds`;
  }
  if (roll < 0.9) {
    player.inventory.sword += 1;
    return "Common chest: +1 sword";
  }

  const coins = randomInt(3, 8);
  player.money += coins;
  return `Common chest: +$${coins}`;
}

function findForestSpawnAround(player) {
  for (let i = 0; i < 140; i++) {
    const dx = randomInt(-MONSTER_SPAWN_RING_MAX, MONSTER_SPAWN_RING_MAX);
    const dy = randomInt(-MONSTER_SPAWN_RING_MAX, MONSTER_SPAWN_RING_MAX);
    const d = Math.abs(dx) + Math.abs(dy);
    if (d < MONSTER_SPAWN_RING_MIN || d > MONSTER_SPAWN_RING_MAX) {
      continue;
    }

    const x = clamp(player.x + dx, 0, WORLD.width - 1);
    const y = clamp(player.y + dy, 0, WORLD.height - 1);
    if (!isForestTile(x, y)) {
      continue;
    }

    const occupied = Array.from(monsters.values()).some((m) => m.x === x && m.y === y);
    if (occupied) {
      continue;
    }

    return { x, y };
  }

  return null;
}

function forestPlayers() {
  return Array.from(players.values()).filter((p) => isForestTile(p.x, p.y));
}

function rebalanceMonsters() {
  const activePlayers = forestPlayers();

  if (activePlayers.length === 0) {
    monsters.clear();
    return;
  }

  for (const [id, monster] of monsters) {
    let nearAny = false;
    for (const p of activePlayers) {
      if (dist(monster, p) <= MONSTER_DESPAWN_DIST) {
        nearAny = true;
        break;
      }
    }
    if (!nearAny) {
      monsters.delete(id);
    }
  }

  const target = Math.min(MONSTER_MAX_GLOBAL, activePlayers.length * MONSTER_PER_FOREST_PLAYER);
  let guard = 0;

  while (monsters.size < target && guard < 200) {
    guard += 1;
    const anchor = activePlayers[randomInt(0, activePlayers.length - 1)];
    const pos = findForestSpawnAround(anchor);
    if (!pos) {
      continue;
    }

    const id = nextMonsterId++;
    monsters.set(id, { id, x: pos.x, y: pos.y, hp: 30 });
  }

  while (monsters.size > target) {
    const first = monsters.keys().next().value;
    monsters.delete(first);
  }
}

function moveTowards(from, to) {
  const dx = clamp(to.x - from.x, -1, 1);
  const dy = clamp(to.y - from.y, -1, 1);
  return { dx, dy };
}

function tickMonsters() {
  const now = Date.now();
  const activePlayers = forestPlayers();

  for (const monster of monsters.values()) {
    let nearest = null;
    let nearestDist = Infinity;

    for (const player of activePlayers) {
      const d = Math.abs(player.x - monster.x) + Math.abs(player.y - monster.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = player;
      }
    }

    if (!nearest) {
      continue;
    }

    const step = moveTowards(monster, nearest);
    const moves = Math.random() < 0.25 ? 2 : 1;

    for (let i = 0; i < moves; i++) {
      const nx = clamp(monster.x + step.dx, 0, WORLD.width - 1);
      const ny = clamp(monster.y + step.dy, 0, WORLD.height - 1);
      if (isWalkable(nx, ny) && isForestTile(nx, ny)) {
        monster.x = nx;
        monster.y = ny;
      }
    }

    if (monster.x === nearest.x && monster.y === nearest.y) {
      if (!nearest.lastDamagedAt || now - nearest.lastDamagedAt > 650) {
        nearest.lastDamagedAt = now;
        nearest.health = clamp(nearest.health - 8, 0, nearest.maxHealth);

        if (nearest.health <= 0) {
          const lobbySpawn = findOpenSpawnInLobby();
          nearest.x = lobbySpawn.x;
          nearest.y = lobbySpawn.y;
          nearest.health = nearest.maxHealth;
          nearest.stamina = 100;
          nearest.money = Math.max(0, nearest.money - 10);

          const sock = socketsByPlayerId.get(nearest.id);
          if (sock) {
            sendTo(sock, { type: "info", message: "You were downed by a monster. -$10" });
          }
        }
      }
    }
  }
}

function saveProfile(player) {
  if (!player.accountName) {
    return;
  }

  const slot = getFarmSlotForPlayer(player);
  const savedPlots = [];
  for (const plot of plots.values()) {
    if (plot.ownerId !== player.id) {
      continue;
    }

    const dx = slot ? plot.x - slot.x : 0;
    const dy = slot ? plot.y - slot.y : 0;
    savedPlots.push({ dx, dy, cropType: plot.cropType, plantedAt: plot.plantedAt });
  }

  saveData.profiles[player.accountName] = {
    name: player.name,
    money: player.money,
    harvested: player.harvested,
    inventory: player.inventory,
    health: player.health,
    maxHealth: player.maxHealth,
    stamina: player.stamina,
    selectedSeed: player.selectedSeed,
    equippedItem: player.equippedItem,
    preferredSlotId: player.farmSlotId,
    savedPlots
  };

  persistSaveData();
}

function loadProfileIntoPlayer(player, profile) {
  player.money = Number(profile.money) || 0;
  player.harvested = Number(profile.harvested) || 0;
  player.health = clamp(Number(profile.health) || 100, 1, 100);
  player.maxHealth = clamp(Number(profile.maxHealth) || 100, 50, 100);
  player.stamina = clamp(Number(profile.stamina) || 100, 0, 100);
  player.selectedSeed = CROP_TYPES[profile.selectedSeed] ? profile.selectedSeed : "carrot";

  const inv = profile.inventory || {};
  player.inventory = {
    carrotSeed: Math.max(0, Number(inv.carrotSeed) || 0),
    pumpkinSeed: Math.max(0, Number(inv.pumpkinSeed) || 0),
    gear: Math.max(0, Number(inv.gear) || 0),
    sword: Math.max(0, Number(inv.sword) || 0)
  };

  player.equippedItem = player.inventory.sword > 0 && profile.equippedItem === "sword" ? "sword" : "none";

  releaseFarmSlot(player.id);
  player.farmSlotId = assignFarmSlot(player.id, Number(profile.preferredSlotId) || null);

  const slot = getFarmSlotForPlayer(player);
  if (slot && Array.isArray(profile.savedPlots)) {
    for (const p of profile.savedPlots) {
      const x = slot.x + (Number(p.dx) || 0);
      const y = slot.y + (Number(p.dy) || 0);
      if (!isInsideOwnedFarm(player, x, y)) {
        continue;
      }
      const cropType = CROP_TYPES[p.cropType] ? p.cropType : "carrot";
      plots.set(tileKey(x, y), {
        x,
        y,
        ownerId: player.id,
        cropType,
        plantedAt: Number(p.plantedAt) || Date.now()
      });
    }
  }
}

function handleMove(player, msg) {
  const dx = clamp(Number(msg.dx) || 0, -1, 1);
  const dy = clamp(Number(msg.dy) || 0, -1, 1);

  const sprint = Boolean(msg.sprint);
  let steps = 1;

  if (sprint && player.stamina >= 8) {
    steps = 2;
    player.stamina = clamp(player.stamina - 8, 0, 100);
  } else {
    player.stamina = clamp(player.stamina + 2, 0, 100);
  }

  for (let i = 0; i < steps; i++) {
    const nx = clamp(player.x + dx, 0, WORLD.width - 1);
    const ny = clamp(player.y + dy, 0, WORLD.height - 1);
    if (isWalkable(nx, ny)) {
      player.x = nx;
      player.y = ny;
    }
  }
}

function handleRename(player, msg, ws) {
  const parsed = parseName(msg.name);
  if (!parsed.ok) {
    sendTo(ws, { type: "error", message: parsed.error });
    return;
  }

  if (isNameTaken(parsed.name, player.id)) {
    sendTo(ws, { type: "error", message: "Name already taken." });
    return;
  }

  player.name = parsed.name;
  player.accountName = parsed.name.toLowerCase();

  const profile = saveData.profiles[player.accountName];
  if (profile) {
    loadProfileIntoPlayer(player, profile);
    sendTo(ws, { type: "info", message: "Saved data loaded." });
  } else {
    saveProfile(player);
  }

  sendTo(ws, { type: "rename_ok", name: player.name });
}

function handleSelectSeed(player, msg) {
  const cropType = String(msg.cropType || "");
  if (CROP_TYPES[cropType]) {
    player.selectedSeed = cropType;
  }
}

function handleEquip(player, msg, ws) {
  const item = String(msg.item || "none");
  if (item === "sword") {
    if ((player.inventory.sword || 0) < 1) {
      sendTo(ws, { type: "error", message: "No sword in inventory." });
      return;
    }
    player.equippedItem = "sword";
    return;
  }

  player.equippedItem = "none";
}

function handleAttack(player, ws) {
  if (player.equippedItem !== "sword" || (player.inventory.sword || 0) < 1) {
    sendTo(ws, { type: "error", message: "Equip a sword first." });
    return;
  }

  let hits = 0;
  const dead = [];
  for (const monster of monsters.values()) {
    const d = Math.abs(monster.x - player.x) + Math.abs(monster.y - player.y);
    if (d <= 1) {
      monster.hp -= 20;
      hits += 1;
      if (monster.hp <= 0) {
        dead.push(monster.id);
        player.money += 3;
      }
    }
  }

  for (const id of dead) {
    monsters.delete(id);
  }

  if (hits === 0) {
    sendTo(ws, { type: "error", message: "No monster in range." });
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

  saveProfile(player);
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

  saveProfile(player);
}

function handleGather(player, ws) {
  const key = tileKey(player.x, player.y);
  const chest = treasures.get(key);
  if (!chest) {
    sendTo(ws, { type: "error", message: "No treasure chest on this tile." });
    return;
  }

  treasures.delete(key);
  const loot = treasureReward(player, chest);
  sendTo(ws, { type: "info", message: loot });
  fillTreasures();

  saveProfile(player);
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
    case "equip":
      handleEquip(player, msg, ws);
      break;
    case "attack":
      handleAttack(player, ws);
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
    default:
      break;
  }

  saveProfile(player);
}

fillTreasures();

wss.on("connection", (ws) => {
  const id = nextPlayerId++;
  const spawn = findOpenSpawnInLobby();
  const farmSlotId = assignFarmSlot(id);

  const player = {
    id,
    name: `Farmer${id}`,
    accountName: null,
    x: spawn.x,
    y: spawn.y,
    color: colorFromId(id),
    money: 0,
    harvested: 0,
    farmSlotId,
    selectedSeed: "carrot",
    equippedItem: "none",
    inventory: {
      carrotSeed: 2,
      pumpkinSeed: 1,
      gear: 0,
      sword: 0
    },
    stamina: 100,
    health: 100,
    maxHealth: 100,
    lastDamagedAt: 0
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
    saveProfile(player);
    players.delete(id);
    socketsByPlayerId.delete(id);
    releaseFarmSlot(id);
    broadcastState();
  });
});

setInterval(() => {
  rebalanceMonsters();
  tickMonsters();

  for (const player of players.values()) {
    player.stamina = clamp(player.stamina + 1.2, 0, 100);
    saveProfile(player);
  }

  fillTreasures();
  broadcastState();
}, 220);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
