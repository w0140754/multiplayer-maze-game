import http from "http";
import fs from "fs";
import path from "path";
import url from "url";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import { getMapTemplates } from "./maps_data.js";

import pg from "pg";
const { Pool } = pg;

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

if (pool) {
  pool.on("error", (err) => {
    console.error("❌ Postgres pool error:", err?.message || err);
  });
}


/* ==========================================================
   DEV / READABILITY HELPERS
   - Toggle logging by setting: DEV.log = true
========================================================== */
const DEV = { log: true };
const dlog = (...args) => { if (DEV.log) console.log(...args); };

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// DEV FLAG: set to false to disable the in-game map editor network messages
const ENABLE_MAP_EDITOR = true;
const MAP_EDITOR_DEBUG_LOG = true; // set false to silence editor logs

// DEV FLAG: set to false to disable the F9 "spawn item" testing feature
const ENABLE_DEV_SPAWN = true;

//SQL POSTGRES
async function ensurePostgresSchema() {
  if (!pool) {
    console.log("🟦 Postgres disabled (no DATABASE_URL).");
    return;
  }

  await pool.query(`
    create table if not exists players (
      name text primary key,
      level int not null default 1,
      xp int not null default 0,
      xp_next int not null default 0,
      atk int not null default 10,
	      speed int not null default 100,
      hp int not null default 100,
      max_hp int not null default 100,
      map_id text not null default 'C',
      x real not null default 0,
      y real not null default 0,
      gold int not null default 0,
      equipment jsonb not null default '{}'::jsonb,
      inventory jsonb not null default '{}'::jsonb,
      quests jsonb not null default '{}'::jsonb,
      hotbar jsonb not null default '[]'::jsonb,
      monster_book jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
  `);

    // Add new columns safely for existing deployments
  await pool.query(`alter table players add column if not exists hotbar jsonb not null default '[]'::jsonb;`);

await pool.query(`create index if not exists players_updated_at_idx on players(updated_at);`);

  // Migration: add monster_book if table already existed
  await pool.query(`alter table players add column if not exists monster_book jsonb not null default '{}'::jsonb;`);

  console.log("✅ Postgres schema ensured.");
}

// Paste these below ensurePostgresSchema() (or anywhere above wss.on("connection")):


async function dbLoadPlayerByName(name) {
  if (!pool) return null;
  const { rows } = await pool.query("select * from players where name = $1", [name]);
  return rows[0] || null;
}

async function dbSavePlayer(p) {
  if (!pool) return;
  if (!p?.name) return;

  await pool.query(
    `
    insert into players
      (name, level, xp, xp_next, atk, speed, hp, max_hp, map_id, x, y, gold, equipment, inventory, quests, hotbar, monster_book, updated_at)
    values
      ($1,   $2,    $3, $4,     $5,  $6,    $7, $8,     $9,    $10,$11,$12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, now())
    on conflict (name) do update set
      level=excluded.level,
      xp=excluded.xp,
      xp_next=excluded.xp_next,
      atk=excluded.atk,
      speed=excluded.speed,
      hp=excluded.hp,
      max_hp=excluded.max_hp,
      map_id=excluded.map_id,
      x=excluded.x,
      y=excluded.y,
      gold=excluded.gold,
      equipment=excluded.equipment,
      inventory=excluded.inventory,
      quests=excluded.quests,
      hotbar=excluded.hotbar,
      monster_book=excluded.monster_book,
      updated_at=now()
`,
    [
      p.name,
      p.level ?? 1,
      p.xp ?? 0,
      p.xpNext ?? xpToNext(p.level ?? 1),
      p.atk ?? 10,
            p.speed ?? 100,
      p.hp ?? 100,
      p.maxHp ?? 100,
      p.mapId ?? "C",
      Number.isFinite(p.x) ? p.x : 0,
      Number.isFinite(p.y) ? p.y : 0,
      p.gold ?? 0,
      JSON.stringify(p.equipment || { weapon: null, armor: null, hat: null, accessory: null }),
      JSON.stringify(p.inventory || { size: 24, slots: [] }),
      JSON.stringify(p.quests || {}),
      JSON.stringify(p.hotbar || new Array(6).fill(null)),
      JSON.stringify(p.monsterBook || {}),
    ]
  );
}

function applyRowToPlayer(p, row) {
  // Keep runtime-only fields (id, inputs, timers) but load the persistent ones
  if (!row) return;

  p.level = row.level ?? p.level;
  p.xp = row.xp ?? p.xp;
  p.xpNext = row.xp_next ?? p.xpNext;
  p.atk = row.atk ?? p.atk;
  p.speed = row.speed ?? p.speed ?? 100;
  p.hp = row.hp ?? p.hp;
  p.maxHp = row.max_hp ?? p.maxHp;

  // map/pos (validate)
  const mapId = (row.map_id || p.mapId || "C").toString();
  p.mapId = maps[mapId] ? mapId : (p.mapId || "C");
  p.x = Number.isFinite(row.x) ? row.x : p.x;
  p.y = Number.isFinite(row.y) ? row.y : p.y;

  // jsonb comes back as object in pg
  p.equipment = row.equipment && typeof row.equipment === "object"
    ? row.equipment
    : (p.equipment || { weapon: null, armor: null, hat: null, accessory: null });

  p.inventory = row.inventory && typeof row.inventory === "object"
    ? row.inventory
    : (p.inventory || { size: 24, slots: [] });

  p.quests = row.quests && typeof row.quests === "object"
    ? row.quests
    : (p.quests || {});

  p.hotbar = Array.isArray(row.hotbar)
    ? row.hotbar
    : (p.hotbar || new Array(6).fill(null));

  if (!Array.isArray(p.hotbar) || p.hotbar.length !== 6) p.hotbar = new Array(6).fill(null);

  p.monsterBook = row.monster_book && typeof row.monster_book === "object"
    ? row.monster_book
    : (p.monsterBook || {});

  p.gold = row.gold ?? p.gold;

  // Keep combat pipeline consistent with equipment
  const equippedWeaponId = p.equipment?.weapon || null;
  const def = equippedWeaponId ? ITEMS[equippedWeaponId] : null;
  p.weapon = def?.weaponKey || null;

  // Recompute derived bonuses from equipment (e.g., Speed from accessories)
  if (typeof recomputePlayerBonuses === "function") recomputePlayerBonuses(p);

  // Clamp in case map changed or coords are bad
  clampToWorldPlayer(p.mapId, p);
}






//


/* ======================
   HTTP FILE SERVER
====================== */
const server = http.createServer((req, res) => {
  const requested = req.url === "/" ? "/index.html" : req.url;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, "public", safePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html" ? "text/html" :
      ext === ".js" ? "text/javascript" :
      ext === ".css" ? "text/css" :
      ext === ".png" ? "image/png" :
      "application/octet-stream";

    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

/* ======================
   MAPS (multi-zone)
   Ground tiles use tiles.png indices (0-based).
   Convention: odd rows are passable, even rows are blocked.
   (portal positions are defined separately)
   (portal positions are defined separately)
   4 statue (save)
====================== */
const TILE = 64;
const PORTAL_TILE = 3;
// tiles.png has 5 columns per row (matches client TILESET_COLS)
const GROUND_TILESET_COLS = 5;
// Convention: odd rows in tiles.png are passable; even rows are blocked.
// Row 2, Col 1 (1-based) is our default wall/stone tile.
const WALL_TILE = GROUND_TILESET_COLS; // == 5 when cols=5
// Map editor: allow painting any ground tile id up to this value (client will only show what exists in tiles.png)
const EDITOR_MAX_GROUND_TILE = 999;
function makeBorderMap(w, h) {
  const map = Array.from({ length: h }, () => Array(w).fill(0));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) map[y][x] = WALL_TILE;
    }
  }
  return map;
}

function makeEmptyLayer(w, h, fill = 0) {
  return Array.from({ length: h }, () => Array(w).fill(fill));
}


// Map templates are loaded from maps_data.js so editor exports can be copy/pasted there.
const mapTemplates = getMapTemplates();

function clone2D(grid) {
  return grid.map(row => row.slice());
}
function clonePortals(portals) {
  return (portals || []).map(p => ({ ...p }));
}
function cloneMap(m) {
  return {
    id: m.id,
    w: m.w,
    h: m.h,
    map: clone2D(m.map),
    obj: m.obj ? clone2D(m.obj) : makeEmptyLayer(m.w, m.h, 0),
    portals: clonePortals(m.portals),
  };
}

// Live, editable maps used for collision, portals, snapshots, etc.
let maps = {
  A: cloneMap(mapTemplates.A),
  B: cloneMap(mapTemplates.B),
  C: cloneMap(mapTemplates.C),
  D: cloneMap(mapTemplates.D),
};

function tileAt(mapId, x, y) {
  const m = maps[mapId];
  if (!m) return WALL_TILE;
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return WALL_TILE;
  return m.map[ty][tx];
}

function objAt(mapId, x, y) {
  const m = maps[mapId];
  if (!m) return 0;
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return 0;
  return (m.obj && m.obj[ty] ? m.obj[ty][tx] : 0) || 0;
}

// Ground collision tiles (tiles.png indices are 0-based)
function groundTileRow1Based(tile) {
  if (tile == null || tile < 0) return 0;
  const row0 = Math.floor(tile / GROUND_TILESET_COLS);
  return row0 + 1; // 1-based
}
// Odd rows are passable, even rows are blocked.
function isSolid(tile) {
  const r = groundTileRow1Based(tile);
  return r > 0 && (r % 2 === 0);
}

// tiles_objects.png has 5 columns per row (matches client TILESET_COLS)
const OBJ_TILESET_COLS = 5;

function objTileRow1Based(objTile) {
  // objTile is 1-based for tiles_objects.png (0 = empty)
  if (!objTile) return 0;
  const idx0 = objTile - 1;
  const row0 = Math.floor(idx0 / OBJ_TILESET_COLS);
  return row0 + 1; // 1-based row
}

// Even rows (2,4,6,...) are solid (blocked). Odd rows are canopy (passable, drawn on top).
function isObjSolid(objTile) {
  const r = objTileRow1Based(objTile);
  return r > 0 && (r % 2 === 0);
}

function isBlocked(mapId, x, y) {
  return isSolid(tileAt(mapId, x, y)) || isObjSolid(objAt(mapId, x, y));
}

/* ======================
   COLLISION

====================== */
const PLAYER_RADIUS = 16;
const NPC_RADIUS = 16;
const MOB_RADIUS = 16;
// If a mob sprite is larger (e.g. 64x64), give it a larger collision circle.
// Tune these numbers for gameplay feel (server-authoritative).
const MOB_DEFS = {
  // Keep all mob tuning in one place: stats, rewards, collision, behavior.
  // Knockback tuning is per-mob so heavier mobs are harder to shove around.
  green: {
    radius: 28, maxHp: 50,  damage: 15, xp: 1, passiveUntilHit: true,
    knockbackThreshold: 10, knockbackDist: 30,
  },
  pink: {
    radius: 28, maxHp: 80,  damage: 20, xp: 1, passiveUntilHit: false,
    knockbackThreshold: 12, knockbackDist: 30,
  },
  orange: {
    radius: 28, maxHp: 120, damage: 20, xp: 1, passiveUntilHit: false,
    knockbackThreshold: 15, knockbackDist: 30,
  },
  purple: {
    radius: 28, maxHp: 150, damage: 25, xp: 1, passiveUntilHit: false,
    knockbackThreshold: 18, knockbackDist: 30,
  },
  rainbow: {
    radius: 28, maxHp: 300, damage: 35, xp: 1, passiveUntilHit: false,
    knockbackThreshold: 25, knockbackDist: 30,
  },
  snail_blue: {
    radius: 28, maxHp: 180, damage: 30, xp: 1, passiveUntilHit: false,
    knockbackThreshold: 22, knockbackDist: 30,
  },
  snail_red: {
    radius: 28, maxHp: 220, damage: 35, xp: 1, passiveUntilHit: true,
    knockbackThreshold: 28, knockbackDist: 30,
  },
};

// Aggro tuning
const MOB_BASE_AGGRO = 300;      // normal “notice” distance
const MOB_HIT_AGGRO = 700;       // how far mobs will chase a player that hit them (wand-friendly)
const MOB_HIT_AGGRO_MS = 6500;   // how long (ms) a mob stays “provoked” since last hit

// When a mob is damaged, force it into a "provoked" aggro state for a while.
// This lets ranged (wand) hits pull mobs even from outside normal aggro range.
function setMobAggro(mob, attackerId) {
  const now = Date.now();
  mob.aggroTargetId = attackerId;
  mob.aggroUntil = now + (mob.aggroDurationMs ?? MOB_HIT_AGGRO_MS);
}

// 64x64 sprite: use a "foot" collision circle so the head/cape can overlap tiles
// without the feet clipping into walls.
const PLAYER_FOOT_RADIUS = 14;
// Player position is sprite center; bottom of sprite is +32. Put feet a bit above bottom.
const PLAYER_FOOT_OFFSET_Y = 22;

function collides(mapId, nx, ny, radius) {
  const left = nx - radius;
  const right = nx + radius;
  const top = ny - radius;
  const bottom = ny + radius;

  return (
    isBlocked(mapId, left, top) ||
    isBlocked(mapId, right, top) ||
    isBlocked(mapId, left, bottom) ||
    isBlocked(mapId, right, bottom)
  );
}


// Player-specific collision using a foot-circle (ny is player center Y)
function collidesPlayer(mapId, nx, ny) {
  return collides(mapId, nx, ny + PLAYER_FOOT_OFFSET_Y, PLAYER_FOOT_RADIUS);
}

function clampToWorldPlayer(mapId, p) {
  const m = maps[mapId];
  if (!m) return;

  const minX = PLAYER_FOOT_RADIUS;
  const maxX = m.w * TILE - PLAYER_FOOT_RADIUS;

  const minFootY = PLAYER_FOOT_RADIUS;
  const maxFootY = m.h * TILE - PLAYER_FOOT_RADIUS;

  // Clamp using the foot position, then derive center Y
  p.x = Math.max(minX, Math.min(maxX, p.x));
  const footY = Math.max(minFootY, Math.min(maxFootY, p.y + PLAYER_FOOT_OFFSET_Y));
  p.y = footY - PLAYER_FOOT_OFFSET_Y;
}

function playerFootTile(p) {
  const fx = p.x;
  const fy = p.y + PLAYER_FOOT_OFFSET_Y;
  return { tx: Math.floor(fx / TILE), ty: Math.floor(fy / TILE), fx, fy };
}


function clampToWorld(mapId, p, radius) {
  const m = maps[mapId];
  p.x = Math.max(radius, Math.min(m.w * TILE - radius, p.x));
  p.y = Math.max(radius, Math.min(m.h * TILE - radius, p.y));
}

function findSpawn(mapId, radius) {
  const m = maps[mapId];
  for (let i = 0; i < 600; i++) {
    const x = (TILE * 2) + Math.random() * (m.w * TILE - TILE * 4);
    const y = (TILE * 2) + Math.random() * (m.h * TILE - TILE * 4);
    if (!collides(mapId, x, y, radius)) return { x, y };
  }
  return { x: TILE * 2, y: TILE * 2 };
}

function findPortalSpawn(mapId, fromMapId) {
  const m = maps[mapId];
  if (!m) return findSpawn(mapId, PLAYER_FOOT_RADIUS);

  const portals = m.portals || [];
  const back = portals.find(p => p.to === fromMapId) || portals[0];
  if (!back) return findSpawn(mapId, PLAYER_FOOT_RADIUS);

  // Old behavior spawned adjacent to avoid instant back-and-forth.
  // New behavior: spawn directly ON the destination portal tile for a more natural feel.
  // We prevent loops with a small server-side portal cooldown (see msg.type === "portal").
  return centerOfTile(back.x, back.y);
}

function centerOfTile(tx, ty) {
  return { x: (tx * TILE) + TILE / 2, y: (ty * TILE) + TILE / 2 };
}

function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function newId() { return crypto.randomBytes(6).toString("hex"); }

/* ======================
   LEVEL / XP HELPERS
====================== */
function xpToNext(level) {
  return Math.floor(20 * Math.pow(level, 1.35));
}

function broadcastToMap(mapId, obj) {
  // Sends a small patch message to every connected client currently on mapId.
  for (const client of wss.clients) {
    const pid = socketToId.get(client);
    if (!pid) continue;
    const p = players.get(pid);
    if (!p) continue;
    if (p.mapId !== mapId) continue;
    send(client, obj);
  }
}


