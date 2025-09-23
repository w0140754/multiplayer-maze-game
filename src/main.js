const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = 800;
canvas.height = 600;

const socket = io();

let player = { x: 400, y: 300, size: 20, name: null };
let players = {};
let coins = [];

// ------------------- LOGIN -------------------
function promptLogin() {
    const name = prompt("Enter your player name:", "Player");
    if (!name) return;

    const password = prompt("Enter your password:");
    if (!password) return;

    socket.emit('setName', { name, password });
}

// Handle wrong password
socket.on('loginFailed', (msg) => {
    alert(msg);
    promptLogin(); // retry login
});

// On successful login, store player name and game state
socket.on('state', (data) => {
    // Only set player.name once
    if (!player.name) {
        player.name = data.players[socket.id]?.name || 'Player';
    }
    players = data.players;
    coins = data.coins;
});

// Start login flow
promptLogin();

// ------------------- Pre-rendered Background -------------------
const bgCanvas = document.createElement('canvas');
bgCanvas.width = canvas.width;
bgCanvas.height = canvas.height;
const bgCtx = bgCanvas.getContext('2d');

bgCtx.fillStyle = '#2b7a0b';
bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
for (let i = 0; i < bgCanvas.width; i += 5) {
    for (let j = 0; j < bgCanvas.height; j += 5) {
        bgCtx.fillStyle = ['#2b7a0b','#36a02d','#1f5d07'][Math.floor(Math.random()*3)];
        bgCtx.fillRect(i, j, 4, 4);
    }
}

// ------------------- Pre-rendered Walls -------------------
const wallsCanvas = document.createElement('canvas');
wallsCanvas.width = canvas.width;
wallsCanvas.height = canvas.height;
const wallsCtx = wallsCanvas.getContext('2d');

function getWalls() {
    const gapY = 240;
    const gapSize = 80;

    return [
        { x: 100, y: 100, width: 600, height: 20 },
        { x: 100, y: 480, width: 600, height: 20 },
        { x: 250, y: 200, width: 300, height: 20 },
        { x: 250, y: 360, width: 300, height: 20 },
        { x: 100, y: 120, width: 20, height: gapY - 120 },
        { x: 100, y: gapY + gapSize, width: 20, height: 480 - (gapY + gapSize) },
        { x: 680, y: 120, width: 20, height: 360 }
    ];
}

function drawStaticWalls() {
    const walls = getWalls();
    walls.forEach(w => {
        wallsCtx.fillStyle = '#555';
        wallsCtx.fillRect(w.x, w.y, w.width, w.height);
        for (let i = 0; i < w.width; i += 5) {
            for (let j = 0; j < w.height; j += 5) {
                wallsCtx.fillStyle = ['#555','#666','#777','#444'][Math.floor(Math.random()*4)];
                if (Math.random() < 0.5) wallsCtx.fillRect(w.x + i, w.y + j, 4, 4);
            }
        }
        wallsCtx.fillStyle = 'rgba(200,200,200,0.1)';
        wallsCtx.fillRect(w.x, w.y, w.width, 3);
        wallsCtx.fillRect(w.x, w.y, 3, w.height);
        wallsCtx.fillStyle = 'rgba(0,0,0,0.2)';
        wallsCtx.fillRect(w.x, w.y + w.height - 3, w.width, 3);
        wallsCtx.fillRect(w.x + w.width - 3, w.y, 3, w.height);
    });
}
drawStaticWalls();

// ------------------- Animated Grass -------------------
const grassCanvas = document.createElement('canvas');
grassCanvas.width = canvas.width;
grassCanvas.height = canvas.height;
const grassCtx = grassCanvas.getContext('2d');

const grassBlades = [];
for (let i = 0; i < 200; i++) {
    grassBlades.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        height: 4 + Math.random() * 6,
        sway: Math.random() * 0.5 + 0.5,
        phase: Math.random() * Math.PI * 2
    });
}

function drawAnimatedGrass() {
    grassCtx.clearRect(0, 0, canvas.width, canvas.height);
    grassCtx.strokeStyle = 'rgba(50, 180, 50, 0.5)';
    grassCtx.lineWidth = 1;
    const time = Date.now() * 0.002;
    grassBlades.forEach(b => {
        grassCtx.beginPath();
        const swayOffset = Math.sin(time * b.sway + b.phase) * 2;
        grassCtx.moveTo(b.x, b.y);
        grassCtx.lineTo(b.x + swayOffset, b.y - b.height);
        grassCtx.stroke();
    });
    ctx.drawImage(grassCanvas, 0, 0);
}

// ------------------- Player Drawing -------------------
function drawPlayer(p) {
    const x = p.x;
    const y = p.y;
    const size = p.size;
    ctx.fillStyle = p.color || 'orange';
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI*2);
    ctx.fill();

    // ears
    ctx.beginPath();
    ctx.moveTo(x - size * 0.6, y - size * 0.6);
    ctx.lineTo(x - size * 0.2, y - size * 1.2);
    ctx.lineTo(x, y - size * 0.6);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x + size * 0.6, y - size * 0.6);
    ctx.lineTo(x + size * 0.2, y - size * 1.2);
    ctx.lineTo(x, y - size * 0.6);
    ctx.closePath();
    ctx.fill();

    // eyes
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(x - size*0.3, y - size*0.2, size*0.15, 0, Math.PI*2);
    ctx.arc(x + size*0.3, y - size*0.2, size*0.15, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.arc(x - size*0.3, y - size*0.2, size*0.07, 0, Math.PI*2);
    ctx.arc(x + size*0.3, y - size*0.2, size*0.07, 0, Math.PI*2);
    ctx.fill();

    // whiskers
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - size*0.5, y);
    ctx.lineTo(x - size*0.9, y - 0.1*size);
    ctx.moveTo(x - size*0.5, y + 0.1*size);
    ctx.lineTo(x - size*0.9, y + 0.2*size);
    ctx.moveTo(x + size*0.5, y);
    ctx.lineTo(x + size*0.9, y - 0.1*size);
    ctx.moveTo(x + size*0.5, y + 0.1*size);
    ctx.lineTo(x + size*0.9, y + 0.2*size);
    ctx.stroke();

    // name
    ctx.fillStyle = 'white';
    ctx.font = '16px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, x, y - size - 5);
}

