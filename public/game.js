const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const statsEl = document.getElementById("stats");
const nameInput = document.getElementById("nameInput");
const setNameBtn = document.getElementById("setNameBtn");
const messageEl = document.getElementById("message");
const adminPanelEl = document.getElementById("adminPanel");
const adminPlayersEl = document.getElementById("adminPlayers");
const clearPlotsBtn = document.getElementById("clearPlotsBtn");

const ws = new WebSocket(`ws://${location.host}`);

const state = {
  yourId: null,
  world: { width: 26, height: 18, tileSize: 32 },
  crops: {},
  players: [],
  plots: [],
  isAdmin: false,
  message: ""
};

const keys = new Set();
let lastMoveAt = 0;

function playerById(id) {
  return state.players.find((p) => p.id === id) || null;
}

function showMessage(text) {
  state.message = text;
  messageEl.textContent = text;
}

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
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

function drawPlayer(p, tileSize) {
  const px = p.x * tileSize;
  const py = p.y * tileSize;

  ctx.fillStyle = p.id === state.yourId ? "#ffffff" : p.color;
  ctx.fillRect(px + 2, py + 2, tileSize - 4, tileSize - 4);

  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 2, py + 2, tileSize - 4, tileSize - 4);

  const label = p.isAdmin ? `[ADMIN] ${p.name}` : p.name;
  ctx.fillStyle = "#ffffff";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(label, px + tileSize / 2, py - 2);
}

function drawPlot(plot, tileSize) {
  const crop = state.crops[plot.cropType];
  const px = plot.x * tileSize;
  const py = plot.y * tileSize;

  ctx.fillStyle = "#6b4f2b";
  ctx.fillRect(px + 3, py + 3, tileSize - 6, tileSize - 6);

  const growth = Math.max(0, Math.min(1, plot.growth));

  if (growth < 0.33) {
    ctx.fillStyle = crop?.colorSeed || "#85603a";
    ctx.fillRect(px + tileSize / 2 - 3, py + tileSize / 2 - 3, 6, 6);
  } else if (growth < 1) {
    ctx.fillStyle = crop?.colorSprout || "#45b649";
    ctx.fillRect(px + tileSize / 2 - 3, py + 9, 6, tileSize - 16);
    ctx.fillRect(px + tileSize / 2 - 8, py + 10, 5, 5);
    ctx.fillRect(px + tileSize / 2 + 3, py + 10, 5, 5);
  } else {
    ctx.fillStyle = crop?.colorReady || "#f5841f";
    ctx.fillRect(px + tileSize / 2 - 7, py + tileSize / 2 - 7, 14, 14);
  }
}

function updateAdminPanel() {
  if (!state.isAdmin) {
    adminPanelEl.classList.add("hidden");
    adminPlayersEl.innerHTML = "";
    return;
  }

  adminPanelEl.classList.remove("hidden");
  const you = playerById(state.yourId);

  const rows = state.players
    .filter((p) => p.id !== state.yourId)
    .map((p) => {
      const adminTag = p.isAdmin ? " [ADMIN]" : "";
      return `
        <div class="admin-row">
          <span>${p.name}${adminTag}</span>
          <button data-kick="${p.id}">Kick</button>
        </div>
      `;
    })
    .join("");

  adminPlayersEl.innerHTML = `
    <p class="admin-sub">Logged in as: <b>${you ? you.name : "Admin"}</b></p>
    ${rows || '<p class="admin-sub">No other players to manage.</p>'}
  `;

  adminPlayersEl.querySelectorAll("button[data-kick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = Number(btn.getAttribute("data-kick"));
      send({ type: "admin", action: "kick_player", targetId });
    });
  });
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
    drawPlot(plot, tileSize);
  }

  for (const p of state.players) {
    drawPlayer(p, tileSize);
  }

  const you = playerById(state.yourId);
  if (you) {
    statsEl.innerHTML = [
      `You: <b>${you.name}</b>${you.isAdmin ? " (ADMIN)" : ""}`,
      `Money: <b>$${you.money}</b>`,
      `Harvested: <b>${you.harvested}</b>`,
      `Online players: <b>${state.players.length}</b>`
    ].join("<br>");
  }

  updateAdminPanel();
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

clearPlotsBtn.addEventListener("click", () => {
  send({ type: "admin", action: "clear_plots" });
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
    showMessage("Connected. Set a unique name.");
  }

  if (msg.type === "state") {
    state.players = msg.players || [];
    state.plots = msg.plots || [];
    state.world = msg.world || state.world;
    const me = playerById(state.yourId);
    state.isAdmin = Boolean(me && me.isAdmin);
  }

  if (msg.type === "error") {
    showMessage(msg.message || "Action failed.");
  }

  if (msg.type === "rename_ok") {
    state.isAdmin = Boolean(msg.isAdmin);
    if (state.isAdmin) {
      showMessage(`Name set to ${msg.name}. Admin panel unlocked.`);
    } else {
      showMessage(`Name set to ${msg.name}.`);
    }
  }

  if (msg.type === "kicked") {
    showMessage(msg.reason || "You were kicked.");
    ws.close();
  }
});

ws.addEventListener("open", () => {
  tick();
});