const idToSocket = new Map();
function awardXp(player, amount) {
  if (!player) return;

  player.xp += amount;

  let leveled = false;
  while (player.xp >= player.xpNext) {
    player.xp -= player.xpNext;
    player.level += 1;
    player.xpNext = xpToNext(player.level);

    player.maxHp += 10;
    player.atk += 2;
    player.hp = player.maxHp;

    leveled = true;
  }

  if (leveled) {
    const ws = idToSocket.get(player.id);
    if (ws) {
      send(ws, {
        type: "levelup",
        level: player.level,
        maxHp: player.maxHp,
        atk: player.atk,
        xp: player.xp,
        xpNext: player.xpNext
      });
    }
  }
}


function recordMonsterBookKill(killer, mobType) {
  if (!killer || !mobType) return;
  if (!killer.monsterBook || typeof killer.monsterBook !== "object") killer.monsterBook = {};
  const prev = killer.monsterBook[mobType];
  const wasNew = !prev;
  const entry = prev && typeof prev === "object" ? prev : { kills: 0 };
  entry.kills = (entry.kills ?? 0) + 1;
  killer.monsterBook[mobType] = entry;

  const ws = idToSocket.get(killer.id);
  if (ws) {
    send(ws, { type: "monsterBookUpdate", mobType, entry, isNew: wasNew });
    // Also send the full book so the client can rebuild a sorted list easily.
    send(ws, { type: "monsterBook", book: killer.monsterBook });
  }
}

function killMobAndReward(m, killerId) {
  if (!m || m.respawnIn > 0) return;

  const killer = killerId ? players.get(killerId) : null;

  if (killer) {
    handleQuestProgress(killer, m);
    awardXp(killer, m.xp ?? MOB_DEFS[m.mobType]?.xp ?? 12);
    recordMonsterBookKill(killer, m.mobType);
  }

  // When a mob dies, scatter its drops slightly so they don't all overlap.
  // We still respect collision: drops will never be placed directly on a
  // blocked tile (wall/solid object). If no nearby free spot is found,
  // we fall back to the mob's exact position.
  const baseX = m.x;
  const baseY = m.y;
  const mapId = m.mapId;
  let dropIndex = 0;

  const coins = 2 + Math.floor(Math.random() * 4);
  if (coins > 0) {
    const pos = findDropScatterPos(mapId, baseX, baseY, dropIndex++);
    spawnCoins(mapId, pos.x, pos.y, coins);
  }

  dropIndex = rollMobDrops(m, dropIndex, baseX, baseY);

  m.deadAtMs = Date.now();
  m.corpseUntilMs = m.deadAtMs + 2000;
  m.respawnIn = 5;
}


/* ======================
   LOOT (COINS)
====================== */
const drops = new Map(); // dropId -> {id,mapId,x,y,itemId,qty,amount?,expiresAtMs}
const DROP_LIFETIME_MS = 15000;
const PICKUP_RADIUS = 22;
// Vertical tweak so pickup distance matches where drops appear on-screen.
// Drops are drawn slightly above their world center, so bias the pickup point
// upward a bit to match the visual.
const DROP_PICKUP_Y_OFFSET = 16;

function spawnCoins(mapId, x, y, amount) {
  const id = "d_" + newId();
  drops.set(id, {
    id,
    mapId,
    x, y,
    itemId: "coin",
    qty: amount,
    amount,
    expiresAtMs: Date.now() + DROP_LIFETIME_MS
  });
  return id;
}


function spawnItemDrop(mapId, x, y, itemId, qty = 1, extra = null) {
  const id = "d_" + newId();

  const drop = {
    id,
    mapId,
    x, y,
    itemId,
    qty,
    expiresAtMs: Date.now() + DROP_LIFETIME_MS
  };

  // Preserve rolled stats (e.g. weaponBonus) when explicitly provided.
  if (extra && typeof extra === "object") {
    if (Number.isFinite(extra.weaponBonus)) {
      drop.weaponBonus = extra.weaponBonus;
    }
    // Future stat fields could be copied here as needed.
  }

  drops.set(id, drop);
  return id;
}


// ======================
// Choose a nearby position for a mob drop so that multiple drops from
// one kill are visually spread out, without placing any drop directly on a
// blocked tile. The index parameter is used to rotate through a small set
// of radial offsets so each additional drop fans out around the corpse.
function findDropScatterPos(mapId, baseX, baseY, index = 0) {
  const OFFSETS = [
    { x: 0,  y: 0 },   // center
    { x: 28, y: 0 },   // right
    { x: -28, y: 0 },  // left
    { x: 0,  y: 28 },  // down
    { x: 0,  y: -28 }, // up
    { x: 20, y: 20 },  // down-right
    { x: -20, y: 20 }, // down-left
    { x: 20, y: -20 }, // up-right
    { x: -20, y: -20 } // up-left
  ];

  const n = OFFSETS.length || 1;
  index = Math.max(0, index | 0);

  // Try offsets in a rotated order so each drop from the same mob
  // tends to pick a different slot.
  for (let i = 0; i < n; i++) {
    const off = OFFSETS[(index + i) % n];
    const x = baseX + off.x;
    const y = baseY + off.y;
    if (!isBlocked(mapId, x, y)) return { x, y };
  }

  // Fallback: if every candidate is blocked, just return the corpse center.
  return { x: baseX, y: baseY };
}

// MOB DROPS (future-proof)
// - Add drops per mobType here.
// - Each entry is rolled independently.
// - qty can be a number OR { min, max }.
// ======================
const MOB_DROP_TABLE = {
  // Orange slimes drop orange flan 25% of the time.
  orange: [
	{ itemId: "orange_jelly", chance: 0.30, qty: 1 },
	{ itemId: "training_sword",  chance: 0.03, qty: 1 },
    { itemId: "training_spear",  chance: 0.03, qty: 1 },
    { itemId: "training_wand",   chance: 0.03, qty: 1 },
  ],
  pink: [
	{ itemId: "pink_jelly", chance: 0.30, qty: 1 },
	{ itemId: "charger_helmet", chance: 0.05, qty: 1 },
	{ itemId: "charger_suit", chance: 0.05, qty: 1 },
  ],
   purple: [
	{ itemId: "purple_jelly", chance: 0.30, qty: 1 },
	{ itemId: "cloth_hat", chance: 0.05, qty: 1 },
	{ itemId: "cloth_armor", chance: 0.05, qty: 1 },
	{ itemId: "potion_purple", chance: 0.10, qty: 1 },
  ],
  rainbow: [
	{ itemId: "rainbow_jelly", chance: 0.30, qty: 1 },
	{ itemId: "bone_wand", chance: 0.10, qty: 1 },

  ],


  // Green slimes drop green potions 10% of the time.
  green: [
    { itemId: "green_jelly", chance: 0.30, qty: 1 },
    { itemId: "potion_green",    chance: 0.1, qty: 1 },
    { itemId: "training_sword",  chance: 0.03, qty: 1 },
    { itemId: "training_spear",  chance: 0.03, qty: 1 },
    { itemId: "training_wand",   chance: 0.03, qty: 1 },
  ],
};

const MOB_CATALOG = (() => {
  // Catalog for UI (Monster Book). Built from server-authoritative data.
  const out = {};
  const coinDrop = { itemId: "coin", chance: 1, qty: { min: 2, max: 5 } };

  const titleCase = (s) =>
    s.split(/[_\s]+/g).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  for (const [mobType, def] of Object.entries(MOB_DEFS)) {
    const table = MOB_DROP_TABLE[mobType] || [];
    out[mobType] = {
      id: mobType,
      name: (["green","pink","orange","purple","rainbow"].includes(mobType) ? `${titleCase(mobType)} Slime` : titleCase(mobType)),
      maxHp: def?.maxHp ?? 0,
      damage: def?.damage ?? 0,
      drops: [coinDrop, ...table.map(d => ({
        itemId: d.itemId,
        chance: Math.max(0, Math.min(1, Number(d.chance ?? 0))),
        qty: d.qty ?? 1
      }))],
    };
  }
  return out;
})();