// ------------------- Coins -------------------
function drawCoin(c) {
    if (c.type === 'fish') drawFish(c);
    else drawMilk(c);
}

function drawFish(c) {
    const x = c.x, y = c.y, size = c.size;
    ctx.fillStyle = 'orange';
    ctx.beginPath();
    ctx.ellipse(x, y, size, size*0.5, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - size, y);
    ctx.lineTo(x - size - size*0.5, y - size*0.3);
    ctx.lineTo(x - size - size*0.5, y + size*0.3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.arc(x + size*0.3, y - size*0.1, size*0.1, 0, Math.PI*2);
    ctx.fill();
    drawCoinSparkle(c);
}

function drawMilk(c) {
    const x = c.x, y = c.y, size = c.size;
    ctx.fillStyle = 'white';
    ctx.fillRect(x - size*0.3, y - size*0.6, size*0.6, size);
    ctx.fillStyle = 'lightblue';
    ctx.fillRect(x - size*0.35, y - size*0.7, size*0.7, size*0.1);
    drawCoinSparkle(c);
}

function drawCoinSparkle(c) {
    const numSparkles = 3;
    for (let i=0; i<numSparkles; i++){
        const angle = (Date.now()*0.005 + i*2) % (Math.PI*2);
        const radius = c.size + 2 + i;
        const sx = c.x + Math.cos(angle)*radius;
        const sy = c.y + Math.sin(angle)*radius;
        ctx.fillStyle='white';
        ctx.fillRect(sx, sy, 2, 2);
    }
}

// ------------------- Collision -------------------
function isColliding(x, y, size){
    const walls = getWalls();
    for (let w of walls){
        if (x+size>w.x && x-size<w.x+w.width && y+size>w.y && y-size<w.y+w.height) return true;
    }
    return false;
}

function pushPlayerFromGap(player){
    const walls = getWalls();
    for (let w of walls){
        if (player.x+player.size>w.x && player.x-player.size<w.x+w.width &&
            player.y+player.size>w.y && player.y-player.size<w.y+w.height){
            const dxLeft = Math.abs(player.x - w.x);
            const dxRight = Math.abs(player.x - (w.x + w.width));
            const dyTop = Math.abs(player.y - w.y);
            const dyBottom = Math.abs(player.y - (w.y + w.height));
            const minDist = Math.min(dxLeft, dxRight, dyTop, dyBottom);
            if (minDist===dxLeft) player.x=w.x-player.size-1;
            else if(minDist===dxRight) player.x=w.x+w.width+player.size+1;
            else if(minDist===dyTop) player.y=w.y-player.size-1;
            else if(minDist===dyBottom) player.y=w.y+w.height+player.size+1;
        }
    }
}

// ------------------- Player Action -------------------
function performAction(){
    console.log(`${player.name} performed an action!`);
    player.size *= 1.2;
    if(players[socket.id]) players[socket.id].size = player.size;
    const originalColor = players[socket.id]?.color;
    if(players[socket.id]) players[socket.id].color='white';
    setTimeout(()=>{
        if(players[socket.id]) players[socket.id].color=originalColor;
    },200);
}

// ------------------- Game Loop -------------------
function gameLoop(){
    ctx.drawImage(bgCanvas,0,0);
    ctx.drawImage(wallsCanvas,0,0);
    drawAnimatedGrass();

    pushPlayerFromGap(player);
    socket.emit('move', player);

    coins.forEach(drawCoin);
    for(let id in players) drawPlayer(players[id]);
    drawLeaderboard();

    requestAnimationFrame(gameLoop);
}
gameLoop();

// ------------------- Player Movement -------------------
document.addEventListener('keydown',(e)=>{
    let newX = player.x;
    let newY = player.y;
    switch(e.key){
        case 'ArrowUp': newY-=10; break;
        case 'ArrowDown': newY+=10; break;
        case 'ArrowLeft': newX-=10; break;
        case 'ArrowRight': newX+=10; break;
        case ' ': performAction(); break;
    }
    if(!isColliding(newX,newY,player.size)){
        player.x=newX;
        player.y=newY;
    }
});

// ------------------- Leaderboard -------------------
function drawLeaderboard(){
    const sorted = Object.values(players).sort((a,b)=>b.score-a.score);
    ctx.fillStyle='white';
    ctx.font='16px Arial';
    ctx.textAlign='left';
    ctx.fillText('Leaderboard:',10,20);
    sorted.forEach((p,i)=>{
        ctx.fillText(`${i+1}. ${p.name}: ${p.score}`,10,40+i*20);
    });
}

// ------------------- Socket.io -------------------
socket.on('state',(data)=>{
    players=data.players;
    coins=data.coins;
});
