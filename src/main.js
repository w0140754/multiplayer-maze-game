const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = 800;
canvas.height = 600;

const socket = io({
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

let playerName = prompt("Enter your name:", "Player") || "Player";
let player = { x: 400, y: 300, size: 20 };
let players = {};
let coins = [];

socket.emit('setName', playerName);

// Draw functions
function drawPlayer(p) {
    ctx.fillStyle = p.color || 'lime';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'white';
    ctx.font = '16px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, p.x, p.y - p.size - 5);
}

function drawCoin(c) {
    ctx.fillStyle = c.type === 'fish' ? 'blue' : 'white';
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.size, 0, Math.PI * 2);
    ctx.fill();
}

function drawWalls() {
    const walls = [
        { x: 100, y: 100, width: 600, height: 20 },
        { x: 100, y: 480, width: 600, height: 20 },
        { x: 250, y: 200, width: 300, height: 20 },
        { x: 250, y: 360, width: 300, height: 20 }
    ];
    ctx.fillStyle = 'gray';
    walls.forEach(w => ctx.fillRect(w.x, w.y, w.width, w.height));
}

function drawLeaderboard() {
    const sorted = Object.values(players).sort((a, b) => b.score - a.score);
    ctx.fillStyle = 'white';
    ctx.font = '16px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('Leaderboard:', 10, 20);
    sorted.forEach((p, i) => {
        ctx.fillText(`${i + 1}. ${p.name}: ${p.score}`, 10, 40 + i * 20);
    });
}

// Game loop
function gameLoop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawWalls();
    coins.forEach(drawCoin);
    for (let id in players) {
        drawPlayer(players[id]);
    }
    drawLeaderboard();

    requestAnimationFrame(gameLoop);
}
gameLoop();

// Player movement
document.addEventListener('keydown', (e) => {
    let newX = player.x;
    let newY = player.y;

    switch(e.key) {
        case 'ArrowUp': newY -= 10; break;
        case 'ArrowDown': newY += 10; break;
        case 'ArrowLeft': newX -= 10; break;
        case 'ArrowRight': newX += 10; break;
    }

    player.x = newX;
    player.y = newY;
});

// Throttle updates to server
setInterval(() => {
    socket.emit('move', player);
}, 50); // 20 updates/sec

// Update state from server
socket.on('state', (data) => {
    players = data.players;
    coins = data.coins;
});