function resolveDropQty(qtySpec) {
  if (typeof qtySpec === "number") return qtySpec;
  if (!qtySpec || typeof qtySpec !== "object") return 1;

  const min = Math.max(1, Math.floor(qtySpec.min ?? 1));
  const max = Math.max(min, Math.floor(qtySpec.max ?? min));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function rollMobDrops(m, dropIndex = 0, baseX = null, baseY = null) {
  if (!m) return dropIndex;

  const dropsForType = MOB_DROP_TABLE[m.mobType];
  if (!dropsForType || dropsForType.length === 0) return dropIndex;

  const mapId = m.mapId;
  const cx = Number.isFinite(baseX) ? baseX : m.x;
  const cy = Number.isFinite(baseY) ? baseY : m.y;

  for (const d of dropsForType) {
    if (!d?.itemId) continue;

    const chance = Math.max(0, Math.min(1, Number(d.chance ?? 0)));
    if (chance <= 0) continue;
    if (Math.random() >= chance) continue;

    const qty = resolveDropQty(d.qty ?? 1);
    if (qty <= 0) continue;

    // Safety: only drop items that exist in ITEMS table
    if (!ITEMS[d.itemId]) continue;

    const pos = findDropScatterPos(mapId, cx, cy, dropIndex++);
    spawnItemDrop(mapId, pos.x, pos.y, d.itemId, qty);
  }

  return dropIndex;
}



function maybePickupDropsForPlayer(p) {
  const nowMs = Date.now();
  for (const [did, d] of drops) {
    if (d.expiresAtMs <= nowMs) { drops.delete(did); continue; }
    if (d.mapId !== p.mapId) continue;
    // Use a slightly raised pickup point so the collision matches where
    // the drop is actually drawn on the map (instead of feeling "below").
    const pickupY = d.y - DROP_PICKUP_Y_OFFSET;
    if (dist(p.x, p.y, d.x, pickupY) <= PICKUP_RADIUS) {
      const ws = idToSocket.get(p.id);
      if ((d.itemId || "coin") === "coin") {
        const amt = d.amount ?? d.qty ?? 1;
        p.gold += amt;
        addItemToInventory(p, "coin", amt);
        drops.delete(did);
        if (ws) send(ws, { type: "loot", kind: "gold", amount: amt, totalGold: p.gold });
      } else {
        const qty = d.qty ?? 1;

        // If this is a weapon drop that already has a rolled bonus, preserve it.
        const def = ITEMS[d.itemId];
        let weaponBonusOverride = null;
        if (def && def.slot === "weapon" && Number.isFinite(d.weaponBonus)) {
          weaponBonusOverride = d.weaponBonus;
        }

        const added = addItemToInventory(p, d.itemId, qty, weaponBonusOverride);
        if (added) {
          drops.delete(did);
          if (ws) send(ws, { type: "loot", kind: "item", itemId: d.itemId, qty });
        } else {
          // Inventory full: leave the drop on the ground so the player can make space.
        }
      }
    }
  }
}

/* ======================
   WEAPONS
====================== */
const WEAPONS = ["sword", "spear", "wand"];

/* ======================
   ITEMS / INVENTORY
====================== */
const ITEMS = {
  // currency
  coin: { id: "coin", name: "Coin", maxStack: 9999 },


  // loot
  orange_flan: { id: "orange_flan", name: "Orange Flan", maxStack: 99 },
  green_jelly: { id: "green_jelly", name: "Green Jelly", maxStack: 99 },
  orange_jelly: { id: "orange_jelly", name: "Green Jelly", maxStack: 99 },
  pink_jelly: { id: "pink_jelly", name: "Green Jelly", maxStack: 99 },
  purple_jelly: { id: "purple_jelly", name: "Green Jelly", maxStack: 99 },
  rainbow: { id: "rainbow_jelly", name: "Green Jelly", maxStack: 99 },

  // consumables
  potion_small: {
    id: "potion_small",
    name: "Small Potion",
    maxStack: 99,
    onUse(p) {
      p.hp = Math.min(p.maxHp, p.hp + 25);
    }
  },
  
  potion_green: {
  id: "potion_green",
  name: "Green Slime Tonic",
  maxStack: 99,
  onUse(player) {
    const HEAL = 50;
    player.hp = Math.min(player.maxHp, player.hp + HEAL);
  },
},

potion_purple: {
  id: "potion_purple",
  name: "Purple Slime Tonic",
  maxStack: 99,
  onUse(player) {
    const HEAL = 300;
    player.hp = Math.min(player.maxHp, player.hp + HEAL);
  },
},

  
  // equipment (MapleStory-style)
  training_sword: { id: "training_sword", name: "Training Sword", type: "weapon", slot: "weapon", weaponKey: "sword", maxStack: 1 , weaponSpeed: 1.4 },
  branch_sword: { id: "branch_sword", name: "Tree Branch", type: "weapon", slot: "weapon", weaponKey: "sword", maxStack: 1 , weaponSpeed: 1.4 },
  bone_sword: { id: "bone_sword", name: "Bone Club", type: "weapon", slot: "weapon", weaponKey: "sword", maxStack: 1 , weaponSpeed: 1.4 },
  training_spear: { id: "training_spear", name: "Training Spear", type: "weapon", slot: "weapon", weaponKey: "spear", maxStack: 1 , weaponSpeed: 1.2, knockbackMul: 1.5 },
  blue_umbrella_spear: { id: "blue_umbrella_spear", name: "Sky Blue Umbrella", type: "weapon", slot: "weapon", weaponKey: "spear", maxStack: 1, weaponSpeed: 2, knockbackMul: 1.5 },
  candy_cane_spear: { id: "candy_cane_spear", name: "North Pole", type: "weapon", slot: "weapon", weaponKey: "spear", maxStack: 1 , weaponSpeed: 1.2, knockbackMul: 1.5 },
  fang_spear:       { id: "fang_spear",       name: "Twin Fang",       type: "weapon", slot: "weapon", weaponKey: "spear", maxStack: 1 , weaponSpeed: 1.2, knockbackMul: 1.5 },
  trident_spear:    { id: "trident_spear",    name: "Trident",    type: "weapon", slot: "weapon", weaponKey: "spear", maxStack: 1 , weaponSpeed: 1.2, knockbackMul: 1.5 },
  training_wand:  { id: "training_wand",  name: "Training Wand",  type: "weapon", slot: "weapon", weaponKey: "wand",  maxStack: 1 , weaponSpeed: 1.2 },
  bone_wand:      { id: "bone_wand",      name: "Bone Wand", type: "weapon", slot: "weapon", weaponKey: "wand",  maxStack: 1 , weaponSpeed: 1.2 },
  cloth_armor:   { id: "cloth_armor",   name: "Apprentice Robe",   type: "armor",     slot: "armor",     maxStack: 1 },
  charger_suit: { id: "charger_suit", name: "Charger Suit", type: "armor", slot: "armor", maxStack: 1 },
  cloth_hat:     { id: "cloth_hat",     name: "Apprentice Hat",     type: "hat",       slot: "hat",       maxStack: 1 },
  charger_helmet: { id: "charger_helmet", name: "Charger Helmet", type: "hat", slot: "hat", maxStack: 1 },
  red_duke: { id: "red_duke", name: "Red Duke", type: "hat", slot: "hat", maxStack: 1 },
  lucky_charm:   { id: "lucky_charm",   name: "Lucky Charm",   type: "accessory", slot: "accessory", maxStack: 1, speedBonus: 20 }
};

// Prevent wasting healing potions when already at full HP.
function isHealingConsumable(def) {
  const id = def && def.id;
  return id === "potion_small" || id === "potion_green" || id === "potion_purple";
}

function addItemToInventory(p, itemId, amount, weaponBonusOverride = null) {
  const def = ITEMS[itemId];
  if (!def || amount <= 0) return false;

  // First try to stack into existing stacks (for stackable items like coins, potions, etc.)
  for (const slot of p.inventory.slots) {
    if (slot && slot.id === itemId && slot.qty < def.maxStack) {
      const space = def.maxStack - slot.qty;
      const add = Math.min(space, amount);
      slot.qty += add;
      amount -= add;
      if (amount <= 0) return true;
    }
  }

  // Then fill empty slots with new stacks.
  // Weapons get their random roll the moment they enter the inventory,
  // so the client can show their stats on hover. If a specific roll is provided
  // (e.g. from a dropped weapon with an existing bonus), preserve that instead.
  for (let i = 0; i < p.inventory.slots.length && amount > 0; i++) {
    if (!p.inventory.slots[i]) {
      const add = Math.min(def.maxStack, amount);

      if (def.slot === "weapon") {
        let bonus;
        if (Number.isFinite(weaponBonusOverride)) {
          bonus = weaponBonusOverride;
        } else {
          bonus = rollWeaponBonus(itemId);
        }

        p.inventory.slots[i] = {
          id: itemId,
          qty: add,
          weaponBonus: bonus,
        };
      } else {
        p.inventory.slots[i] = { id: itemId, qty: add };
      }

      amount -= add;
    }
  }

  return amount === 0;
}



// === Gear randomization helpers (local-only for now) ===
function randIntInclusive(min, max) {
  const lo = Math.floor(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  const span = hi - lo;
  return lo + Math.floor(Math.random() * (span + 1));
}

// Back-compat helper: some combat code uses randInt(min, max) for inclusive rolls.
// Keep it as an alias so older snippets don't crash.
function randInt(min, max) {
  return randIntInclusive(min, max);
}

// For now we only randomize weapon attack bonus.
// Ranges are small so balance stays close to your current numbers.
function rollWeaponBonus(itemId) {
  switch (itemId) {
    case "training_sword":
    case "training_spear":
    case "blue_umbrella_spear":
    case "training_wand":
      return randIntInclusive(0, 2);    // 0–2 bonus
    
    case "bone_sword":
      return randIntInclusive(1, 3);    // stronger than training sword
    case "trident_spear":
      return randIntInclusive(1, 4);    // stronger than training spear
case "bone_wand":
      return randIntInclusive(1, 3);    // slightly stronger than training wand
    case "fang_spear":
      return randIntInclusive(1, 4);    // slightly better roll
    case "candy_cane_spear":
      return randIntInclusive(1, 3);
    default:
      return 0; // hats/armor/etc for now
  }
}

// Compute the player's effective attack, including weapon bonus.
function getPlayerAttack(p) {
  const base = Number.isFinite(p.atk) ? p.atk : 0;
  const bonus = Number.isFinite(p.weaponBonus) ? p.weaponBonus : 0;
  const total = base + bonus;
  return total > 0 ? total : 1;
}

// ===== Speed stat helpers =====
// "Speed" is a stat with a baseline of 100. Movement speed scales linearly:
//   effectiveMoveSpeed = BASE_MOVE_SPEED * (Speed / 100)
function getPlayerSpeedStat(p) {
  const base = Number.isFinite(p?.speed) ? p.speed : 100;
  const bonus = Number.isFinite(p?.speedBonus) ? p.speedBonus : 0;
  const total = base + bonus;
  return total > 1 ? total : 1;
}

function recomputePlayerBonuses(p) {
  if (!p) return;
  let speedBonus = 0;

  const eq = p.equipment || {};
  for (const slotName of ["weapon", "armor", "hat", "accessory"]) {
    const itemId = eq[slotName];
    if (!itemId) continue;
    const def = ITEMS[itemId];
    if (!def) continue;

    if (Number.isFinite(def.speedBonus)) speedBonus += def.speedBonus;
  }

  p.speedBonus = speedBonus;
}



function nextWeapon(w) {
  const i = WEAPONS.indexOf(w);
  return WEAPONS[(i >= 0 ? i + 1 : 0) % WEAPONS.length];
}

function facingFromInputs(inputs, fallback) {
  // prefer cardinal
  if (inputs.left && !inputs.right) return { x: -1, y: 0 };
  if (inputs.right && !inputs.left) return { x: 1, y: 0 };
  if (inputs.up && !inputs.down) return { x: 0, y: -1 };
  if (inputs.down && !inputs.up) return { x: 0, y: 1 };
  return fallback || { x: 0, y: 1 };
}

function norm(v) {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

function meleeHitTest(p, m, offset, radius) {
  const f = norm(p.facing || { x: 0, y: 1 });
  const cx = p.x + f.x * offset;
  const cy = p.y + f.y * offset;
  // Treat mobs as circles (not points) so a hit registers when the hit circle overlaps the mob circle.
  const mr = (m && Number.isFinite(m.radius)) ? m.radius : MOB_RADIUS;
  return dist(cx, cy, m.x, m.y) <= (radius + mr);
}


function meleeHitTestDir(p, m, dir, offset, radius) {
  const f = norm(dir || { x: 0, y: 1 });
  const cx = p.x + f.x * offset;
  const cy = p.y + f.y * offset;
  const mr = (m && Number.isFinite(m.radius)) ? m.radius : MOB_RADIUS;
  return dist(cx, cy, m.x, m.y) <= (radius + mr);
}

// Sword is a wide "slash" rather than a straight poke.
// We approximate an arc by testing a few overlapping circles:
// one forward, plus two slightly to the sides.
function swordHitTest(p, m) {
  const f = norm(p.facing || { x: 0, y: 1 });
  const perp = { x: -f.y, y: f.x };

  // Treat mobs as circles (not points) so overlap matches what the client hitbox debug shows.
  const mr = (m && Number.isFinite(m.radius)) ? m.radius : MOB_RADIUS;

  const tests = [
    { forward: 32, side: 0,  rad: 38 },
    { forward: 28, side: 14, rad: 34 },
    { forward: 28, side: -14, rad: 34 },
  ];

  for (const t of tests) {
    const cx = p.x + f.x * t.forward + perp.x * t.side;
    const cy = p.y + f.y * t.forward + perp.y * t.side;
    if (dist(cx, cy, m.x, m.y) <= (t.rad + mr)) return true;
  }
  return false;
}

// Spear is a straight thrust.
// Use the same hitbox values the client debug overlay expects:
//   DBG_SPEAR_OFFSET = 50
//   DBG_SPEAR_R      = 32
function spearHitTest(p, m) {
  const OFFSET = 50;
  const RADIUS = 32;
  return meleeHitTest(p, m, OFFSET, RADIUS);
}

function swordHitTestSkill4(p, m) {
  // Wide sword slash for Skill 4: same pattern as swordHitTest but with extra reach.
  const f = norm(p.facing || { x: 0, y: 1 });
  const perp = { x: -f.y, y: f.x };

  const mr = (m && Number.isFinite(m.radius)) ? m.radius : MOB_RADIUS;
  const RANGE_MUL = (typeof SKILL4_RANGE_MULT === "number" ? SKILL4_RANGE_MULT : 1.35);

  const tests = [
    { forward: 32, side: 0,  rad: 38 },
    { forward: 28, side: 14, rad: 34 },
    { forward: 28, side: -14, rad: 34 },
  ];

  for (const t of tests) {
    const fwd = t.forward * RANGE_MUL;
    const side = t.side * RANGE_MUL * 0.9;
    const rad = t.rad * RANGE_MUL;
    const cx = p.x + f.x * fwd + perp.x * side;
    const cy = p.y + f.y * fwd + perp.y * side;
    if (dist(cx, cy, m.x, m.y) <= (rad + mr)) return true;
  }
  return false;
}

/* ======================
   PROJECTILES
====================== */
const projectiles = new Map(); // id -> {id,mapId,ownerId,x,y,vx,vy,rad,damage,expiresAtMs}

function spawnProjectile({ mapId, ownerId, x, y, vx, vy, rad = 10, damage = 8, lifeMs = 850, sprite = null, skill1 = false, knockbackMul = 1 }) {
  const id = "pr_" + newId();
  projectiles.set(id, {
    id, mapId, ownerId,
    x, y, vx, vy,
    rad,
    damage,
    sprite: sprite || null,   // client uses this to pick an image
    skill1: !!skill1,         // if true: on mob-hit, trigger Skill 1 whirlpool
    knockbackMul: (Number.isFinite(knockbackMul) && knockbackMul > 0) ? knockbackMul : 1,
    expiresAtMs: Date.now() + lifeMs
  });
  return id;
}

/* ======================
   STATE
====================== */
const players = new Map();    // id -> player
const socketToId = new Map(); // ws -> id

/* ======================
   NPCS
====================== */
const npcs = new Map();

// Static NPCs: no wandering, just stand in place with a single image.
// sprite is a client-facing asset path under /assets (e.g. "npcs/npc_girl.png").
function spawnNpc({ id, name, mapId, tx, ty, x, y, sprite }) {
  let pos;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    pos = { x, y };
  } else if (Number.isFinite(tx) && Number.isFinite(ty)) {
    // Center of tile placement (recommended)
    pos = { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
  } else {
    pos = findSpawn(mapId, NPC_RADIUS);
  }

  npcs.set(id, {
    id, name, mapId,
    x: pos.x, y: pos.y,
    sprite: sprite || null,
  });
}


// Starter quest: Jangoon -> kill 10 green slimes -> reward Red Duke
function getJangoonQuest(p) {
  if (!p.quests) p.quests = {};
  if (!p.quests.jangoon_red_duke) {
    p.quests.jangoon_red_duke = { started: false, kills: 0, completed: false, rewarded: false };
  }
  return p.quests.jangoon_red_duke;
}

function handleQuestProgress(p, mob) {
  if (!p || !mob) return;
  const q = getJangoonQuest(p);
  if (!q.started || q.rewarded) return;

  // Only count green slime kills
  if (mob.mobType !== "green") return;

  const NEED = 10;
  q.kills = Math.min(NEED, (q.kills || 0) + 1);
  if (q.kills >= NEED) q.completed = true;
}

const npcDialogue = {
  npc_crystal: [
    "The crystal hums softly…",
    "Press E near portals to travel.",
  ],
  npc_girl: [
    "Hi! Welcome 🙂",
    "Left-click to attack • I for inventory",
  ],
  npc_jangoon: [
    "…",
    "I have work for you, if you’re willing.",
  ],
};

function randomDir() {
  const dirs = [
    [ 1, 0], [-1, 0], [0, 1], [0,-1],
    [ 1, 1], [ 1,-1], [-1, 1], [-1,-1],
    [ 0, 0]
  ];
  const [dx, dy] = dirs[Math.floor(Math.random() * dirs.length)];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/* ======================
   MOBS
====================== */


const mobs = new Map();

function spawnMob(id, mapId, opts = {}) {
  const mobType = opts.mobType || "purple"; // green | pink | orange | purple | rainbow | snail_blue | snail_red
  const radius = opts.radius ?? MOB_DEFS[mobType]?.radius ?? MOB_RADIUS;

  // Allow explicit placement (tile coords or world coords) for curated spawns.
  let s;
  if (Number.isFinite(opts.x) && Number.isFinite(opts.y)) {
    s = { x: opts.x, y: opts.y };
  } else if (Number.isFinite(opts.tx) && Number.isFinite(opts.ty)) {
    s = { x: (opts.tx + 0.5) * TILE, y: (opts.ty + 0.5) * TILE };
  } else {
    s = findSpawn(mapId, radius);
  }

  mobs.set(id, {
    id,
    mapId,
    x: s.x, y: s.y,
    spawnTx: Number.isFinite(opts.tx) ? opts.tx : null,
    spawnTy: Number.isFinite(opts.ty) ? opts.ty : null,
    spawnX: Number.isFinite(opts.x) ? opts.x : null,
    spawnY: Number.isFinite(opts.y) ? opts.y : null,
    hp: opts.hp ?? (MOB_DEFS[mobType]?.maxHp ?? 30),
    maxHp: opts.maxHp ?? (opts.hp ?? (MOB_DEFS[mobType]?.maxHp ?? 30)),
    damage: opts.damage ?? (MOB_DEFS[mobType]?.damage ?? 10),
	xp: opts.xp ?? (MOB_DEFS[mobType]?.xp ?? 12),

    // Stats
    speed: Number.isFinite(opts.speed) ? opts.speed : 100,


    dirX: 0, dirY: 0,
    changeDirIn: 0,

    atkCd: 0,
    respawnIn: 0,
    lastHitBy: null,

    // collision
    radius,

    // type + behavior
    mobType,
    passiveUntilHit: (typeof opts.passiveUntilHit === "boolean") ? opts.passiveUntilHit : !!(MOB_DEFS[mobType]?.passiveUntilHit),
    aggroTargetId: null,
    aggroUntil: 0,

    // Knockback tuning (per-mob, with overrides via MOB_DEFS / spawn opts)
    knockbackThreshold: opts.knockbackThreshold ?? (MOB_DEFS[mobType]?.knockbackThreshold ?? BIG_KNOCKBACK_THRESHOLD),
    knockbackDist: opts.knockbackDist ?? (MOB_DEFS[mobType]?.knockbackDist ?? BIG_KNOCKBACK_DIST),

    // Aggro tuning (can be overridden per mob type/spawn)
    baseAggroRange: opts.baseAggroRange ?? MOB_BASE_AGGRO,
    hitAggroRange:  opts.hitAggroRange  ?? MOB_HIT_AGGRO,
    aggroDurationMs: opts.aggroDurationMs ?? MOB_HIT_AGGRO_MS,

  // Movement tuning
  speedMul: opts.speedMul ?? 0.65,           // base (wanders + chase)
  aggroSpeedMul: opts.aggroSpeedMul ?? 1.0,  // extra multiplier while provoked

  // Anti-stuck helpers (server-only)
  stuckForMs: 0,
  nudgeUntilMs: 0,
  nudgeSign: (Math.random() < 0.5 ? -1 : 1),
});
  return mobs.get(id);
}

// Mobs per zone (difficulty ramp):
//   Map C (starting map): green slimes (passive until hit)
//   Map A (next): pink (top), orange (bottom)
//   Map B (third): purple + rainbow
//
// NOTE: All spawns are curated tile positions for now; tweak freely.


function initStaticEntitiesFromTemplates() {
  // NPCs and curated mob spawns now live in maps_data.js templates.
  // This makes the in-game editor export -> copy/paste workflow work for everything.
  for (const [mapId, tmpl] of Object.entries(mapTemplates)) {
    const npcList = tmpl.npcs || [];
    for (const npc of npcList) {
      spawnNpc({ ...npc, mapId: npc.mapId || mapId });
    }

    const mobList = tmpl.mobSpawns || [];
    for (let i = 0; i < mobList.length; i++) {
      const s = mobList[i];
      const id = s.id || `${mapId}_${s.mobType}_${i + 1}`;
      spawnMob(id, s.mapId || mapId, {
        mobType: s.mobType,
        tx: s.tx,
        ty: s.ty,
        x: s.x,
        y: s.y,
        // optional tuning knobs
        speedMul: s.speedMul,
        aggroSpeedMul: s.aggroSpeedMul,
        passiveUntilHit: s.passiveUntilHit,
      });

      const m = mobs.get(id);
      if (m) {
        // Remember spawn point so respawn returns the mob to its curated spot.
        if (Number.isFinite(s.tx) && Number.isFinite(s.ty)) {
          m.spawnTx = s.tx; m.spawnTy = s.ty;
        } else if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
          m.spawnX = s.x; m.spawnY = s.y;
        }
      }
    }
  }
}

initStaticEntitiesFromTemplates();

// Basic attack input lock (server-authoritative)
// - Freezes movement briefly when a basic attack is accepted
// - Locks facing direction to the attack direction for the same window
// NOTE: This should generally match the basic attack animation window (p.atkAnim)
// so movement + facing remain locked for the full swing.
const BASE_BASIC_SWING_SEC = 0.60;
const FLAT_ATTACK_LOCKOUT_SEC = 0.20;// minimum extra delay after a swing finishes before another attack can be accepted
// Shared basic-attack handler so we can trigger attacks both from explicit client clicks
// and from server-side "hold-to-attack" repeat.
// Knockback multiplier from the equipped weapon (lets some weapons shove harder).
// Defaults: spears = 1.5x, everything else = 1.0x.
function getPlayerWeaponKnockbackMul(p) {
  const wid = p?.equipment?.weapon;
  const def = wid ? ITEMS[wid] : null;
  const raw = Number(def?.knockbackMul);
  if (Number.isFinite(raw) && raw > 0) return raw;

  const k = def?.weaponKey || null;
  if (k === "spear") return 1.5;
  return 1.0;
}

function attemptBasicAttack(ws, p, msg, nowMs = Date.now()) {
  if (!p) return false;
  if (p.hp <= 0 || p.respawnIn > 0) return false;

  // Respect server-authoritative lock window
  if (nowMs < (p.basicAtkLockUntilMs || 0)) return false;
  if (p.atkCd > 0) return false;

  // Require an equipped weapon to attack
  const equippedWeaponId = p.equipment?.weapon;
  const equippedDef = equippedWeaponId ? ITEMS[equippedWeaponId] : null;
  const weaponKey = equippedDef?.weaponKey || null;
  if (!weaponKey) return false;

  const baseAtk = getPlayerAttack(p);

  // Skill 1 can only be fired through a wand projectile. If the player attacks with anything else,
  // drop any primed state so they must press 1 again.
  if (weaponKey !== "wand" && p.skill1Primed) p.skill1Primed = false;

  // shared animation time (client uses this for sword/spear/wand “active”)
  // (seconds)
  const weaponSpeed = Math.max(0.05, Number(equippedDef?.weaponSpeed) || 1);
  const swingSec = Math.max(0.05, (Number(BASE_BASIC_SWING_SEC) || 0.5) / weaponSpeed);
  p.atkAnim = swingSec;
  // Default attack kind is a normal/basic swing (no special visuals)
  p.atkKind = null;

  // weapon cooldowns (anti-spam)
  // NOTE: This is the *authoritative* lockout.
  // swingSec already computed above from BASE_BASIC_SWING_SEC / weaponSpeed
  // Cooldown is tied to the weapon swing animation so the player can re-attack
  // as soon as the animation finishes (and after any lock window).
  p.atkCd = swingSec + FLAT_ATTACK_LOCKOUT_SEC;

  // Freeze + facing lock window
  p.basicAtkLockUntilMs = nowMs + Math.round(swingSec * 1000);

  // Optional aim from client.
  // We prefer aimDirX/aimDirY when provided because they are derived from the player's
  // on-screen position and are not affected by camera smoothing lag.
  const aimDirX = Number(msg?.aimDirX);
  const aimDirY = Number(msg?.aimDirY);
  const hasAimDir = Number.isFinite(aimDirX) && Number.isFinite(aimDirY) && (Math.abs(aimDirX) + Math.abs(aimDirY) > 1e-6);

  const aimX = Number(msg?.aimX);
  const aimY = Number(msg?.aimY);
  const hasAim = Number.isFinite(aimX) && Number.isFinite(aimY);

  if (hasAimDir) {
    const dx = aimDirX;
    const dy = aimDirY;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);

    if (weaponKey === "wand") {
      const f = norm({ x: dx, y: dy });
      p.facing = f;
    } else {
      if (ax > ay) p.facing = { x: dx >= 0 ? 1 : -1, y: 0 };
      else if (ay > 0) p.facing = { x: 0, y: dy >= 0 ? 1 : -1 };
    }
  } else if (hasAim) {
    const dx = aimX - p.x;
    const dy = aimY - p.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);

    if (weaponKey === "wand") {
      const f = norm({ x: dx, y: dy });
      if (Math.abs(f.x) + Math.abs(f.y) > 0) p.facing = f;
    } else {
      if (ax > ay) p.facing = { x: dx >= 0 ? 1 : -1, y: 0 };
      else if (ay > 0) p.facing = { x: 0, y: dy >= 0 ? 1 : -1 };
    }
  }

  // Cache a discrete attack direction for clients (used for rendering during atkAnim and lock window).
  // This prevents the weapon sprite from snapping to the movement direction mid-swing.
  {
    const fx = p.facing?.x ?? 0;
    const fy = p.facing?.y ?? 0;
    const ax = Math.abs(fx);
    const ay = Math.abs(fy);
    if (ax > ay) p.atkDir = (fx >= 0 ? "right" : "left");
    else if (ay > 0) p.atkDir = (fy >= 0 ? "down" : "up");
    // else keep previous
  }

  // === BEGIN original basic-attack resolution ===
  // SWORD: wide slash hitbox
  if (weaponKey === "sword") {
    // Basic attacks normally hit 1 target; mastery can raise p.basicHitCap to 2/3/4...
    const hitCap = Math.max(1, p.basicHitCap ?? 1);

    const candidates = [];
    for (const m of mobs.values()) {
      if (m.mapId !== p.mapId) continue;
      if (m.respawnIn > 0) continue;
      if (m.hp <= 0) continue;

      if (swordHitTest(p, m)) {
        candidates.push(m);
      }
    }

    // closest first, then hit up to cap
    candidates.sort((a, b) => dist(p.x, p.y, a.x, a.y) - dist(p.x, p.y, b.x, b.y));

    let hits = 0;
    for (const m of candidates) {
      if (hits >= hitCap) break;
      // Use inclusive roll helper (and avoid relying on randInt being present in older builds)
      const dmg = randIntInclusive(baseAtk - 2, baseAtk + 2);
      m.hp -= dmg;
      m.lastHitBy = p.id;

      // Big knockback if this single hit is strong enough.
      maybeBigKnockback(m, p.x, p.y, dmg, getPlayerWeaponKnockbackMul(p));
// Basic attacks should provoke aggro.
      setMobAggro(m, p.id);

      broadcastToMap(p.mapId, {
        type: "hit",
        targetId: m.id,
        targetKind: "mob",
        srcX: p.x,
        srcY: p.y,
        amount: dmg,
        fx: "slash",
      });

      if (m.hp <= 0) {
        killMobAndReward(m, p.id);
      }
      hits++;
    }

    return true;
  }

  // SPEAR: thrust hitbox
  if (weaponKey === "spear") {
    // Basic attacks normally hit 1 target; mastery can raise p.basicHitCap to 2/3/4...
    const hitCap = Math.max(1, p.basicHitCap ?? 1);

    const candidates = [];
    for (const m of mobs.values()) {
      if (m.mapId !== p.mapId) continue;
      if (m.respawnIn > 0) continue;
      if (m.hp <= 0) continue;

      if (spearHitTest(p, m)) {
        candidates.push(m);
      }
    }

    candidates.sort((a, b) => dist(p.x, p.y, a.x, a.y) - dist(p.x, p.y, b.x, b.y));

    let hits = 0;
    for (const m of candidates) {
      if (hits >= hitCap) break;
      // Use inclusive roll helper (and avoid relying on randInt being present in older builds)
      const dmg = randIntInclusive(baseAtk - 2, baseAtk + 2);
      m.hp -= dmg;
      m.lastHitBy = p.id;

      // Big knockback if this single hit is strong enough.
      maybeBigKnockback(m, p.x, p.y, dmg, getPlayerWeaponKnockbackMul(p));
// Basic attacks should provoke aggro.
      setMobAggro(m, p.id);

      broadcastToMap(p.mapId, {
        type: "hit",
        targetId: m.id,
        targetKind: "mob",
        srcX: p.x,
        srcY: p.y,
        amount: dmg,
        fx: "stab",
      });

      if (m.hp <= 0) {
        killMobAndReward(m, p.id);
      }
      hits++;
    }

    return true;
  }

  // WAND: projectile
  if (weaponKey === "wand") {
    // Skill 1 is a primed wand shot that creates a whirlpool on mob-hit.
    // We only allow it if the skill isn't on cooldown at the moment of firing.
    const cdUntil = p.skill1CdUntilMs || 0;
    const wantsSkill1 = !!p.skill1Primed && nowMs >= cdUntil;
    // Consume the primed state on the first wand shot after pressing 1.
    // If this projectile misses, cooldown will NOT start (only starts on hit when whirlpool begins).
    if (p.skill1Primed) p.skill1Primed = false;

    const speed = 520;
    const lifeMs = 650;
    const f = norm({ x: p.facing.x, y: p.facing.y });

    // Spawn slightly offset so the bolt originates closer to the wand/hand.
    let startX = p.x;
    let startY = p.y;
    const atkDir = p.atkDir || "down";
    if (atkDir === "right") {
      startX += -15;
      startY += 0;
    } else if (atkDir === "left") {
      startX -= 15;
      startY += 0;
    } else if (atkDir === "down") {
      startX += -15;
      startY += 12;
    } else if (atkDir === "up") {
      startX += 10;
      startY -= 18;
    }

    spawnProjectile({
      mapId: p.mapId,
      ownerId: p.id,
      x: startX,
      y: startY,
      vx: f.x * speed,
      vy: f.y * speed,
      rad: 5,
      damage: Math.max(1, Math.floor(baseAtk * 0.75)),
      lifeMs,
      sprite: wantsSkill1 ? "skill1_projectile" : "wand_projectile",
      skill1: wantsSkill1,
      knockbackMul: getPlayerWeaponKnockbackMul(p)
    });

    return true;
  }

  return true;
}


function respawnMob(m) {
  // Prefer curated spawn points (if provided in maps_data.js mobSpawns)
  let s;
  if (Number.isFinite(m.spawnX) && Number.isFinite(m.spawnY)) {
    s = { x: m.spawnX, y: m.spawnY };
  } else if (Number.isFinite(m.spawnTx) && Number.isFinite(m.spawnTy)) {
    s = { x: (m.spawnTx + 0.5) * TILE, y: (m.spawnTy + 0.5) * TILE };
  } else {
    s = findSpawn(m.mapId, m.radius ?? MOB_RADIUS);
  }
  m.x = s.x; m.y = s.y;
  m.hp = m.maxHp;
  m.respawnIn = 0;
  m.deadAtMs = 0;
  m.corpseUntilMs = 0;
  m.lastHitBy = null;
  m.dirX = 0; m.dirY = 0;
  m.changeDirIn = 0;

  m.aggroTargetId = null;
  m.aggroUntil = 0;
}

/* ======================
   CONNECTIONS
====================== */
wss.on("connection", (ws) => {
  const id = newId();
  socketToId.set(ws, id);
  idToSocket.set(id, ws);

  // Start in sanctuary
  const mapId = "C";
  const spawn = findSpawn(mapId, PLAYER_FOOT_RADIUS);

  players.set(id, {
    id,
    name: "Player",
    mapId,
    x: spawn.x,
    y: spawn.y,
    inputs: { up: false, down: false, left: false, right: false },

    // facing for directional attacks
    facing: { x: 0, y: 1 },

    // weapons
    weapon: null,

    // leveling
    level: 1,
    xp: 0,
    xpNext: xpToNext(1),
    atk: 10,
    weaponBonus: 0,
    speed: 100,
    speedBonus: 0,
    // Basic attack can hit this many mobs (mastery can raise this)
    basicHitCap: 1,
    hp: 100,
    maxHp: 100,

    // loot
    gold: 0,


    // equipment (server authoritative)
    equipment: { weapon: null, armor: null, hat: null, accessory: null },

    // hotbar (server authoritative, persisted)
    hotbar: new Array(6).fill(null),

    // inventory (server authoritative)
    inventory: { size: 24, slots: [ { id: "branch_sword", qty: 1 },{ id: "lucky_charm", qty: 1 },{ id: "bone_sword", qty: 1 },{ id: "trident_spear", qty: 1 }, ...Array(19).fill(null) ] },

// quests (server authoritative)
quests: { jangoon_red_duke: { started: false, 
    // monster book (server authoritative)
    monsterBook: {},
kills: 0, completed: false, rewarded: false } },


// skills (server authoritative timers)
skill1ActiveUntilMs: 0,
skill1CdUntilMs: 0,
skill2CdUntilMs: 0,
skill3CdUntilMs: 0,
skill4CdUntilMs: 0,

	// ===== Skill 5 (wand): Familiar =====
	// When active, a familiar follows the player. Whenever the player hits a mob with a normal wand bolt,
	// the familiar targets that mob and applies small damage once per second until the mob dies or a new
	// target is assigned (by hitting a different mob). Leaving the map cancels the skill.
	familiarActive: false,
	familiarTargetMobId: null,
	familiarNextAtkMs: 0,

	// ===== Skill 6 (wand): Healing Cloud =====
	// Summons a stationary cloud above the player that periodically heals them while active.
	skill6CloudUntilMs: 0,
	skill6NextHealMs: 0,
	skill6CloudX: 0,
	skill6CloudY: 0,

// combat timers

    atkAnim: 0,
    atkCd: 0,
    atkKind: null,
    invuln: 0,

    // basic attack movement/facing lock window (ms timestamp)
    basicAtkLockUntilMs: 0,

    // hold-to-attack state (mouse held)
    attackHeld: false,
    attackHeldAim: null,

    // portal anti-loop (ms timestamp). We now spawn ON portal tiles, so we prevent instant re-use.
    portalCdUntilMs: 0,

    // save + respawn
    save: null,     // {mapId,x,y}
    respawnIn: 0,   // seconds
  });

  const m = maps[mapId];
  send(ws, {
    type: "welcome",
    id,
    mapId,
    map: m.map,
    objMap: m.obj,
    portals: m.portals || [],
    tileSize: TILE,
    mapW: m.w,
    mapH: m.h,
    playerRadius: PLAYER_RADIUS,
    portalTile: PORTAL_TILE,
    weapons: WEAPONS,
    mobCatalog: MOB_CATALOG,
    monsterBook: (players.get(id)?.monsterBook) || {},
  });

ws.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    const pid = socketToId.get(ws);
    const p = players.get(pid);
    if (!p) return;

	   if (msg.type === "setName") {
	  const raw = (msg.name ?? "").toString().trim();
	  if (!/^[A-Za-z]{4,8}$/.test(raw)) {
		send(ws, { type: "nameRejected", reason: "Name must be letters only (4-8 chars)." });
		return;
	  }

	  p.name = raw;

	  // Try loading from database
	  const row = await dbLoadPlayerByName(p.name);
	  if (row) {
		console.log(`🔁 Loaded player from DB: ${p.name}`);
		applyRowToPlayer(p, row);
	  } else {
		console.log(`🆕 New player: ${p.name}`);
	  }

	  send(ws, { type: "nameAccepted", name: p.name });
	  // send persisted hotbar to client (so it loads across logins)
	  send(ws, { type: "hotbarState", slots: p.hotbar || new Array(6).fill(null) });
	  return;
	}

    if (msg.type === "setHotbar") {
      const inSlots = Array.isArray(msg.slots) ? msg.slots : [];
      const out = new Array(6).fill(null);

      for (let i = 0; i < 6; i++) {
        const s = inSlots[i];
        if (!s || typeof s !== "object") { out[i] = null; continue; }

        if (s.type === "skill" && typeof s.id === "string") {
          // Allow only known skills (extend this list as you add more)
          const sid = s.id;
          if (
            sid === "skill1" ||
            sid === "skill2" ||
            sid === "skill3" ||
            sid === "skill4" ||
            sid === "skill5" ||
            sid === "skill6"
          ) {
            out[i] = { type: "skill", id: sid };
          } else {
            out[i] = null;
          }
          continue;
        }

        if (s.type === "item") {
          const itemId = (typeof s.itemId === "string") ? s.itemId : ((typeof s.id === "string") ? s.id : "");
          if (!itemId || !ITEMS[itemId]) { out[i] = null; continue; }
          const preferSlot = Number.isInteger(s.preferSlot) ? s.preferSlot : undefined;
          out[i] = preferSlot === undefined ? { type: "item", itemId } : { type: "item", itemId, preferSlot };
          continue;
        }

        out[i] = null;
      }

      p.hotbar = out;
      send(ws, { type: "hotbarState", slots: p.hotbar });
      return;
    }


// DEV: spawn an item directly into your inventory (testing convenience)
// Client hotkey: F9 (see index.html)
if (msg.type === "devSpawnItem") {
  if (!ENABLE_DEV_SPAWN) return;

  const itemId = (msg.itemId ?? "").toString();
  if (!itemId || !ITEMS[itemId]) {
    send(ws, { type: "devSpawnResult", ok: false, reason: "Unknown itemId" });
    return;
  }

  let qty = parseInt(msg.qty, 10);
  if (!Number.isFinite(qty) || qty <= 0) qty = 1;
  qty = Math.min(999, qty);

  // Optional: force a specific weapon roll (for testing)
  const weaponBonus = Number.isFinite(msg.weaponBonus) ? msg.weaponBonus : null;
  const ok = addItemToInventory(p, itemId, qty, weaponBonus);
  if (!ok) {
    send(ws, { type: "devSpawnResult", ok: false, reason: "Inventory full" });
    return;
  }

  send(ws, { type: "devSpawnResult", ok: true, itemId, qty });
  return;
}


    if (msg.type === "input") {
      p.inputs.up = !!msg.up;
      p.inputs.down = !!msg.down;
      p.inputs.left = !!msg.left;
      p.inputs.right = !!msg.right;

      // update facing only when some direction is pressed
      const hasDir = p.inputs.up || p.inputs.down || p.inputs.left || p.inputs.right;
      if (hasDir) {
        // Don't let movement inputs overwrite the attack-facing while an attack animation OR
        // basic-attack lock window is active.
        const nowMs = Date.now();
        if (p.atkAnim <= 0 && nowMs >= (p.basicAtkLockUntilMs || 0)) {
          p.facing = facingFromInputs(p.inputs, p.facing);
        }
      }

      return;
    }


    // ===== Skill 5: Familiar (wand-only) =====
    // Toggles a persistent familiar that will auto-attack the mob you last hit with a normal wand bolt.
    // Leaving the map cancels the skill.
    if (msg.type === "skill5FamiliarToggle") {
      if (p.hp <= 0 || p.respawnIn > 0) return;

      const equippedWeaponId = p.equipment?.weapon;
      const equippedDef = equippedWeaponId ? ITEMS[equippedWeaponId] : null;
      const weaponKey = equippedDef?.weaponKey || null;
      if (weaponKey !== "wand") {
        send(ws, { type: "skill5Rejected", reason: "Equip a wand to use Familiar." });
        return;
      }

      p.familiarActive = !p.familiarActive;
      if (!p.familiarActive) {
        p.familiarTargetMobId = null;
        p.familiarNextAtkMs = 0;
        p._familiarLastTargetMobId = null;
      }

      send(ws, { type: "skill5State", active: !!p.familiarActive });
      return;
    }

    // ===== Skill 6: Healing Cloud (wand-only) =====
    if (msg.type === "skill6HealingCloud") {
      if (p.hp <= 0 || p.respawnIn > 0) return;

      const equippedWeaponId = p.equipment?.weapon;
      const equippedDef = equippedWeaponId ? ITEMS[equippedWeaponId] : null;
      const weaponKey = equippedDef?.weaponKey || null;
      if (weaponKey !== "wand") {
        send(ws, { type: "skill6Rejected", reason: "Equip a wand to use Healing Cloud." });
        return;
      }

      const nowMs = Date.now();

      // If already active, just ignore (client will show feedback based on timers)
      if (p.skill6CloudUntilMs && nowMs < p.skill6CloudUntilMs) {
        send(ws, { type: "skill6Rejected", reason: "Healing Cloud is already active." });
        return;
      }

      p.skill6CloudUntilMs = nowMs + SKILL6_DURATION_MS;
      p.skill6NextHealMs = nowMs + SKILL6_TICK_MS;
      p.skill6CloudX = p.x;
      p.skill6CloudY = p.y;
      return;
    }


if (msg.type === "skill1Arm") {
  if (p.hp <= 0 || p.respawnIn > 0) return;

  const nowMs = Date.now();
  // Can't arm while active or on cooldown
  if (nowMs < (p.skill1ActiveUntilMs || 0) || nowMs < (p.skill1CdUntilMs || 0)) {
    send(ws, { type: "skill1Rejected", reason: "Skill 1 is on cooldown." });
    return;
  }

  // Must be equipped with a wand
  const equippedWeaponId = p.equipment?.weapon;
  const equippedDef = equippedWeaponId ? ITEMS[equippedWeaponId] : null;
  const weaponKey = equippedDef?.weaponKey || null;
  if (weaponKey !== "wand") {
    send(ws, { type: "skill1Rejected", reason: "Equip a wand to use Skill 1." });
    return;
  }

  p.skill1Primed = true;
  send(ws, { type: "skill1Armed" });
  return;
}

if (msg.type === "skill1Cast") {
  if (p.hp <= 0 || p.respawnIn > 0) return;

  const nowMs = Date.now();
  // Can't cast while active or on cooldown
  if (nowMs < (p.skill1ActiveUntilMs || 0) || nowMs < (p.skill1CdUntilMs || 0)) {
    send(ws, { type: "skill1Rejected", reason: "Skill 1 is on cooldown." });
    return;
  }

  const x = Number(msg.x);
  const y = Number(msg.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  // Must be within targeting radius of caster
  const dx = x - p.x;
  const dy = y - p.y;
  if (Math.hypot(dx, dy) > SKILL1_RANGE_PX) {
    send(ws, { type: "skill1Rejected", reason: "Out of range." });
    return;
  }

  // Must be on passable tile (base + objects)
  if (isBlocked(p.mapId, x, y)) {
    send(ws, { type: "skill1Rejected", reason: "Target must be on passable ground." });
    return;
  }

  const id = `${p.id}:${nowMs}`;
  const startMs = nowMs;
  const endMs = nowMs + SKILL1_DURATION_MS;
  whirlpools.set(id, { id, mapId: p.mapId, x, y, rad: SKILL1_EFFECT_RADIUS_PX, casterId: p.id, startMs, endMs });

  p.skill1ActiveUntilMs = endMs;
  // Cooldown starts when the cast begins (not after the effect ends)
  p.skill1CdUntilMs = startMs + SKILL1_COOLDOWN_MS;

  // Tell caster timings for UI
  send(ws, { type: "skill1Accepted", center: { x, y }, startMs, endMs, cdUntilMs: p.skill1CdUntilMs });

  return;
}

if (msg.type === "skill2DoubleStab") {
  if (p.hp <= 0 || p.respawnIn > 0) return;

  // Must have a spear equipped
  const equippedWeaponId = p.equipment?.weapon;
  const equippedDef = equippedWeaponId ? ITEMS[equippedWeaponId] : null;
  const weaponKey = equippedDef?.weaponKey || null;
  if (weaponKey !== "spear") {
    send(ws, { type: "skill2Rejected", reason: "Equip a spear to use Skill 2." });
    return;
  }

  const nowMs = Date.now();
  if (nowMs < (p.skill2CdUntilMs || 0)) {
    send(ws, { type: "skill2Rejected", reason: "Skill 2 is on cooldown." });
    return;
  }

  const startMs = nowMs;
  p.skill2CdUntilMs = startMs + SKILL2_COOLDOWN_MS;


  // Optional aim from client (same logic as regular attack)
  // For spear skills we snap to cardinal directions so the hitbox matches your normal melee behavior.
  const aimDirX = Number(msg.aimDirX);
  const aimDirY = Number(msg.aimDirY);
  const hasAimDir =
    Number.isFinite(aimDirX) &&
    Number.isFinite(aimDirY) &&
    (Math.abs(aimDirX) + Math.abs(aimDirY) > 1e-6);

  const aimX = Number(msg.aimX);
  const aimY = Number(msg.aimY);
  const hasAim = Number.isFinite(aimX) && Number.isFinite(aimY);

  if (hasAimDir) {
    const dx = aimDirX;
    const dy = aimDirY;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax > ay) p.facing = { x: dx >= 0 ? 1 : -1, y: 0 };
    else if (ay > 0) p.facing = { x: 0, y: dy >= 0 ? 1 : -1 };
  } else if (hasAim) {
    const dx = aimX - p.x;
    const dy = aimY - p.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax > ay) p.facing = { x: dx >= 0 ? 1 : -1, y: 0 };
    else if (ay > 0) p.facing = { x: 0, y: dy >= 0 ? 1 : -1 };
  }

  // Cache a discrete attack direction for clients (used for rendering during atkAnim)
  {
    const fx = p.facing?.x ?? 0;
    const fy = p.facing?.y ?? 0;
    const ax = Math.abs(fx);
    const ay = Math.abs(fy);
    if (ax > ay) p.atkDir = (fx >= 0 ? "right" : "left");
    else if (ay > 0) p.atkDir = (fy >= 0 ? "down" : "up");
  }


  // Broadcast for visuals (map-scoped)
  broadcastToMap(p.mapId, { type: "skill2Fx", casterId: p.id, startMs });

  const baseAtk = getPlayerAttack(p);

  // Helper: apply one stab with slight "jut"
  const applyStab = (stabIndex) => {
    // Animate like a regular spear attack (client reads p.atkAnim)
    p.atkAnim = SKILL2_ATK_ANIM;

    // Slightly rotate the facing vector so it "juts" a bit left/right
    const f = norm(p.facing || { x: 0, y: 1 });
    const a = (stabIndex === 0 ? -1 : 1) * SKILL2_JUT_ANGLE;
    const dx = f.x * Math.cos(a) - f.y * Math.sin(a);
    const dy = f.x * Math.sin(a) + f.y * Math.cos(a);
    const dir = { x: dx, y: dy };

    const OFFSET = SKILL2_SPEAR_OFFSET;
    const RADIUS = SKILL2_SPEAR_RADIUS;

    for (const m of mobs.values()) {
      if (m.mapId !== p.mapId) continue;
      if (m.respawnIn > 0) continue;
      if (m.hp <= 0) continue;

      if (meleeHitTestDir(p, m, dir, OFFSET, RADIUS)) {
        const dmg = Math.max(1, Math.floor(baseAtk * 0.9));
        m.hp -= dmg;
        m.lastHitBy = p.id;

        // Big knockback if this single hit is strong enough.
        maybeBigKnockback(m, p.x, p.y, dmg, getPlayerWeaponKnockbackMul(p));
// Aggro mobs on hit (server-wide aggro system)
        setMobAggro(m, p.id);

        // Combat text / hit FX (match regular attacks: client listens for type:"hit")
        broadcastToMap(p.mapId, {
          type: "hit",
          targetId: m.id,
          targetKind: "mob",
          srcX: p.x,
          srcY: p.y,
          amount: dmg,
          fx: "stab",
        });

        if (m.hp <= 0) {
          killMobAndReward(m, p.id);
        }
      }
    }
  };

  applyStab(0);
  setTimeout(() => {
    // if player moved maps / disconnected, stop second stab
    const p2 = players.get(p.id);
    if (!p2) return;
    if (p2.mapId !== p.mapId) return;
    applyStab(1);
  }, SKILL2_GAP_MS);

  // Tell caster cooldown timing for UI (optional; snapshot also carries it)
  send(ws, { type: "skill2Accepted", cdUntilMs: p.skill2CdUntilMs });
  return;
}


// ===== Skill 3: Dash Slash (sword-only) =====
// A short dash in your aimed direction, then a strong sword slash at the end.
// Uses cardinal directions (like your other melee) and stops early if you hit a wall/object.
if (msg.type === "skill3DashSlash") {
  if (p.hp <= 0 || p.respawnIn > 0) return;

  // Must have a sword equipped
  const equippedWeaponId = p.equipment?.weapon;
  const equippedDef = equippedWeaponId ? ITEMS[equippedWeaponId] : null;
  const weaponKey = equippedDef?.weaponKey || null;
  if (weaponKey !== "sword") {
    send(ws, { type: "skill3Rejected", reason: "Equip a sword to use Skill 3." });
    return;
  }

  const nowMs = Date.now();
  if (nowMs < (p.skill3CdUntilMs || 0)) {
    send(ws, { type: "skill3Rejected", reason: "Skill 3 is on cooldown." });
    return;
  }

  const baseAtk = getPlayerAttack(p);

  const startMs = nowMs;
  p.skill3CdUntilMs = startMs + SKILL3_COOLDOWN_MS;

  // Optional aim from client; snap to cardinal direction
  const aimDirX = Number(msg.aimDirX);
  const aimDirY = Number(msg.aimDirY);
  const hasAimDir =
    Number.isFinite(aimDirX) &&
    Number.isFinite(aimDirY) &&
    (Math.abs(aimDirX) + Math.abs(aimDirY) > 1e-6);

  const aimX = Number(msg.aimX);
  const aimY = Number(msg.aimY);
  const hasAim = Number.isFinite(aimX) && Number.isFinite(aimY);

  if (hasAimDir) {
    const dx = aimDirX;
    const dy = aimDirY;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax > ay) p.facing = { x: dx >= 0 ? 1 : -1, y: 0 };
    else if (ay > 0) p.facing = { x: 0, y: dy >= 0 ? 1 : -1 };
  } else if (hasAim) {
    const dx = aimX - p.x;
    const dy = aimY - p.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax > ay) p.facing = { x: dx >= 0 ? 1 : -1, y: 0 };
    else if (ay > 0) p.facing = { x: 0, y: dy >= 0 ? 1 : -1 };
  }

  // Cache a discrete attack direction for clients (used for rendering during atkAnim)
  {
    const fx = p.facing?.x ?? 0;
    const fy = p.facing?.y ?? 0;
    const ax = Math.abs(fx);
    const ay = Math.abs(fy);
    if (ax > ay) p.atkDir = (fx >= 0 ? "right" : "left");
    else if (ay > 0) p.atkDir = (fy >= 0 ? "down" : "up");
  }

  const fromX = p.x;
  const fromY = p.y;

  // Dash contact damage: as you pass through/near mobs during the dash, apply a small hit once per mob.
  // This makes the skill feel reliable even if you end up on the far side of a target.
  const dashHitMobIds = new Set();
  const dashDmg = Math.max(1, Math.floor(baseAtk * SKILL3_DASH_DAMAGE_MULT));

  // Dash forward in small steps so we don't "phase" through walls.
  const f = norm(p.facing || { x: 0, y: 1 });
  const step = SKILL3_DASH_DIST_PX / SKILL3_DASH_STEPS;
  for (let i = 0; i < SKILL3_DASH_STEPS; i++) {
    const nx = p.x + f.x * step;
    const ny = p.y + f.y * step;
    if (collidesPlayer(p.mapId, nx, ny)) break;
    p.x = nx;
    p.y = ny;

    // Apply small contact damage during the dash (once per mob) so you don't harmlessly pass through.
    // Uses a simple overlap check (player foot radius + mob radius + padding).
    for (const m of mobs.values()) {
      if (m.mapId !== p.mapId) continue;
      if (m.respawnIn > 0) continue;
      if (m.hp <= 0) continue;
      if (dashHitMobIds.has(m.id)) continue;

      const mr = (m && Number.isFinite(m.radius)) ? m.radius : MOB_RADIUS;
      const hitRad = PLAYER_FOOT_RADIUS + mr + SKILL3_DASH_CONTACT_PAD;
      if (dist(p.x, p.y, m.x, m.y) <= hitRad) {
        dashHitMobIds.add(m.id);
        m.hp -= dashDmg;
        m.lastHitBy = p.id;

        // Big knockback if this single hit is strong enough.
        maybeBigKnockback(m, p.x, p.y, dashDmg, getPlayerWeaponKnockbackMul(p));
setMobAggro(m, p.id);

        broadcastToMap(p.mapId, {
          type: "hit",
          targetId: m.id,
          targetKind: "mob",
          srcX: p.x,
          srcY: p.y,
          amount: dashDmg,
          fx: "dash",
        });

        if (m.hp <= 0) killMobAndReward(m, p.id);
      }
    }
  }
  clampToWorldPlayer(p.mapId, p);

  // Animate + briefly lock out normal attacks
  p.atkAnim = Math.max(p.atkAnim || 0, SKILL3_ATK_ANIM);
  // Dash Slash uses the normal sword visuals
  p.atkKind = null;
  p.atkCd = Math.max(p.atkCd || 0, SKILL3_ATK_LOCK_SEC);

  // Apply a stronger sword slash at the end of the dash
  const dmg = Math.max(1, Math.floor(baseAtk * SKILL3_DAMAGE_MULT));
  for (const m of mobs.values()) {
    if (m.mapId !== p.mapId) continue;
    if (m.respawnIn > 0) continue;
    if (m.hp <= 0) continue;

    if (swordHitTest(p, m)) {
      m.hp -= dmg;
      m.lastHitBy = p.id;

      setMobAggro(m, p.id);

      broadcastToMap(p.mapId, {
        type: "hit",
        targetId: m.id,
        targetKind: "mob",
        srcX: p.x,
        srcY: p.y,
        amount: dmg,
        fx: "dashslash",
      });

      if (m.hp <= 0) killMobAndReward(m, p.id);
    }
  }

  // Broadcast dash FX for visuals (optional client-side)
  broadcastToMap(p.mapId, {
    type: "skill3Fx",
    casterId: p.id,
    startMs,
    from: { x: fromX, y: fromY },
    to: { x: p.x, y: p.y },
    dir: { x: p.facing?.x ?? 0, y: p.facing?.y ?? 1 },
  });

  send(ws, { type: "skill3Accepted", cdUntilMs: p.skill3CdUntilMs });
  return;
}

