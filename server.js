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
  width: 26,
  height: 18,
  tileSize: 32
};

const CROP_TYPES = {
  carrot: {
    growthMs: 12000,
    price: 4,
    colorSeed: "#85603a",
    colorSprout: "#45b649",
    colorReady: "#f5841f"
  }
};

const players = new Map();
const socketsByPlayerId = new Map();
const plots = new Map();
let nextPlayerId = 1;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomSpawn() {
  return {
    x: Math.floor(Math.random() * WORLD.width),
    y: Math.floor(Math.random() * WORLD.height)
  };
}

function tileKey(x, y) {
  return `${x},${y}`;
}

function serializePlots(now = Date.now()) {
  const out = [];
  for (const [key, plot] of plots) {
    const crop = CROP_TYPES[plot.cropType];
    const elapsed = now - plot.plantedAt;
    const growth = clamp(elapsed / crop.growthMs, 0, 1);
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

function serializePlayers() {
  const out = [];
  for (const player of players.values()) {
    out.push({
      id: player.id,
      name: player.name,
      x: player.x,
      y: player.y,
      color: player.color,
      money: player.money,
      harvested: player.harvested,
      isAdmin: player.isAdmin
    });
  }
  return out;
}

function sendTo(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
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
    players: serializePlayers(),
    plots: serializePlots(),
    world: WORLD
  });
}

function colorFromId(id) {
  const hue = (id * 67) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function normalizeName(name) {
  return String(name).trim().toLowerCase();
}

function isNameTaken(name, exceptPlayerId = null) {
  const normalized = normalizeName(name);
  for (const player of players.values()) {
    if (player.id === exceptPlayerId) {
      continue;
    }
    if (normalizeName(player.name) === normalized) {
      return true;
    }
  }
  return false;
}

function parseNameAndRole(rawName) {
  const raw = String(rawName || "").trim();
  if (!raw) {
    return { ok: false, error: "Name cannot be empty." };
  }

  const adminMatch = raw.match(/^\(\(admin\)\s+(.+)$/i);
  const isAdmin = Boolean(adminMatch);
  let candidate = (adminMatch ? adminMatch[1] : raw).trim();

  if (candidate.startsWith("(") && candidate.endsWith(")") && candidate.length > 2) {
    candidate = candidate.slice(1, -1).trim();
  }

  if (!candidate) {
    return { ok: false, error: "Name cannot be empty." };
  }

  if (candidate.length > 16) {
    return { ok: false, error: "Name must be 16 characters or less." };
  }

  return { ok: true, name: candidate, isAdmin };
}

function handleMove(player, message) {
  const dx = clamp(Number(message.dx) || 0, -1, 1);
  const dy = clamp(Number(message.dy) || 0, -1, 1);
  player.x = clamp(player.x + dx, 0, WORLD.width - 1);
  player.y = clamp(player.y + dy, 0, WORLD.height - 1);
}

function handlePlant(player, message) {
  const x = clamp(Math.floor(Number(message.x)), 0, WORLD.width - 1);
  const y = clamp(Math.floor(Number(message.y)), 0, WORLD.height - 1);
  const cropType = message.cropType in CROP_TYPES ? message.cropType : "carrot";

  const key = tileKey(x, y);
  if (plots.has(key)) {
    return;
  }

  plots.set(key, {
    x,
    y,
    ownerId: player.id,
    cropType,
    plantedAt: Date.now()
  });
}

function handleHarvest(player, message) {
  const x = clamp(Math.floor(Number(message.x)), 0, WORLD.width - 1);
  const y = clamp(Math.floor(Number(message.y)), 0, WORLD.height - 1);
  const key = tileKey(x, y);
  const plot = plots.get(key);

  if (!plot || plot.ownerId !== player.id) {
    return;
  }

  const crop = CROP_TYPES[plot.cropType];
  if (!crop) {
    return;
  }

  const growth = (Date.now() - plot.plantedAt) / crop.growthMs;
  if (growth < 1) {
    return;
  }

  plots.delete(key);
  player.money += crop.price;
  player.harvested += 1;
}

function handleRename(player, message, ws) {
  const parsed = parseNameAndRole(message.name);
  if (!parsed.ok) {
    sendTo(ws, { type: "error", message: parsed.error });
    return false;
  }

  if (isNameTaken(parsed.name, player.id)) {
    sendTo(ws, { type: "error", message: "That name is already in use." });
    return false;
  }

  player.name = parsed.name;
  player.isAdmin = parsed.isAdmin;
  sendTo(ws, { type: "rename_ok", name: player.name, isAdmin: player.isAdmin });
  return true;
}

function handleAdmin(player, message, ws) {
  if (!player.isAdmin) {
    sendTo(ws, { type: "error", message: "Admin access required." });
    return false;
  }

  const action = String(message.action || "");

  if (action === "clear_plots") {
    plots.clear();
    return true;
  }

  if (action === "kick_player") {
    const targetId = Number(message.targetId);
    if (!Number.isInteger(targetId)) {
      sendTo(ws, { type: "error", message: "Invalid target ID." });
      return false;
    }
    if (targetId === player.id) {
      sendTo(ws, { type: "error", message: "You cannot kick yourself." });
      return false;
    }

    const targetSocket = socketsByPlayerId.get(targetId);
    if (!targetSocket) {
      sendTo(ws, { type: "error", message: "Player is not online." });
      return false;
    }

    sendTo(targetSocket, { type: "kicked", reason: `Kicked by admin ${player.name}` });
    targetSocket.close();
    return true;
  }

  sendTo(ws, { type: "error", message: "Unknown admin action." });
  return false;
}

wss.on("connection", (ws) => {
  const id = nextPlayerId++;
  const spawn = randomSpawn();

  const player = {
    id,
    name: `Farmer${id}`,
    x: spawn.x,
    y: spawn.y,
    color: colorFromId(id),
    money: 0,
    harvested: 0,
    isAdmin: false
  };

  players.set(id, player);
  socketsByPlayerId.set(id, ws);

  sendTo(ws, {
    type: "welcome",
    yourId: id,
    world: WORLD,
    crops: CROP_TYPES
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

    switch (msg.type) {
      case "move":
        handleMove(player, msg);
        break;
      case "plant":
        handlePlant(player, msg);
        break;
      case "harvest":
        handleHarvest(player, msg);
        break;
      case "rename":
        handleRename(player, msg, ws);
        break;
      case "admin":
        handleAdmin(player, msg, ws);
        break;
      default:
        return;
    }

    broadcastState();
  });

  ws.on("close", () => {
    players.delete(id);
    socketsByPlayerId.delete(id);
    broadcastState();
  });
});

setInterval(() => {
  broadcastState();
}, 500);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
