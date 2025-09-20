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

// Load images
const catImg = new Image();
catImg.src = '/images/cat.png';
const milkImg = new Image();
milkImg.src = '/images/milk.png';
const fishImg = new Image();
fishImg.src = '/images/fish.png';
const grassImg = new Image();
grassImg.src = '/images/grass.png';
const rockImg = new Image();
rockImg.src = '/images/rock.png';

// Send player name to server
socket.emit('setName', playerName);

// Draw functions
function drawBackground() {
    ctx.drawImage(grassImg, 0, 0, canvas.width, canvas.height);
}

function drawPlayer(p) {
    ctx.drawImage(catImg, p.x - p.size, p.y - p.size, p.size*2, p.size*2);
    ctx.fillStyle = 'white';
    ctx.font = '16px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, p.x, p.y - p.size - 5);
}

function drawCoin(c) {
    const img = c.type === 'fish' ? fishImg : milkImg;
    ctx.drawImage(img, c.x - c.size, c.y - c.size, c.size*2, c.size*2);
}

function drawWalls() {
    const walls = [
        { x: 100, y: 100, width: 600, height: 20 },
        { x: 100, y: 480, width: 600, height: 20 },
        { x: 250, y: 200, width: 300, height: 20 },
        { x: 250, y: 360, width: 300, height: 20 }
    ];
    walls.forEach(w => {
        ctx.drawImage(rockImg, w.x, w.y, w.width, w.height);
    });
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
    drawBackground();
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