if (msg.type === "skill4WideSlash") {
  if (p.hp <= 0 || p.respawnIn > 0) return;

  // Must have a sword equipped
  const equippedWeaponId = p.equipment?.weapon;
  const equippedDef = equippedWeaponId ? ITEMS[equippedWeaponId] : null;
  const weaponKey = equippedDef?.weaponKey || null;
  if (weaponKey !== "sword") {
    send(ws, { type: "skill4Rejected", reason: "Equip a sword to use Skill 4." });
    return;
  }

  const nowMs = Date.now();
  if (nowMs < (p.skill4CdUntilMs || 0)) {
    send(ws, { type: "skill4Rejected", reason: "Skill 4 is on cooldown." });
    return;
  }

  const startMs = nowMs;
  p.skill4CdUntilMs = startMs + SKILL4_COOLDOWN_MS;

  // Aim direction, same rules as basic attack: prefer aimDirX/aimDirY, fall back to aimX/aimY.
  const aimDirX = Number(msg.aimDirX);
  const aimDirY = Number(msg.aimDirY);
  const hasAimDir =
    Number.isFinite(aimDirX) &&
    Number.isFinite(aimDirY) &&
    (Math.abs(aimDirX) + Math.abs(aimDirY) > 1e-6);

  const aimX = Number(msg.aimX);
  const aimY = Number(msg.aimY);
  const hasAim = Number.isFinite(aimX) && Number.isFinite(aimY);

  if (hasAimDir) {
    const dx = aimDirX;
    const dy = aimDirY;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax > ay) p.facing = { x: dx >= 0 ? 1 : -1, y: 0 };
    else if (ay > 0) p.facing = { x: 0, y: dy >= 0 ? 1 : -1 };
  } else if (hasAim) {
    const dx = aimX - p.x;
    const dy = aimY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 1e-6) {
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (ax > ay) p.facing = { x: dx >= 0 ? 1 : -1, y: 0 };
      else p.facing = { x: 0, y: dy >= 0 ? 1 : -1 };
    }
  }

  // Cache a discrete attack direction for clients (used for rendering during atkAnim)
  {
    const fx = p.facing?.x ?? 0;
    const fy = p.facing?.y ?? 0;
    const ax = Math.abs(fx);
    const ay = Math.abs(fy);
    if (ax > ay) p.atkDir = (fx >= 0 ? "right" : "left");
    else if (ay > 0) p.atkDir = (fy >= 0 ? "down" : "up");
  }

  // Animate sword swing with a slightly longer arc
  p.atkAnim = Math.max(p.atkAnim || 0, SKILL4_ATK_ANIM);
  p.atkKind = "skill4";

  // Apply hits: up to SKILL4_MAX_HITS mobs using the extended sword test
  let hits = 0;
  const dmg = getPlayerAttack(p);

  const candidates = [];
  for (const m of mobs.values()) {
    if (m.mapId !== p.mapId) continue;
    if (m.respawnIn > 0) continue;
    if (m.hp <= 0) continue;
    if (!swordHitTestSkill4(p, m)) continue;

    const dx = m.x - p.x;
    const dy = m.y - p.y;
    candidates.push({ m, d2: dx * dx + dy * dy });
  }

  // Prioritize the closest mobs so visuals feel natural
  candidates.sort((a, b) => a.d2 - b.d2);

  for (const { m } of candidates) {
    if (hits >= SKILL4_MAX_HITS) break;
    hits++;

    m.hp -= dmg;
    m.lastHitBy = p.id;

    maybeBigKnockback(m, p.x, p.y, dmg, getPlayerWeaponKnockbackMul(p));
setMobAggro(m, p.id);

    broadcastToMap(p.mapId, {
      type: "hit",
      targetId: m.id,
      targetKind: "mob",
      srcX: p.x,
      srcY: p.y,
      amount: dmg,
      fx: "bigslash",
    });

    if (m.hp <= 0) killMobAndReward(m, p.id);
  }

  send(ws, { type: "skill4Accepted", cdUntilMs: p.skill4CdUntilMs });
  return;
}


    if (msg.type === "invClick") {
      if (p.hp <= 0 || p.respawnIn > 0) return;
      const slotIndex = Number(msg.slot);
      if (!Number.isFinite(slotIndex) || slotIndex < 0 || slotIndex >= p.inventory.slots.length) return;
      const stack = p.inventory.slots[slotIndex];
      if (!stack) return;

      const def = ITEMS[stack.id];
      if (!def) return;

      // Equip if the item is equippable
      if (def.slot === "weapon" || def.slot === "armor" || def.slot === "hat" || def.slot === "accessory") {
        const equipSlot = def.slot;

        // Capture outgoing equipped item BEFORE mutating inventory
        const outgoingId = p.equipment[equipSlot];
        const outgoingWeaponBonus =
          (equipSlot === "weapon" && Number.isFinite(p.weaponBonus)) ? p.weaponBonus : null;

        // Determine weapon roll BEFORE mutating the stack
        let newWeaponBonus = 0;
        if (equipSlot === "weapon") {
          if (Number.isFinite(stack.weaponBonus)) {
            newWeaponBonus = stack.weaponBonus;
          } else {
            newWeaponBonus = rollWeaponBonus(def.id);
          }
        }

        // Remove one item from inventory slot
        if (stack.qty > 1) {
          stack.qty -= 1;
          if (equipSlot === "weapon" && !Number.isFinite(stack.weaponBonus)) {
            stack.weaponBonus = newWeaponBonus;
          }
        } else {
          p.inventory.slots[slotIndex] = null;
        }

        // Place outgoing equipped item into the SAME inventory slot
        if (outgoingId) {
          if (equipSlot === "weapon") {
            p.inventory.slots[slotIndex] = {
              id: outgoingId,
              qty: 1,
              weaponBonus: outgoingWeaponBonus || 0
            };
          } else {
            p.inventory.slots[slotIndex] = { id: outgoingId, qty: 1 };
          }
        }

        // Equip new item
        p.equipment[equipSlot] = def.id;

        if (equipSlot === "weapon") {
          p.weapon = def.weaponKey || "sword";
          p.weaponBonus = newWeaponBonus;
        }
        // Apply derived stat bonuses from equipment changes
        recomputePlayerBonuses(p);
        return;
      }

      // Otherwise, consume if it has onUse
      if (typeof def.onUse === "function") {
        if (isHealingConsumable(def) && p.hp >= p.maxHp) return;
        def.onUse(p);
        stack.qty -= 1;
        if (stack.qty <= 0) p.inventory.slots[slotIndex] = null;
      }
      return;
    }
    if (msg.type === "dropItem") {
      if (p.hp <= 0 || p.respawnIn > 0) return;
      const slotIndex = Number(msg.slot);
      if (!Number.isFinite(slotIndex) || slotIndex < 0 || slotIndex >= p.inventory.slots.length) return;
      const stack = p.inventory.slots[slotIndex];
      if (!stack) return;

      const def = ITEMS[stack.id];
      if (!def) return;

      const qty = stack.qty ?? 1;
      if (qty <= 0) return;

      // Spawn the dropped items a short distance in front of the player so they
      // don't get auto-picked up immediately by the pickup radius.
      let dropX = p.x;
      let dropY = p.y;
      const fx = p.facing && Number.isFinite(p.facing.x) ? p.facing.x : 0;
      const fy = p.facing && Number.isFinite(p.facing.y) ? p.facing.y : 0;
      const DROP_DIST = 28;
      if (fx !== 0 || fy !== 0) {
        dropX += fx * DROP_DIST;
        dropY += fy * DROP_DIST;
      } else {
        dropX += DROP_DIST;
      }

      spawnItemDrop(p.mapId, dropX, dropY, stack.id, qty, {
        weaponBonus: stack.weaponBonus
      });

      // Clear the inventory slot.
      p.inventory.slots[slotIndex] = null;
      return;
    }


    if (msg.type === "unequip") {
      if (p.hp <= 0 || p.respawnIn > 0) return;
      const slotName = String(msg.slot || "");
      if (slotName !== "weapon" && slotName !== "armor" && slotName !== "hat" && slotName !== "accessory") return;

      const equippedId = p.equipment[slotName];
      if (!equippedId) return;

      const empty = p.inventory.slots.findIndex(s => !s);
      if (empty === -1) return; // inventory full

      const slot = { id: equippedId, qty: 1 };

      if (slotName === "weapon") {
        // Preserve the current weapon roll when putting it back into the bag.
        if (Number.isFinite(p.weaponBonus)) {
          slot.weaponBonus = p.weaponBonus;
        }
        p.weaponBonus = 0;
      }

      p.inventory.slots[empty] = slot;
      p.equipment[slotName] = null;

      if (slotName === "weapon") {
        p.weapon = "sword"; // default unarmed behavior uses sword logic for now
      }

      // Apply derived stat bonuses from equipment changes
      recomputePlayerBonuses(p);
      return;
    }

    
    if (msg.type === "invMove") {
      if (p.hp <= 0 || p.respawnIn > 0) return;
      const from = Number(msg.from);
      const to = Number(msg.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      if (from === to) return;

      const slots = p.inventory && Array.isArray(p.inventory.slots) ? p.inventory.slots : null;
      if (!slots) return;
      if (from < 0 || from >= slots.length || to < 0 || to >= slots.length) return;

      const fromStack = slots[from];
      const toStack = slots[to];
      if (!fromStack && !toStack) return;

      slots[from] = toStack || null;
      slots[to] = fromStack || null;
      return;
    }

if (msg.type === "editTile") {
      if (!ENABLE_MAP_EDITOR) return;

      // Only allow editing the map you're currently on.
      const m0 = maps[p.mapId];
      if (!m0) return;

      const layer = String(msg.layer || "");
      const tx = Number(msg.x);
      const ty = Number(msg.y);
      const tile = Number(msg.tile);

      if (!Number.isInteger(tx) || !Number.isInteger(ty) || !Number.isInteger(tile)) return;
      if (tx < 0 || ty < 0 || tx >= m0.w || ty >= m0.h) return;

      // Avoid breaking portals/statues accidentally (use code for those for now).
      const currGround = m0.map[ty][tx];
      if (layer === "ground") {
        let ok = true;
        let reason = "ok";
        if (tile < 0 || tile > EDITOR_MAX_GROUND_TILE) { ok = false; reason = "invalid_ground_tile"; }
        // Don’t allow painting the portal tile via the editor (use code for portals)

        if (MAP_EDITOR_DEBUG_LOG) {
          console.log(`[EDITOR] ${ok ? "ACCEPT" : "REJECT"} ground @${p.mapId} (${tx},${ty}) ${currGround} -> ${tile} (${reason})`);
        }

        if (!ok) {
          send(ws, { type: "editAck", ok: false, layer: "ground", x: tx, y: ty, tile, reason });
          return;
        }

        m0.map[ty][tx] = tile;
        broadcastToMap(p.mapId, { type: "mapPatch", mapId: p.mapId, layer: "ground", x: tx, y: ty, tile });
        send(ws, { type: "editAck", ok: true, layer: "ground", x: tx, y: ty, tile });
        return;
      }

      if (layer === "object") {
        if (!m0.obj) m0.obj = makeEmptyLayer(m0.w, m0.h, 0);
        // allow any non-negative object tile id; collision/render behavior is derived from row parity (odd=canopy, even=solid)
        let ok = true;
        let reason = "ok";
        if (tile < 0) { ok = false; reason = "invalid_object_tile"; }

        if (MAP_EDITOR_DEBUG_LOG) {
          console.log(`[EDITOR] ${ok ? "ACCEPT" : "REJECT"} object @${p.mapId} (${tx},${ty}) -> ${tile} (${reason})`);
        }

        if (!ok) {
          send(ws, { type: "editAck", ok: false, layer: "object", x: tx, y: ty, tile, reason });
          return;
        }

        m0.obj[ty][tx] = tile;
        broadcastToMap(p.mapId, { type: "mapPatch", mapId: p.mapId, layer: "object", x: tx, y: ty, tile });
        send(ws, { type: "editAck", ok: true, layer: "object", x: tx, y: ty, tile });
        return;
      }

      return;
    }

    if (msg.type === "portal") {
      if (p.hp <= 0 || p.respawnIn > 0) return;

      // Small cooldown to prevent instant portal ping-pong now that we spawn directly on portal tiles.
      const nowMs = Date.now();
      if (nowMs < (p.portalCdUntilMs || 0)) return;

      const m0 = maps[p.mapId];
      if (!m0) return;

      const { tx, ty } = playerFootTile(p);

      const portal = (m0.portals || []).find(pp => pp.x === tx && pp.y === ty);
      if (!portal) return;

      const to = portal.to;
      if (!to || !maps[to]) return;

      const fromMapId = p.mapId;
      const sp = findPortalSpawn(to, fromMapId);

      // If the player leaves the map, any active Skill 1 effects they own should end immediately.
      cancelSkill1ForCaster(p.id);
      p.skill1ActiveUntilMs = 0;
      p.skill1Primed = false;

      // Leaving the map should keep Skill 5 toggled, but clear its current target.
      // We leave p.familiarActive as-is and only reset target/timer.
      p.familiarTargetMobId = null;
      p.familiarNextAtkMs = 0;

      // Leaving the map should also cancel any active Healing Cloud (Skill 6)
      // so that it does not resume when returning to this or another map.
      p.skill6CloudUntilMs = 0;
      p.skill6NextHealMs = 0;
      p.skill6CloudX = 0;
      p.skill6CloudY = 0;

      p.mapId = to;
      p.x = sp.x;
      p.y = sp.y;

      // Arm cooldown AFTER successful travel.
      p.portalCdUntilMs = nowMs + 450;
      return;
    }

    if (msg.type === "interact") {
      if (p.hp <= 0 || p.respawnIn > 0) return;

      const npcId = String(msg.npcId || "");
      const npc = npcs.get(npcId);
      if (!npc) return;
      if (npc.mapId !== p.mapId) return;

      const INTERACT_RANGE = 80;
      if (dist(p.x, p.y, npc.x, npc.y) > INTERACT_RANGE) return;


      // Special NPC: Jangoon starter quest (kill 10 green slimes -> Red Duke)
      if (npcId === "npc_jangoon") {
        const q = getJangoonQuest(p);
        const NEED = 10;

        if (!q.started) {
          q.started = true;
          q.kills = 0;
          q.completed = false;
          q.rewarded = false;
          send(ws, { type: "dialogue", npcId, npcName: npc.name || npcId, text: `Quest started: Slime Cleanup!\nKill ${NEED} green slimes. (0/${NEED})` });
          return;
        }

        if (!q.completed && (q.kills || 0) >= NEED) q.completed = true;

        if (q.completed && !q.rewarded) {
          addItemToInventory(p, "red_duke", 1);
          q.rewarded = true;
          send(ws, { type: "dialogue", npcId, npcName: npc.name || npcId, text: "Well done. Take this: Red Duke." });
          return;
        }

        if (!q.completed) {
          send(ws, { type: "dialogue", npcId, npcName: npc.name || npcId, text: `Slime Cleanup progress: ${q.kills || 0}/${NEED} green slimes.` });
          return;
        }

        send(ws, { type: "dialogue", npcId, npcName: npc.name || npcId, text: "Stay sharp out there." });
        return;
      }

      const lines = npcDialogue[npcId] || ["..."];

      const text = lines[Math.floor(Math.random() * lines.length)];
      send(ws, { type: "dialogue", npcId, npcName: npc.name || npcId, text });
      return;
    }

    // Hold-to-attack support (mouse button held).
    // Client sends:
    //  - {type: "attackHold", down: true/false, aimX/aimY or aimDirX/aimDirY}
    //  - {type: "attackHoldAim", aimX/aimY or aimDirX/aimDirY}
    if (msg.type === "attackHold") {
      const down = !!msg.down;
      p.attackHeld = down;

      if (!down) {
        p.attackHeldAim = null;
        return;
      }

      const aim = {};
      if (Number.isFinite(Number(msg.aimX))) aim.aimX = Number(msg.aimX);
      if (Number.isFinite(Number(msg.aimY))) aim.aimY = Number(msg.aimY);
      if (Number.isFinite(Number(msg.aimDirX))) aim.aimDirX = Number(msg.aimDirX);
      if (Number.isFinite(Number(msg.aimDirY))) aim.aimDirY = Number(msg.aimDirY);
      p.attackHeldAim = aim;

      // Fire immediately on press (then server tick will keep attempting while held).
      attemptBasicAttack(ws, p, aim, Date.now());
      return;
    }

    if (msg.type === "attackHoldAim") {
      if (!p.attackHeld) return;
      const aim = p.attackHeldAim || {};
      if (Number.isFinite(Number(msg.aimX))) aim.aimX = Number(msg.aimX);
      if (Number.isFinite(Number(msg.aimY))) aim.aimY = Number(msg.aimY);
      if (Number.isFinite(Number(msg.aimDirX))) aim.aimDirX = Number(msg.aimDirX);
      if (Number.isFinite(Number(msg.aimDirY))) aim.aimDirY = Number(msg.aimDirY);
      p.attackHeldAim = aim;
      return;
    }

    if (msg.type === "attack") {
      attemptBasicAttack(ws, p, msg, Date.now());
      return;
    }

if (msg.type === "useItem") {

  const slotIndex = (msg.slot|0);
  if (!p.inventory || !p.inventory.slots) return;
  if (slotIndex < 0 || slotIndex >= p.inventory.slots.length) return;

  const slot = p.inventory.slots[slotIndex];
  if (!slot) return;

  const def = ITEMS[slot.id];
  if (!def || !def.onUse) return;

  if (isHealingConsumable(def) && p.hp >= p.maxHp) return;
  def.onUse(p);
  slot.qty -= 1;
  if (slot.qty <= 0) p.inventory.slots[slotIndex] = null;
  return;
}

});

	ws.on("close", async () => {
	  const pid = socketToId.get(ws);
	  socketToId.delete(ws);
	  idToSocket.delete(pid);

	  const p = players.get(pid);
	  if (p) {
		cancelSkill1ForCaster(pid);
		// End any active familiar so it doesn't linger across sessions.
		p.familiarActive = false;
		p.familiarTargetMobId = null;
		p.familiarNextAtkMs = 0;
		await dbSavePlayer(p);  // ✅ Save state to Postgres
		players.delete(pid);
		console.log(`💾 Saved and removed player: ${p.name || pid}`);
	  }
	});

	  
	  
});

