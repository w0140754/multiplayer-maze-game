const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.static('src')); // if main.js is in src

let players = {};
let coins = [];

// Spawn initial coins
function spawnCoin() {
    const type = Math.random() < 0.5 ? 'milk' : 'fish';
    coins.push({ x: Math.random() * 760 + 20, y: Math.random() * 560 + 20, size: 10, type });
}
for (let i = 0; i < 5; i++) spawnCoin();

function getRandomColor() {
    const colors = ['lime', 'red', 'blue', 'yellow', 'cyan', 'orange', 'purple', 'pink'];
    return colors[Math.floor(Math.random() * colors.length)];
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

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
        const playerObj = players[socket.id];

        // Update position
        playerObj.x = playerData.x;
        playerObj.y = playerData.y;

        // Check for coin collection
        coins = coins.filter(c => {
            const dx = playerObj.x - c.x;
            const dy = playerObj.y - c.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < playerObj.size + c.size) {
                playerObj.score += 1;
                spawnCoin();
                return false;
            }
            return true;
        });

        io.emit('state', { players, coins });
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('state', { players, coins });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
