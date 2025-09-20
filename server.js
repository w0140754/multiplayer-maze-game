const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.static('src')); // serve main.js

let players = {};
let coins = [];

// Walls for collision
const walls = [
    { x: 100, y: 100, width: 600, height: 20 },
    { x: 100, y: 480, width: 600, height: 20 },
    { x: 250, y: 200, width: 300, height: 20 },
    { x: 250, y: 360, width: 300, height: 20 },
    { x: 100, y: 120, width: 20, height: 120 }, // left top
    { x: 100, y: 320, width: 20, height: 160 }, // left bottom
    { x: 680, y: 120, width: 20, height: 360 }  // right vertical
];

function getRandomColor() {
    const colors = ['lime', 'red', 'blue', 'yellow', 'cyan', 'orange', 'purple', 'pink'];
    return colors[Math.floor(Math.random() * colors.length)];
}

function isInsideWall(x, y, size) {
    for (let w of walls) {
        if (x + size > w.x && x - size < w.x + w.width &&
            y + size > w.y && y - size < w.y + w.height) return true;
    }
    return false;
}

function spawnCoin() {
    let x, y;
    do {
        x = Math.random() * 760 + 20;
        y = Math.random() * 560 + 20;
    } while (isInsideWall(x, y, 10));

    const type = Math.random() < 0.5 ? 'milk' : 'fish';
    coins.push({ x, y, size: 10, type });
}

// Spawn initial coins
for (let i = 0; i < 5; i++) spawnCoin();

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('setName', (name) => {
        players[socket.id] = {
            x: 400,
            y: 300,
            size: 20,
            color: getRandomColor(),
            name: name || 'Player',
            score: 0
        };
        socket.emit('state', { players, coins });
    });

    socket.on('move', (playerData) => {
        if (!players[socket.id]) return;

        players[socket.id] = { 
            ...playerData, 
            color: players[socket.id].color, 
            name: players[socket.id].name, 
            score: players[socket.id].score 
        };

        coins.forEach((coin, index) => {
            const dx = players[socket.id].x - coin.x;
            const dy = players[socket.id].y - coin.y;
            const distance = Math.sqrt(dx*dx + dy*dy);
            if (distance < players[socket.id].size + coin.size) {
                players[socket.id].score += 1;
                coins.splice(index,1);
                spawnCoin();
            }
        });

        io.emit('state', { players, coins });
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('state', { players, coins });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