/* ======================
   TICK
====================== */
const TICK_HZ = 30;


/* ======================
       SKILLS (server authoritative)
    ====================== */
    const SKILL1_RANGE_PX = 150;          // targeting radius from caster
    const SKILL1_EFFECT_RADIUS_PX = 40;  // mobs affected within this radius of the cast center
    const SKILL1_DURATION_MS = 10_000;     // effect duration (short for testing)
    const SKILL1_COOLDOWN_MS = 5_000;     // cooldown starts when cast begins

// Skill 5: Familiar (wand-only)
// - Toggle on/off
// - When on, the familiar targets the last mob you hit with a normal wand bolt
// - Deals small damage once per second and provokes (aggros) the target
const SKILL5_HIT_MS = 1000;
const SKILL5_DMG = 3;
const SKILL5_TRAVEL_SPEED = 260; // units/sec, used to delay first familiar hit based on distance

// Skill 6: Healing Cloud (wand-only)
// - 10 second duration
// - Heals the caster periodically while active
const SKILL6_DURATION_MS = 10_000;
const SKILL6_TICK_MS = 1_000;
const SKILL6_HEAL_PER_TICK = 3;
const SKILL6_HEAL_RADIUS = 70;  // radius (px) around cloud center that receives healing

    // Active whirlpools (skill1 instances)
    // id -> { id, mapId, x, y, rad, casterId, startMs, endMs }
    const whirlpools = new Map();

    // End any active Skill 1 effects owned by a caster immediately.
    // Used when the caster leaves a map (portal/respawn/disconnect).
    function cancelSkill1ForCaster(casterId) {
      if (!casterId || whirlpools.size === 0) return;
      for (const [wid, w] of whirlpools) {
        if (w.casterId === casterId) whirlpools.delete(wid);
      }
    }

    function tryStartSkill1Whirlpool(caster, mapId, x, y) {
      if (!caster) return false;
      const nowMs = Date.now();

      // Can't start while active or on cooldown
      if (nowMs < (caster.skill1ActiveUntilMs || 0) || nowMs < (caster.skill1CdUntilMs || 0)) return false;

      // Must be on passable tile (base + objects)
      if (isBlocked(mapId, x, y)) return false;

      const id = `${caster.id}:${nowMs}`;
      const startMs = nowMs;
      const endMs = nowMs + SKILL1_DURATION_MS;

      whirlpools.set(id, { id, mapId, x, y, rad: SKILL1_EFFECT_RADIUS_PX, casterId: caster.id, startMs, endMs });

      caster.skill1ActiveUntilMs = endMs;
      // Cooldown starts when the whirlpool begins
      caster.skill1CdUntilMs = startMs + SKILL1_COOLDOWN_MS;

      const ws = idToSocket.get(caster.id);
      if (ws) send(ws, { type: "skill1Accepted", center: { x, y }, startMs, endMs, cdUntilMs: caster.skill1CdUntilMs });

      return true;
    }


