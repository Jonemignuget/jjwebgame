const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const statsEl = document.getElementById("stats");
const nameInput = document.getElementById("nameInput");
const setNameBtn = document.getElementById("setNameBtn");

const ws = new WebSocket(`ws://${location.host}`);

const state = {
  yourId: null,
  world: { width: 26, height: 18, tileSize: 32 },
  crops: {},
  players: [],
  plots: []
};

const keys = new Set();
let lastMoveAt = 0;

function playerById(id) {
  return state.players.find((p) => p.id === id) || null;
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

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function render() {
  const { width, height, tileSize } = state.world;
  canvas.width = width * tileSize;
  canvas.height = height * tileSize;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      ctx.fillStyle = "#3f9b59";
      ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);

      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.strokeRect(x * tileSize, y * tileSize, tileSize, tileSize);
    }
  }

  for (const plot of state.plots) {
    const crop = state.crops[plot.cropType];
    const px = plot.x * tileSize;
    const py = plot.y * tileSize;

    ctx.fillStyle = "#6b4f2b";
    ctx.fillRect(px + 3, py + 3, tileSize - 6, tileSize - 6);

    const growth = Math.max(0, Math.min(1, plot.growth));

    if (growth < 0.33) {
      ctx.fillStyle = crop?.colorSeed || "#85603a";
      ctx.beginPath();
      ctx.arc(px + tileSize / 2, py + tileSize / 2, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (growth < 1) {
      ctx.fillStyle = crop?.colorSprout || "#45b649";
      ctx.fillRect(px + tileSize / 2 - 3, py + 9, 6, tileSize - 16);
      ctx.beginPath();
      ctx.arc(px + tileSize / 2 - 5, py + 12, 4, 0, Math.PI * 2);
      ctx.arc(px + tileSize / 2 + 5, py + 12, 4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = crop?.colorReady || "#f5841f";
      ctx.beginPath();
      ctx.arc(px + tileSize / 2, py + tileSize / 2, 8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const p of state.players) {
    const px = p.x * tileSize;
    const py = p.y * tileSize;

    ctx.fillStyle = p.id === state.yourId ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.15)";
    ctx.fillRect(px, py, tileSize, tileSize);

    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(px + tileSize / 2, py + tileSize / 2, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.name, px + tileSize / 2, py + tileSize - 4);
  }

  const you = playerById(state.yourId);
  if (you) {
    statsEl.innerHTML = [
      `You: <b>${you.name}</b>`,
      `Money: <b>$${you.money}</b>`,
      `Harvested: <b>${you.harvested}</b>`,
      `Online players: <b>${state.players.length}</b>`
    ].join("<br>");
  }
}

function tick() {
  const now = performance.now();
  const move = keyToMove();

  if ((move.dx !== 0 || move.dy !== 0) && now - lastMoveAt > 95) {
    send({ type: "move", dx: move.dx, dy: move.dy });
    lastMoveAt = now;
  }

  render();
  requestAnimationFrame(tick);
}

window.addEventListener("keydown", (e) => {
  keys.add(e.key);

  if (e.key === "e" || e.key === "E") {
    const you = playerById(state.yourId);
    if (you) {
      send({ type: "plant", x: you.x, y: you.y, cropType: "carrot" });
    }
  }

  if (e.key === "f" || e.key === "F") {
    const you = playerById(state.yourId);
    if (you) {
      send({ type: "harvest", x: you.x, y: you.y });
    }
  }
});

window.addEventListener("keyup", (e) => {
  keys.delete(e.key);
});

setNameBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) return;
  send({ type: "rename", name });
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
    state.world = msg.world || state.world;
    state.crops = msg.crops || {};
  }

  if (msg.type === "state") {
    state.players = msg.players || [];
    state.plots = msg.plots || [];
    state.world = msg.world || state.world;
  }
});

ws.addEventListener("open", () => {
  tick();
});
