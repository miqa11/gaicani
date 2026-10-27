(function () {
  "use strict";

  const TITLES = { pacman:"PAC-MAN", snake:"SNAKE", tetris:"TETRIS", pong:"PONG" };
  const PIECES = [
    { cells:[[0,0],[1,0],[-1,0],[-2,0]], color:"#54ddff" },
    { cells:[[0,0],[1,0],[0,1],[1,1]], color:"#ffe06b" },
    { cells:[[0,0],[-1,0],[1,0],[0,1]], color:"#c17cff" },
    { cells:[[0,0],[1,0],[0,1],[-1,1]], color:"#70f59c" },
    { cells:[[0,0],[-1,0],[0,1],[1,1]], color:"#ff658c" },
    { cells:[[0,0],[-1,0],[1,0],[-1,1]], color:"#5888ff" },
    { cells:[[0,0],[-1,0],[1,0],[1,1]], color:"#ff9e55" }
  ];

  function mount(game, root, options) {
    options = options || {};
    if (!root || !TITLES[game]) return null;
    root.replaceChildren();
    root.classList.add("arcade-run");
    const hud = document.createElement("div");
    hud.className = "arcade-run-hud";
    const scoreLabel = document.createElement("b");
    const timeLabel = document.createElement("span");
    hud.append(scoreLabel, timeLabel);
    const canvas = document.createElement("canvas");
    canvas.className = "arcade-run-canvas";
    canvas.width = 560;
    canvas.height = 360;
    canvas.setAttribute("aria-label", TITLES[game] + " arcade game");
    const controls = document.createElement("div");
    controls.className = "arcade-run-controls";
    root.append(hud, canvas, controls);
    const ctx = canvas.getContext("2d");
    const held = Object.create(null);
    let ended = false, destroyed = false, raf = 0, lastAt = performance.now();
    const deadline = Number(options.deadlineAt) || Date.now() + Math.max(10000, Number(options.durationMs) || 60000);
    let score = 0;
    const state = game === "snake" ? createSnake() : game === "pacman" ? createPacman() : game === "tetris" ? createTetris() : createPong();

    function finish() {
      if (ended || destroyed) return;
      ended = true;
      options.onFinish?.(Math.max(0, Math.floor(score)));
    }
    function setDirection(dir) {
      if (game === "pacman") state.wanted = dir;
      else if (game === "snake") {
        const opposite = state.dir.x + dir.x === 0 && state.dir.y + dir.y === 0;
        if (!opposite) state.wanted = dir;
      } else if (game === "pong" && dir.y) state.input = dir.y;
      else if (game === "tetris" && dir.x) state.input = dir.x;
      else if (game === "tetris" && dir.y > 0) state.softDrop = true;
    }
    function keyDown(event) {
      const tag = event.target && event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || ended) return;
      const key = event.key.toLowerCase();
      const dirs = {
        ArrowLeft:{x:-1,y:0}, a:{x:-1,y:0}, ArrowRight:{x:1,y:0}, d:{x:1,y:0},
        ArrowUp:{x:0,y:-1}, w:{x:0,y:-1}, ArrowDown:{x:0,y:1}, s:{x:0,y:1}
      };
      if (dirs[event.key] || dirs[key]) {
        event.preventDefault();
        const dir = dirs[event.key] || dirs[key];
        if (game === "tetris" || game === "pong") held[dir.x ? (dir.x < 0 ? "left" : "right") : (dir.y < 0 ? "up" : "down")] = true;
        setDirection(dir);
      }
      if (game === "tetris" && (key === " " || event.code === "Space")) { event.preventDefault(); hardDrop(); }
      if (game === "tetris" && key === "arrowup") rotatePiece();
    }
    function keyUp(event) {
      const key = event.key.toLowerCase();
      const map = { ArrowLeft:"left",a:"left",ArrowRight:"right",d:"right",ArrowUp:"up",w:"up",ArrowDown:"down",s:"down" };
      const dir = map[event.key] || map[key];
      if (dir) { held[dir] = false; if (game === "pong" || game === "tetris") state.input = 0; }
      if (game === "tetris" && (event.key === "ArrowDown" || key === "s")) state.softDrop = false;
    }
    window.addEventListener("keydown", keyDown, { passive:false });
    window.addEventListener("keyup", keyUp);

    function control(label, dir, action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("pointerdown", event => {
        event.preventDefault();
        button.setPointerCapture?.(event.pointerId);
        if (dir) { const name = dir.x ? (dir.x < 0 ? "left" : "right") : (dir.y < 0 ? "up" : "down"); held[name] = true; setDirection(dir); }
        if (action) action();
      });
      const release = () => { if (dir) { const name = dir.x ? (dir.x < 0 ? "left" : "right") : (dir.y < 0 ? "up" : "down"); held[name] = false; if (game === "tetris" || game === "pong") state.input = 0; if (game === "tetris" && dir.y > 0) state.softDrop = false; } };
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
      button.addEventListener("lostpointercapture", release);
      controls.appendChild(button);
    }
    if (game === "pong") {
      control("↑",{x:0,y:-1});
      control("↓",{x:0,y:1});
    } else {
      control("←",{x:-1,y:0});
      control("↑",{x:0,y:-1});
      if (game === "tetris") control("↻",null,rotatePiece);
      control("↓",{x:0,y:1});
      if (game === "tetris") control("DROP",null,hardDrop);
      control("→",{x:1,y:0});
    }

    canvas.addEventListener("pointerdown", event => {
      if (game !== "pong" || ended) return;
      const rect = canvas.getBoundingClientRect();
      state.playerY = Math.max(38,Math.min(canvas.height-38,(event.clientY-rect.top)*canvas.height/rect.height));
    });

    function setScore(value) { score = value; scoreLabel.textContent = "SCORE  " + score; }
    function drawBase(title) {
      ctx.fillStyle="#070b18";ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.strokeStyle="#2c3655";ctx.lineWidth=2;ctx.strokeRect(8,8,canvas.width-16,canvas.height-16);
      ctx.fillStyle="#a6f4ff";ctx.font="bold 15px monospace";ctx.textAlign="left";ctx.fillText(title,22,28);
    }
    function updatePacman(now) {
      const s=state;
      if(now-s.lastStep<128)return;s.lastStep=now;
      const tries=[s.wanted,s.dir];
      for(const d of tries){const nx=s.player.x+d.x,ny=s.player.y+d.y;if(nx>=0&&nx<19&&ny>=0&&ny<13&&!s.walls[ny][nx]){s.player={x:nx,y:ny};s.dir=d;break}}
      const key=s.player.y+":"+s.player.x;
      if(s.dots.delete(key)){setScore(score+10);if(!s.dots.size){finish();return}}
      if(now-s.lastGhost>510){s.lastGhost=now;s.ghosts.forEach(g=>{const options=[{x:0,y:-1},{x:1,y:0},{x:0,y:1},{x:-1,y:0}].filter(d=>g.x+d.x>=0&&g.x+d.x<19&&g.y+d.y>=0&&g.y+d.y<13&&!s.walls[g.y+d.y][g.x+d.x]);if(options.length){options.sort((a,b)=>Math.hypot(g.x+a.x-s.player.x,g.y+a.y-s.player.y)-Math.hypot(g.x+b.x-s.player.x,g.y+b.y-s.player.y));g.dir=Math.random()<.72?options[0]:options[Math.floor(Math.random()*options.length)];g.x+=g.dir.x;g.y+=g.dir.y}})}
      for(const ghost of s.ghosts)if(ghost.x===s.player.x&&ghost.y===s.player.y){s.lives--;s.player={x:1,y:1};s.ghosts.forEach((g,i)=>Object.assign(g,{x:17-i,y:11}));if(s.lives<=0)finish();break}
    }
    function drawPacman() {
      const s=state,cell=24,ox=(canvas.width-19*cell)/2,oy=39;
      drawBase("PAC-MAN · ARCADE");
      for(let y=0;y<13;y++)for(let x=0;x<19;x++){const px=ox+x*cell,py=oy+y*cell;if(s.walls[y][x]){ctx.fillStyle="#171f58";ctx.fillRect(px,py,cell,cell);ctx.strokeStyle="#374dc3";ctx.strokeRect(px+2,py+2,cell-4,cell-4)}else if(s.dots.has(y+":"+x)){ctx.fillStyle="#ffdb92";ctx.beginPath();ctx.arc(px+12,py+12,2.2,0,Math.PI*2);ctx.fill()}}
      ctx.fillStyle="#ffe154";ctx.beginPath();ctx.arc(ox+s.player.x*cell+12,oy+s.player.y*cell+12,9,.25,Math.PI*1.75);ctx.lineTo(ox+s.player.x*cell+12,oy+s.player.y*cell+12);ctx.fill();
      s.ghosts.forEach((g,i)=>{ctx.fillStyle=["#ff5b83","#5ceaff","#f49bff"][i%3];ctx.beginPath();ctx.arc(ox+g.x*cell+12,oy+g.y*cell+12,9,Math.PI,0);ctx.lineTo(ox+g.x*cell+21,oy+g.y*cell+22);ctx.lineTo(ox+g.x*cell+16,oy+g.y*cell+18);ctx.lineTo(ox+g.x*cell+12,oy+g.y*cell+22);ctx.lineTo(ox+g.x*cell+7,oy+g.y*cell+18);ctx.lineTo(ox+g.x*cell+3,oy+g.y*cell+22);ctx.closePath();ctx.fill();ctx.fillStyle="#fff";ctx.fillRect(ox+g.x*cell+7,oy+g.y*cell+10,4,4);ctx.fillRect(ox+g.x*cell+14,oy+g.y*cell+10,4,4)});
      ctx.fillStyle="#ffc3e9";ctx.font="bold 13px monospace";ctx.textAlign="right";ctx.fillText("♥ ".repeat(Math.max(0,s.lives)),canvas.width-20,27);
    }
    function createPacman() {
      const w=19,h=13,walls=Array.from({length:h},(_,y)=>Array.from({length:w},(_,x)=>x===0||y===0||x===w-1||y===h-1));
      for(let y=2;y<h-1;y+=2)for(let x=2;x<w-2;x++){if((x+y)%5!==0&&!(y===6&&x>=8&&x<=10))walls[y][x]=true}
      const dots=new Set();for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++)if(!walls[y][x]&&!(x===1&&y===1)&&!((x===17||x===16)&&y===11))dots.add(y+":"+x);
      return {walls,dots,player:{x:1,y:1},dir:{x:1,y:0},wanted:{x:1,y:0},ghosts:[{x:17,y:11},{x:16,y:11}],lives:3,lastStep:0,lastGhost:0};
    }
    function createSnake() {
      const s={cols:20,rows:14,dir:{x:1,y:0},wanted:{x:1,y:0},snake:[{x:6,y:7},{x:5,y:7},{x:4,y:7}],lastStep:0,food:null};
      placeFood(s);return s;
    }
    function placeFood(s) {
      let p;do{p={x:Math.floor(Math.random()*s.cols),y:Math.floor(Math.random()*s.rows)}}while(s.snake.some(q=>q.x===p.x&&q.y===p.y));
      s.food=p;
    }
    function updateSnake(now) {
      const s=state;if(now-s.lastStep<116)return;s.lastStep=now;
      if(!(s.dir.x+s.wanted.x===0&&s.dir.y+s.wanted.y===0))s.dir=s.wanted;
      const head={x:s.snake[0].x+s.dir.x,y:s.snake[0].y+s.dir.y};
      if(head.x<0||head.x>=s.cols||head.y<0||head.y>=s.rows||s.snake.some(p=>p.x===head.x&&p.y===head.y)){finish();return}
      s.snake.unshift(head);
      if(head.x===s.food.x&&head.y===s.food.y){setScore(score+10);placeFood(s)}else s.snake.pop();
    }
    function drawSnake() {
      const s=state,cell=21,ox=(canvas.width-s.cols*cell)/2,oy=48;drawBase("SNAKE · PIXEL FEAST");
      ctx.strokeStyle="#24374a";for(let x=0;x<=s.cols;x++){ctx.beginPath();ctx.moveTo(ox+x*cell,oy);ctx.lineTo(ox+x*cell,oy+s.rows*cell);ctx.stroke()}for(let y=0;y<=s.rows;y++){ctx.beginPath();ctx.moveTo(ox,oy+y*cell);ctx.lineTo(ox+s.cols*cell,oy+y*cell);ctx.stroke()}
      s.snake.forEach((p,i)=>{ctx.fillStyle=i?"#35d987":"#9aff9e";ctx.fillRect(ox+p.x*cell+2,oy+p.y*cell+2,cell-4,cell-4)});
      ctx.fillStyle="#ff6d9b";ctx.fillRect(ox+s.food.x*cell+4,oy+s.food.y*cell+4,cell-8,cell-8);
    }
    function createTetris() {
      return {board:Array.from({length:20},()=>Array(10).fill(null)),piece:null,lastDrop:0,input:0,inputAt:0,softDrop:false,lines:0,level:1};
    }
    function newPiece(s) {
      const template=PIECES[Math.floor(Math.random()*PIECES.length)];
      s.piece={cells:template.cells.map(p=>p.slice()),color:template.color,x:4,y:0};
      if(!validPiece(s,s.piece,s.piece.x,s.piece.y))finish();
    }
    function validPiece(s,p,x,y,cells) {
      return (cells||p.cells).every(([cx,cy])=>{const px=x+cx,py=y+cy;return px>=0&&px<10&&py<20&&py>=0&&!s.board[py][px]});
    }
    function rotatePiece() {
      if(game!=="tetris"||ended)return;
      const p=state.piece,cells=p.cells.map(([x,y])=>[-y,x]);
      if(validPiece(state,p,p.x,p.y,cells))p.cells=cells;
    }
    function lockPiece(s) {
      s.piece.cells.forEach(([x,y])=>{const px=s.piece.x+x,py=s.piece.y+y;if(py>=0&&py<20)s.board[py][px]=s.piece.color});
      const filled=s.board.filter(row=>row.every(Boolean)).length;
      if(filled){s.board=s.board.filter(row=>!row.every(Boolean));while(s.board.length<20)s.board.unshift(Array(10).fill(null));s.lines+=filled;s.level=1+Math.floor(s.lines/5);setScore(score+[0,100,300,500,800][Math.min(4,filled)]*s.level)}
      newPiece(s);
    }
    function hardDrop() {
      if(game!=="tetris"||ended)return;
      const s=state;while(validPiece(s,s.piece,s.piece.x,s.piece.y+1))s.piece.y++;lockPiece(s);
    }
    function updateTetris(now,dt) {
      const s=state,p=s.piece;
      if(s.input&&now-s.inputAt>100){if(validPiece(s,p,p.x+s.input,p.y)){p.x+=s.input;s.inputAt=now}}
      if(s.softDrop&&validPiece(s,p,p.x,p.y+1)){p.y++;s.lastDrop=now}
      const speed=Math.max(90,540-(s.level-1)*38);
      if(now-s.lastDrop>speed){s.lastDrop=now;if(validPiece(s,p,p.x,p.y+1))p.y++;else lockPiece(s)}
    }
    function drawTetris() {
      const s=state,cell=15,ox=(canvas.width-10*cell)/2,oy=35;drawBase("TETRIS · LINE CLEAR");
      for(let y=0;y<20;y++)for(let x=0;x<10;x++){ctx.fillStyle=s.board[y][x]||"#10182a";ctx.fillRect(ox+x*cell+1,oy+y*cell+1,cell-2,cell-2);if(s.board[y][x]){ctx.fillStyle="#ffffff55";ctx.fillRect(ox+x*cell+2,oy+y*cell+2,cell-4,2)}}
      if(s.piece)s.piece.cells.forEach(([x,y])=>{const px=s.piece.x+x,py=s.piece.y+y;if(py>=0){ctx.fillStyle=s.piece.color;ctx.fillRect(ox+px*cell+1,oy+py*cell+1,cell-2,cell-2)}});
      ctx.fillStyle="#bdc7e4";ctx.font="bold 13px monospace";ctx.textAlign="left";ctx.fillText("LINES "+s.lines,canvas.width-118,58);ctx.fillText("LEVEL "+s.level,canvas.width-118,78);
    }
    function createPong() {
      return {ball:{x:280,y:180,vx:190,vy:140},playerY:180,cpuY:180,input:0,hits:0,playerScore:0,cpuScore:0};
    }
    function updatePong(dt) {
      const s=state;
      if(s.input)s.playerY+=s.input*265*dt;
      s.playerY=Math.max(38,Math.min(canvas.height-38,s.playerY));
      const b=s.ball;b.x+=b.vx*dt;b.y+=b.vy*dt;
      if(b.y<27||b.y>canvas.height-24)b.vy*=-1;
      s.cpuY+=(b.y-s.cpuY)*Math.min(1,dt*4.8);
      if(b.x<43&&Math.abs(b.y-s.playerY)<42){b.x=44;b.vx=Math.abs(b.vx)*1.035;b.vy+=(b.y-s.playerY)*1.5;s.hits++;setScore(s.hits*5)}
      if(b.x>canvas.width-43&&Math.abs(b.y-s.cpuY)<42){b.x=canvas.width-44;b.vx=-Math.abs(b.vx)*1.025;b.vy+=(b.y-s.cpuY)*1.15}
      if(b.x<12){s.cpuScore++;resetBall(s,1);if(s.cpuScore>=5)finish()}
      if(b.x>canvas.width-12){s.playerScore++;setScore(score+50);resetBall(s,-1);if(s.playerScore>=5)finish()}
    }
    function resetBall(s,direction) {s.ball={x:canvas.width/2,y:canvas.height/2,vx:direction*190,vy:(Math.random()-.5)*210}}
    function drawPong() {
      const s=state;drawBase("PONG · NEON COURT");
      ctx.setLineDash([8,8]);ctx.strokeStyle="#56728c";ctx.beginPath();ctx.moveTo(canvas.width/2,38);ctx.lineTo(canvas.width/2,canvas.height-18);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle="#ff68d5";ctx.shadowColor="#ff68d5";ctx.shadowBlur=12;ctx.fillRect(29,s.playerY-33,9,66);
      ctx.fillStyle="#63eaff";ctx.shadowColor="#63eaff";ctx.fillRect(canvas.width-38,s.cpuY-33,9,66);ctx.shadowBlur=0;
      ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(s.ball.x,s.ball.y,7,0,Math.PI*2);ctx.fill();
      ctx.font="bold 25px monospace";ctx.textAlign="center";ctx.fillStyle="#ffc8f2";ctx.fillText(String(s.playerScore),canvas.width*.35,54);ctx.fillStyle="#b9f8ff";ctx.fillText(String(s.cpuScore),canvas.width*.65,54);
      ctx.font="11px monospace";ctx.fillStyle="#9aa6c9";ctx.fillText("PADDLE HITS  "+s.hits,canvas.width/2,canvas.height-13);
    }
    function drawGame() {
      if(game==="pacman")drawPacman();else if(game==="snake")drawSnake();else if(game==="tetris")drawTetris();else drawPong();
    }
    function frame(now) {
      if(destroyed)return;
      const nowMs=Date.now(),seconds=Math.max(0,Math.ceil((deadline-nowMs)/1000));
      timeLabel.textContent=ended?"RUN OVER":"00:"+String(seconds).padStart(2,"0");
      if(!ended&&nowMs>=deadline)finish();
      const dt=Math.min(.04,Math.max(0,(now-lastAt)/1000));lastAt=now;
      if(!ended){
        if(game==="pacman")updatePacman(now);
        else if(game==="snake")updateSnake(now);
        else if(game==="tetris")updateTetris(now,dt);
        else updatePong(dt);
      }
      drawGame();
      if(ended){ctx.fillStyle="#060915bb";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle="#fff";ctx.textAlign="center";ctx.font="bold 24px monospace";ctx.fillText("GAME OVER",canvas.width/2,canvas.height/2);ctx.font="14px monospace";ctx.fillStyle="#9df6ff";ctx.fillText("FINAL SCORE  "+score,canvas.width/2,canvas.height/2+28)}
      else raf=requestAnimationFrame(frame);
    }
    if(game==="tetris")newPiece(state);
    if(game==="pong")state.playerY=canvas.height/2;
    scoreLabel.textContent="SCORE  0";
    raf=requestAnimationFrame(frame);
    return {destroy(){destroyed=true;cancelAnimationFrame(raf);window.removeEventListener("keydown",keyDown);window.removeEventListener("keyup",keyUp)},getScore(){return score}};
  }

  window.GaicaniArcadeGames={mount,titles:TITLES};
})();