/* ======================
   MOB MOVEMENT HELPERS
====================== */
// Movement collision can be slightly smaller than the mob's combat radius to reduce corner-sticking
// without changing how "chunky" they feel for hits.
const MOB_MOVE_RADIUS_MUL = 0.85;

// Extra knockback when a single hit deals a big chunk of damage.
// These are global defaults; each mob can override via MOB_DEFS or spawn opts.
const BIG_KNOCKBACK_THRESHOLD = 15; // default damage threshold in a single hit
const BIG_KNOCKBACK_DIST = 96;      // default how far to push mobs on a big hit (in px)

function knockbackMobFrom(m, srcX, srcY, dist) {
  if (!m || !Number.isFinite(dist) || dist <= 0) return;

  let dx = m.x - srcX;
  let dy = m.y - srcY;
  const len = Math.hypot(dx, dy);

  // If we're essentially on top of the source, just pick an arbitrary direction.
  if (len < 1e-6) {
    dx = 0;
    dy = -1;
  } else {
    dx /= len;
    dy /= len;
  }

  const moveRadius = (m && Number.isFinite(m.radius))
    ? m.radius * MOB_MOVE_RADIUS_MUL
    : MOB_RADIUS * MOB_MOVE_RADIUS_MUL;

  // Uses the existing slide / corner-hugging logic so we don't shove mobs into walls.
  moveMobWithSlide(m, dx * dist, dy * dist, moveRadius);
}

