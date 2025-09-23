const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const SCORE_FILE = 'scores.json';
let scores = {};
let players = {};
let coins = [];
let plants = [];

// Serve static files
app.use(express.static('public'));
app.use(express.static('src'));

// Load scores
if (fs.existsSync(SCORE_FILE)) {
    const data = fs.readFileSync(SCORE_FILE);
    scores = JSON.parse(data);
}

// Save scores
function saveScores() {
    fs.writeFileSync(SCORE_FILE, JSON.stringify(scores, null, 2));
}

// Walls
const walls = [
    { x: 100, y: 100, width: 600, height: 20 },
    { x: 100, y: 480, width: 600, height: 20 },
    { x: 250, y: 200, width: 300, height: 20 },
    { x: 250, y: 360, width: 300, height: 20 },
    { x: 100, y: 120, width: 20, height: 120 },
    { x: 100, y: 320, width: 20, height: 160 },
    { x: 680, y: 120, width: 20, height: 360 }
];

// Utilities
function getRandomColor() {
    const colors = ['lime', 'red', 'blue', 'yellow', 'cyan', 'orange', 'purple', 'pink'];
    return colors[Math.floor(Math.random() * colors.length)];
}

function isInsideWall(x, y, size) {
    return walls.some(w => x + size > w.x && x - size < w.x + w.width &&
                           y + size > w.y && y - size < w.y + w.height);
}

// Coins
function spawnCoin() {
    let x, y;
    do {
        x = Math.random() * 760 + 20;
        y = Math.random() * 560 + 20;
    } while (isInsideWall(x, y, 10));

    const type = Math.random() < 0.5 ? 'milk' : 'fish';
    coins.push({ x, y, size: 10, type });
}
for (let i = 0; i < 5; i++) spawnCoin();

// Plants
const plantStages = 3;
const growthInterval = 10000; // 10s per stage
function spawnPlant() {
    let x, y;
    do {
        x = Math.random() * 760 + 20;
        y = Math.random() * 560 + 20;
    } while (isInsideWall(x, y, 16));
    plants.push({ x, y, stage: 0, plantedAt: Date.now() });
}
for (let i = 0; i < 5; i++) spawnPlant();

// Socket.io
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Login / registration
    socket.on('setName', ({ name, password }) => {
        if (!name || !password) return;

        if (!scores[name]) {
            // New player
            scores[name] = { password, score: 0 };
        } else {
            // Existing player, check password
            if (scores[name].password !== password) {
                socket.emit('loginFailed', 'Incorrect password');
                return;
            }
        }

        // Add player to game
        players[socket.id] = {
            x: 400,
            y: 300,
            size: 20,
            color: getRandomColor(),
            name,
            score: scores[name].score
        };

        // Send game state
        socket.emit('state', { players, coins, plants });
    });

    // Movement
    socket.on('move', (playerData) => {
        if (!players[socket.id]) return;

        players[socket.id] = {
            ...playerData,
            color: players[socket.id].color,
            name: players[socket.id].name,
            score: players[socket.id].score
        };

        // Coin collisions
        coins.forEach((coin, idx) => {
            const dx = players[socket.id].x - coin.x;
            const dy = players[socket.id].y - coin.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < players[socket.id].size + coin.size) {
                players[socket.id].score += 1;
                coins.splice(idx, 1);
                spawnCoin();
            }
        });

        io.emit('state', { players, coins });
    });

    // Disconnect
    socket.on('disconnect', () => {
        if (players[socket.id]) {
            const name = players[socket.id].name;
            scores[name].score = players[socket.id].score;
            saveScores();
            delete players[socket.id];
        }
        io.emit('state', { players, coins, plants });
    });
});

// Plant growth
setInterval(() => {
    const now = Date.now();
    plants.forEach(p => {
        const age = now - p.plantedAt;
        p.stage = Math.min(plantStages - 1, Math.floor(age / growthInterval));
    });
    io.emit('plants', plants);
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