function maybeBigKnockback(m, srcX, srcY, dmg, kbMul = 1) {
  if (!m) return;
  if (!Number.isFinite(dmg)) return;

  // Allow per-mob tuning with sensible fallbacks.
  const def = m.mobType ? (MOB_DEFS[m.mobType] || null) : null;

  const threshold =
    Number.isFinite(m.knockbackThreshold) ? m.knockbackThreshold :
    def && Number.isFinite(def.knockbackThreshold) ? def.knockbackThreshold :
    BIG_KNOCKBACK_THRESHOLD;

  const dist =
    Number.isFinite(m.knockbackDist) ? m.knockbackDist :
    def && Number.isFinite(def.knockbackDist) ? def.knockbackDist :
    BIG_KNOCKBACK_DIST;

  if (dmg < threshold) return;
  const mul = (Number.isFinite(kbMul) && kbMul > 0) ? kbMul : 1;
  knockbackMobFrom(m, srcX, srcY, dist * mul);
}


// Try to move using axis-separated slide; if blocked, optionally "hug" corners by trying a perpendicular step.
function moveMobWithSlide(m, stepX, stepY, radius, target = null) {
  let moved = false;

  // Standard "slide" (x then y)
  if (!collides(m.mapId, m.x + stepX, m.y, radius)) { m.x += stepX; moved = true; }
  if (!collides(m.mapId, m.x, m.y + stepY, radius)) { m.y += stepY; moved = true; }

  if (moved) return true;

  const len = Math.hypot(stepX, stepY);
  if (len < 1e-6) return false;

  // Corner assist: try moving perpendicular to the desired direction to "wrap" around corners.
  // Two perpendicular options: left/right around the obstacle.
  const p1x = -stepY, p1y = stepX;
  const p2x = stepY,  p2y = -stepX;

  function attempt(px, py) {
    const l = Math.hypot(px, py) || 1;
    const sx = (px / l) * len;
    const sy = (py / l) * len;

    const ox = m.x, oy = m.y;
    let ok = false;

    if (!collides(m.mapId, ox + sx, oy, radius)) { m.x = ox + sx; ok = true; } else { m.x = ox; }
    if (!collides(m.mapId, m.x, oy + sy, radius)) { m.y = oy + sy; ok = true; } else { m.y = oy; }

    if (!ok) { m.x = ox; m.y = oy; }
    return ok;
  }

  // If we have a target, choose the side that best reduces distance to it.
  if (target) {
    const ox = m.x, oy = m.y;

    // score p1
    let ok1 = attempt(p1x, p1y);
    const d1 = ok1 ? dist(m.x, m.y, target.x, target.y) : Infinity;
    m.x = ox; m.y = oy;

    // score p2
    let ok2 = attempt(p2x, p2y);
    const d2 = ok2 ? dist(m.x, m.y, target.x, target.y) : Infinity;
    m.x = ox; m.y = oy;

    if (ok1 && (!ok2 || d1 <= d2)) return attempt(p1x, p1y);
    if (ok2) return attempt(p2x, p2y);
    return false;
  }

  return attempt(p1x, p1y) || attempt(p2x, p2y);
}

const FIXED_TICK_DT = 1 / TICK_HZ;
let lastTickMs = Date.now();
let tickAcc = 0;

function tickStep(dt) {
  // Remove expired whirlpools
  if (whirlpools.size > 0) {
    const nowMs = Date.now();
    for (const [wid, w] of whirlpools) {
      if (nowMs >= w.endMs) whirlpools.delete(wid);
    }
  }


    // Players movement + timers + save + drop pickup + respawn
    const BASE_PLAYER_MOVE_SPEED = 125;
    for (const p of players.values()) {
      p.atkAnim = Math.max(0, p.atkAnim - dt);
      p.atkCd = Math.max(0, p.atkCd - dt);
      p.invuln = Math.max(0, p.invuln - dt);

      // Respawn countdown
      if (p.respawnIn > 0) {
        p.respawnIn -= dt;
        if (p.respawnIn <= 0) {
          // If the player is being moved to a (potentially different) map on respawn,
          // end any active Skill 1 effects they own immediately.
          cancelSkill1ForCaster(p.id);
          p.skill1ActiveUntilMs = 0;
          p.skill1Primed = false;

          // Respawn cancels Skill 5 (Familiar).
          p.familiarActive = false;
          p.familiarTargetMobId = null;
          p.familiarNextAtkMs = 0;

          // Respawn cancels Skill 6 (Healing Cloud).
          p.skill6CloudUntilMs = 0;
          p.skill6NextHealMs = 0;
          p.skill6CloudX = 0;
          p.skill6CloudY = 0;

          if (p.save) {
            p.mapId = p.save.mapId;
            p.x = p.save.x;
            p.y = p.save.y;
          } else {
            const s = findSpawn("C", PLAYER_FOOT_RADIUS);
            p.mapId = "C";
            p.x = s.x;
            p.y = s.y;
          }
          p.hp = p.maxHp;
          p.invuln = 0.6;
          p.atkCd = 0;
          p.atkAnim = 0;
          p.basicAtkLockUntilMs = 0;
          p.attackHeld = false;
          p.attackHeldAim = null;
        }
        continue;
      }

      if (p.hp <= 0) continue;

      const nowMs = Date.now();

      // Hold-to-attack: if the player is holding the mouse button down,
      // keep attempting basic attacks as soon as cooldown/lock allow.
      if (p.attackHeld && p.atkCd <= 0 && nowMs >= (p.basicAtkLockUntilMs || 0)) {
        attemptBasicAttack(null, p, p.attackHeldAim || {}, nowMs);
      }

      const locked = (nowMs < (p.basicAtkLockUntilMs || 0));

      let dx = 0, dy = 0;
      if (p.inputs.left) dx -= 1;
      if (p.inputs.right) dx += 1;
      if (p.inputs.up) dy -= 1;
      if (p.inputs.down) dy += 1;

      // Freeze movement during the basic-attack lock window.
      if (locked) { dx = 0; dy = 0; }

      const len = Math.hypot(dx, dy);
      if (len > 0) { dx /= len; dy /= len; }

      const speedStat = (typeof getPlayerSpeedStat === "function") ? getPlayerSpeedStat(p) : (Number.isFinite(p.speed) ? p.speed : 100);
      const moveSpeed = BASE_PLAYER_MOVE_SPEED * (speedStat / 100);

      const nx = p.x + dx * moveSpeed * dt;
      const ny = p.y + dy * moveSpeed * dt;

      if (!collidesPlayer(p.mapId, nx, p.y)) p.x = nx;
      if (!collidesPlayer(p.mapId, p.x, ny)) p.y = ny;

      clampToWorldPlayer(p.mapId, p);

      maybePickupDropsForPlayer(p);
    }

    // Projectiles
    const nowMs = Date.now();
    for (const [pid, pr] of projectiles) {
      if (pr.expiresAtMs <= nowMs) { projectiles.delete(pid); continue; }

      // move
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;

      // hit wall -> delete
      if (collides(pr.mapId, pr.x, pr.y, pr.rad)) {
        projectiles.delete(pid);
        continue;
      }

      // hit mob
      for (const m of mobs.values()) {
        if (m.mapId !== pr.mapId) continue;
        if (m.respawnIn > 0) continue;
        if (m.hp <= 0) continue;

        if (dist(pr.x, pr.y, m.x, m.y) <= (pr.rad + (m.radius ?? MOB_RADIUS))) {
          // Skill-shot projectiles should not also deal normal wand damage.
          const isSkill1Shot = !!pr.skill1;
          const hitDmg = isSkill1Shot ? 0 : pr.damage;
          if (hitDmg > 0) m.hp -= hitDmg;
          m.lastHitBy = pr.ownerId;

          // Big knockback if this single hit is strong enough (normal wand bolts only).
          if (hitDmg > 0) {
            maybeBigKnockback(m, pr.x, pr.y, hitDmg, pr.knockbackMul);
}

          // Skill 1 should NOT provoke/aggro mobs. Normal hits still do.
          if (!isSkill1Shot) setMobAggro(m, pr.ownerId);

          // Skill 5: Familiar target assignment. Only normal wand bolts count (Skill 1 bolts don't).
          if (!isSkill1Shot) {
            const caster = players.get(pr.ownerId);
            if (caster && caster.familiarActive) {
              caster.familiarTargetMobId = m.id;
              // Allow an immediate follow-up strike on the next familiar tick.
              caster.familiarNextAtkMs = Date.now();
            }
          }

          // If this projectile was a primed Skill 1 shot, start the whirlpool ONLY on a successful mob hit.
          if (pr.skill1) {
            const caster = players.get(pr.ownerId);
            // Start centered on the mob that was hit.
            tryStartSkill1Whirlpool(caster, m.mapId, m.x, m.y);
            // Prevent double-trigger attempts from the same projectile.
            pr.skill1 = false;
          }

          broadcastToMap(pr.mapId, {
            type: "hit",
            targetId: m.id,
            targetKind: "mob",
            srcX: pr.x,
            srcY: pr.y,
            amount: hitDmg,
            fx: "bolt",
          });

          projectiles.delete(pid);

          if (m.hp <= 0) {
            killMobAndReward(m, pr.ownerId);
          }
          break;
        }
      }
    }


    // Skill 5: Familiar auto-attacks (wand-only)
    // Notes:
    // - The familiar is visual-only on the client; the server just stores the state.
    // - It attacks at most once per second and always triggers mob aggro.
    {
      const now = nowMs;
      for (const p of players.values()) {
        if (!p.familiarActive) continue;

        // Safety: if a player is dead/respawning, cancel the skill.
        if (p.hp <= 0 || p.respawnIn > 0) {
          p.familiarActive = false;
          p.familiarTargetMobId = null;
          p.familiarNextAtkMs = 0;
          continue;
        }

        // If the player unequips their wand, cancel the skill.
        {
          const equippedWeaponId = p.equipment?.weapon;
          const equippedDef = equippedWeaponId ? ITEMS[equippedWeaponId] : null;
          const weaponKey = equippedDef?.weaponKey || null;
          if (weaponKey !== "wand") {
            p.familiarActive = false;
            p.familiarTargetMobId = null;
            p.familiarNextAtkMs = 0;
            continue;
          }
        }

        const tid = p.familiarTargetMobId;
        if (!tid) continue;

        const m = mobs.get(tid);
        if (!m || m.mapId !== p.mapId || m.respawnIn > 0 || m.hp <= 0) {
          p.familiarTargetMobId = null;
          p._familiarLastTargetMobId = null;
          continue;
        }

        // If the familiar just switched to a new target, delay the first hit
        // based on approximate travel time from the player to the mob so the
        // visual familiar flight and the damage feel synced.
        if (p._familiarLastTargetMobId !== tid) {
          const dx = (m.x ?? p.x) - p.x;
          const dy = (m.y ?? p.y) - p.y;
          const dist = Math.hypot(dx, dy);
          const travelMs = (dist / SKILL5_TRAVEL_SPEED) * 1000;
          p.familiarNextAtkMs = now + travelMs;
          p._familiarLastTargetMobId = tid;
        }

        if (now < (p.familiarNextAtkMs || 0)) continue;

        const dmg = SKILL5_DMG;
        m.hp -= dmg;
        m.lastHitBy = p.id;

        // Familiar hits provoke the mob.
        setMobAggro(m, p.id);

        broadcastToMap(p.mapId, {
          type: "hit",
          targetId: m.id,
          targetKind: "mob",
          srcX: p.x,
          srcY: p.y,
          amount: dmg,
          fx: "familiar",
        });

        // After the first hit, subsequent hits follow the base tick rate.
        p.familiarNextAtkMs = now + SKILL5_HIT_MS;

        if (m.hp <= 0) {
          killMobAndReward(m, p.id);
          // After the target dies, the familiar goes back to idle-following until reassigned.
          p.familiarTargetMobId = null;
          p._familiarLastTargetMobId = null;
        }
      }
    }

    // Skill 6: Healing Cloud (area heal-over-time under the cloud)
    {
      const now = nowMs;
      for (const owner of players.values()) {
        if (!owner.skill6CloudUntilMs || owner.skill6CloudUntilMs <= 0) continue;

        // If owner is dead/respawning, cancel the cloud.
        if (owner.hp <= 0 || owner.respawnIn > 0) {
          owner.skill6CloudUntilMs = 0;
          owner.skill6NextHealMs = 0;
          continue;
        }

        // Expired?
        if (now >= owner.skill6CloudUntilMs) {
          owner.skill6CloudUntilMs = 0;
          owner.skill6NextHealMs = 0;
          continue;
        }

        const nextHeal = owner.skill6NextHealMs || 0;
        if (now < nextHeal) continue;

        // Schedule next tick first so we don't accidentally double-fire.
        owner.skill6NextHealMs = now + SKILL6_TICK_MS;

        const cx = owner.skill6CloudX;
        const cy = owner.skill6CloudY;
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;

        const r = SKILL6_HEAL_RADIUS;
        const r2 = r * r;

        // Heal any players standing under/near the cloud on the same map.
        for (const target of players.values()) {
          if (target.mapId !== owner.mapId) continue;
          if (target.maxHp <= 0 || target.hp <= 0) continue;

          const dx = target.x - cx;
          const dy = target.y - cy;
          if (dx * dx + dy * dy > r2) continue;

          const missing = Math.max(0, target.maxHp - target.hp);

          // Amount of HP we actually restore this tick, respecting maxHp.
          const apply = Math.min(SKILL6_HEAL_PER_TICK, missing);
          if (apply > 0) {
            target.hp = Math.min(target.maxHp, target.hp + apply);
          }

          // For visuals, always show at least the base tick size even if the player is already full.
          let displayAmount = apply;
          if (displayAmount <= 0) {
            displayAmount = SKILL6_HEAL_PER_TICK;
          }
          if (!(displayAmount > 0)) continue;

          // Broadcast a heal event so clients can show +HP popups / green flash.
          broadcastToMap(owner.mapId, {
            type: "heal",
            targetId: target.id,
            amount: displayAmount,
            srcX: cx,
            srcY: cy,
          });
        }
      }
    }

    // Mobs: wander + melee attack + respawn
    const BASE_MOB_SPEED = 125;
    // use per-mob baseAggroRange / hitAggroRange instead of a single constant
    const MOB_HIT = 36;
    // MOB damage is per-type (see MOB_DEFS). Fallback below if missing.
    const MOB_ATK_CD = 0.9;

    for (const m of mobs.values()) {
      if (m.respawnIn > 0) {
        m.respawnIn -= dt;
        if (m.respawnIn <= 0) respawnMob(m);
        continue;
      }
      if (m.hp <= 0) continue;

      m.atkCd = Math.max(0, m.atkCd - dt);

      // passive logic: only aggro after being hit (or while aggroUntil)
      let target = null;
      let bestD = Infinity;

      const aggroActive = (!m.passiveUntilHit) || (m.aggroUntil > Date.now());

      if (m.aggroUntil <= Date.now()) {
        m.aggroTargetId = null;
      }

      for (const p of players.values()) {
        if (p.mapId !== m.mapId) continue;
        if (p.hp <= 0) continue;
        if (p.respawnIn > 0) continue;

        // If this mob was recently hit, it "locks on" to the attacker for a few seconds.
        if (m.aggroUntil > Date.now() && m.aggroTargetId && p.id !== m.aggroTargetId) continue;

        if (m.passiveUntilHit) {
          if (!aggroActive) continue;
          if (m.aggroTargetId && p.id !== m.aggroTargetId) continue;
        }

        const d = dist(p.x, p.y, m.x, m.y);
        if (d < bestD) { bestD = d; target = p; }
      }

      let dirX = 0, dirY = 0;

      const nowAggroMs = Date.now();
      const provoked = (m.aggroUntil > nowAggroMs) && !!m.aggroTargetId;
      const aggroRange = provoked ? (m.hitAggroRange ?? MOB_HIT_AGGRO) : (m.baseAggroRange ?? MOB_BASE_AGGRO);

      if (target && bestD <= aggroRange) {
        const dx = target.x - m.x;
        const dy = target.y - m.y;
        const l = Math.hypot(dx, dy) || 1;
        dirX = dx / l;
        dirY = dy / l;

        if (bestD <= MOB_HIT && m.atkCd <= 0) {
          m.atkCd = MOB_ATK_CD;

          if (target.invuln <= 0) {
            const dmg = Number.isFinite(m.damage) ? m.damage : 10;
            target.hp = Math.max(0, target.hp - dmg);
            target.invuln = 0.35;

            if (target.hp <= 0 && target.respawnIn <= 0) {
              target.respawnIn = 2.0;
              const ws = idToSocket.get(target.id);
              if (ws) send(ws, { type: "dead" });
            }

            const kx = (dx / l) * 16;
            const ky = (dy / l) * 16;

            const nx = target.x + kx;
            const ny = target.y + ky;

            if (!collidesPlayer(target.mapId, nx, target.y)) target.x = nx;
            if (!collidesPlayer(target.mapId, target.x, ny)) target.y = ny;
            clampToWorldPlayer(target.mapId, target);

            broadcastToMap(target.mapId, {
              type: "hit",
              targetId: target.id,
              targetKind: "player",
              srcX: m.x,
              srcY: m.y,
              amount: dmg,
              fx: "bite",
            });
          }
        }
      } else {
        m.changeDirIn -= dt;
        if (m.changeDirIn <= 0) {
          const [dx, dy] = randomDir();
          m.dirX = dx; m.dirY = dy;
          m.changeDirIn = 0.7 + Math.random() * 1.2;
        }
        dirX = m.dirX;
        dirY = m.dirY;
      }

      const speedStat = Number.isFinite(m.speed) ? m.speed : 100;
      const speed = BASE_MOB_SPEED * (speedStat / 100) * (m.speedMul ?? 0.65) * (provoked ? (m.aggroSpeedMul ?? 1.0) : 1.0);

  // While chasing, if we get stuck on corners, add a short "wall-hug" nudge.
  // This is cheap, feels good, and avoids full pathfinding.
  if (target && bestD <= aggroRange) {
    if (m.stuckForMs > 350 && m.nudgeUntilMs <= nowAggroMs) {
      m.nudgeUntilMs = nowAggroMs + 260;
      m.nudgeSign = (Math.random() < 0.5 ? -1 : 1);
      m.stuckForMs = 0;
    }
    if (m.nudgeUntilMs > nowAggroMs) {
      // Blend desired dir with a perpendicular component (left/right) to help slip around corners.
      const sx = -dirY * m.nudgeSign;
      const sy = dirX * m.nudgeSign;
      const bx = dirX + sx * 0.9;
      const by = dirY + sy * 0.9;
      const bl = Math.hypot(bx, by) || 1;
      dirX = bx / bl;
      dirY = by / bl;
    }
  }

  const stepX = dirX * speed * dt;
  const stepY = dirY * speed * dt;

  const radCombat = (m.radius ?? MOB_RADIUS);
  const radMove = radCombat * MOB_MOVE_RADIUS_MUL;

  const moved = moveMobWithSlide(m, stepX, stepY, radMove, (target && bestD <= aggroRange) ? target : null);


  // Skill 1: whirlpool pull (mobs still run their normal AI movement, we just add an extra "drag" step)
  // Multiple whirlpools stack by summing their pull vectors.
  if (whirlpools.size > 0) {
    let fx = 0, fy = 0;
    const nowMs = Date.now();
    for (const w of whirlpools.values()) {
      if (w.mapId !== m.mapId) continue;
      if (nowMs >= w.endMs) continue;
      const dxw = w.x - m.x;
      const dyw = w.y - m.y;
      const dw = Math.hypot(dxw, dyw);
      if (dw <= 1e-6 || dw > w.rad) continue;

      // Pull strength ramps up as you get closer to the edge -> gentle near center.
      const t = 1 - (dw / w.rad); // 0 at edge, 1 at center
      const strength = 65 + 55 * t; // px/sec
      fx += (dxw / dw) * strength;
      fy += (dyw / dw) * strength;
    }

    if (fx !== 0 || fy !== 0) {
      const stepPullX = fx * dt;
      const stepPullY = fy * dt;
      moveMobWithSlide(m, stepPullX, stepPullY, radMove, null);
    }
  }


  // If chasing and we didn't move, accumulate "stuck time" so we can apply a brief nudge.
  if (target && bestD <= aggroRange) {
    if (!moved) m.stuckForMs = (m.stuckForMs ?? 0) + dt * 1000;
    else m.stuckForMs = 0;
  } else {
    m.stuckForMs = 0;
    m.nudgeUntilMs = 0;
  }

  if (!moved) m.changeDirIn = 0;

  clampToWorld(m.mapId, m, radCombat);
    }

    // drop expiry cleanup
    for (const [did, d] of drops) {
      if (d.expiresAtMs <= nowMs) drops.delete(did);
    }
}

setInterval(() => {
  const nowMs = Date.now();
  let frameDt = (nowMs - lastTickMs) / 1000;
  lastTickMs = nowMs;
  if (!Number.isFinite(frameDt) || frameDt < 0) frameDt = FIXED_TICK_DT;
  frameDt = Math.min(0.25, frameDt);
  tickAcc += frameDt;

  const maxSteps = 6;
  let steps = 0;
  while (tickAcc >= FIXED_TICK_DT && steps < maxSteps) {
    tickStep(FIXED_TICK_DT);
    tickAcc -= FIXED_TICK_DT;
    steps++;
  }
  if (steps === maxSteps) tickAcc = 0;
}, 1000 / TICK_HZ);


/* ======================
   SNAPSHOTS
====================== */
const SNAPSHOT_HZ = 15;

// ===== Skill 2: Double Stab (spear-only) =====
const SKILL2_COOLDOWN_MS = 6_000;
const SKILL2_GAP_MS = 120;          // time between the two stabs
const SKILL2_ATK_ANIM = 0.14;       // shorter than normal attack anim
const SKILL2_SPEAR_OFFSET = 58;     // base spear OFFSET(50) + bonus reach
const SKILL2_SPEAR_RADIUS = 38;     // base spear RADIUS(32) + bonus hitbox
const SKILL2_JUT_ANGLE = Math.PI / 28; // ~6.4 degrees
// ===== Skill 3: Dash Slash (sword-only) =====
const SKILL3_COOLDOWN_MS = 4_500;
const SKILL3_DASH_DIST_PX = 130;
const SKILL3_DASH_STEPS = 10;         // higher = safer vs wall phasing
const SKILL3_DASH_DAMAGE_MULT = 0.55; // smaller "contact" damage while dashing through enemies
const SKILL3_DASH_CONTACT_PAD = 6;    // extra pixels added to contact radius to make hits feel reliable
const SKILL3_DAMAGE_MULT = 1.35;      // damage multiplier vs normal sword hit
const SKILL3_ATK_ANIM = 0.20;         // visual swing time (seconds)
const SKILL3_ATK_LOCK_SEC = 0.28;     // short lockout so you can't instantly chain basics

// ===== Skill 4: Wide Slash (sword-only, bigger arc) =====
const SKILL4_COOLDOWN_MS = 7_000;
const SKILL4_ATK_ANIM = 0.24;
const SKILL4_MAX_HITS = 3;
const SKILL4_RANGE_MULT = 1.35;

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;

    const pid = socketToId.get(ws);
    const me = pid ? players.get(pid) : null;
    if (!me) continue;

    const mapId = me.mapId;
    const m = maps[mapId];

    const ps = {};
    for (const [id, p] of players) {
      if (p.mapId !== mapId) continue;
      const totalAtk = (typeof getPlayerAttack === "function") ? getPlayerAttack(p) : (Number.isFinite(p.atk) ? p.atk : 0);
      ps[id] = {
        name: p.name,
        x: p.x, y: p.y,
        hp: p.hp, maxHp: p.maxHp,
        level: p.level, xp: p.xp, xpNext: p.xpNext,
        atk: totalAtk,
        speed: (typeof getPlayerSpeedStat === "function") ? getPlayerSpeedStat(p) : (Number.isFinite(p.speed) ? p.speed : 100),
        baseSpeed: Number.isFinite(p.speed) ? p.speed : 100,
        speedBonus: Number.isFinite(p.speedBonus) ? p.speedBonus : 0,
        baseAtk: Number.isFinite(p.atk) ? p.atk : 0,
        weaponBonus: Number.isFinite(p.weaponBonus) ? p.weaponBonus : 0,
        atkAnim: p.atkAnim,
        atkDir: p.atkDir,
        atkKind: p.atkKind || null,
        basicAtkLockUntilMs: p.basicAtkLockUntilMs || 0,
        facing: p.facing,
        gold: p.gold,
        weapon: p.weapon,
        equipment: p.equipment,
        familiarActive: !!p.familiarActive,
        familiarTargetId: p.familiarTargetMobId || null,
        healingCloudUntilMs: p.skill6CloudUntilMs || 0,
        healingCloudX: p.skill6CloudX ?? null,
        healingCloudY: p.skill6CloudY ?? null,
        ...(id === pid ? { inventory: p.inventory } : {})
      };
    }

    const ns = {};
    for (const [id, n] of npcs) {
      if (n.mapId !== mapId) continue;
      ns[id] = { x: n.x, y: n.y, name: n.name, sprite: n.sprite };
    }

    const ms = {};
    const nowMs = Date.now();
    for (const [id, mob] of mobs) {
      if (mob.mapId !== mapId) continue;

      const isCorpse = (mob.respawnIn > 0) && mob.corpseUntilMs && (mob.corpseUntilMs > nowMs);
      if (mob.respawnIn > 0 && !isCorpse) continue;

      ms[id] = {
        id,
        x: mob.x, y: mob.y,
        hp: mob.hp, maxHp: mob.maxHp,
        mobType: mob.mobType,
        speed: Number.isFinite(mob.speed) ? mob.speed : 100,
        radius: mob.radius ?? MOB_RADIUS,
        // Client uses this to keep HP bars visible while a mob is actively aggro/provoked
        // (e.g., kiting a mob outside the normal HP-bar distance).
        aggroUntil: mob.aggroUntil ?? 0,
        dead: isCorpse ? true : false,
        corpseMs: isCorpse ? (mob.corpseUntilMs - nowMs) : 0
      };
    }

    const ds = {};
    for (const [id, d] of drops) {
      if (d.mapId !== mapId) continue;
      ds[id] = { x: d.x, y: d.y, amount: d.amount, itemId: d.itemId, qty: d.qty };
    }

    const prs = {};
    for (const [id, pr] of projectiles) {
      if (pr.mapId !== mapId) continue;
      prs[id] = { x: pr.x, y: pr.y, ownerId: pr.ownerId, rad: pr.rad, sprite: pr.sprite || null };
    }

    send(ws, {
      type: "snapshot",
      nowMs: Date.now(),
      mapId,
      map: m.map,
      objMap: m.obj,
      portals: m.portals || [],
      mapW: m.w,
      mapH: m.h,
      tileSize: TILE,
      portalTile: PORTAL_TILE,

// active skill instances (map-scoped)
whirlpools: Array.from(whirlpools.values())
  .filter(w => w.mapId === mapId)
  .map(w => ({ id: w.id, x: w.x, y: w.y, rad: w.rad, casterId: w.casterId, startMs: w.startMs, endMs: w.endMs })),
// self skill timers (client UI convenience)
selfSkill1ActiveUntilMs: (players.get(socketToId.get(ws))?.skill1ActiveUntilMs) || 0,
selfSkill1CdUntilMs: (players.get(socketToId.get(ws))?.skill1CdUntilMs) || 0,
selfSkill2CdUntilMs: (players.get(socketToId.get(ws))?.skill2CdUntilMs) || 0,
selfSkill3CdUntilMs: (players.get(socketToId.get(ws))?.skill3CdUntilMs) || 0,
selfSkill4CdUntilMs: (players.get(socketToId.get(ws))?.skill4CdUntilMs) || 0,
selfMonsterBook: (players.get(socketToId.get(ws))?.monsterBook) || {},
      players: ps,
      npcs: ns,
      mobs: ms,
      drops: ds,
      projectiles: prs
    });
  }
}, 1000 / SNAPSHOT_HZ);

const PORT = process.env.PORT || 3000;

try {
  await ensurePostgresSchema();
} catch (err) {
  console.error("❌ Postgres schema ensure failed:", err?.message || err);
  // process.exit(1); // optional hard fail
}

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} (TILE=${TILE}, PORTAL_TILE=${PORTAL_TILE})`);
  console.log(`Maps: A=${maps.A.w}x${maps.A.h}, B=${maps.B.w}x${maps.B.h}, C=${maps.C.w}x${maps.C.h}, D=${maps.D.w}x${maps.D.h}`);
});