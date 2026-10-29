/* Small canvas-native activity props. They do not add invisible collision walls. */
(function (root) {
  'use strict';
  const palette = { fishing: '#79e3e4', bugs: '#ceff7b', treasure: '#ffd78b', photography: '#ff94dc', parkour: '#b9a2ff', delivery:'#ffc28c', market:'#a5ecb9', repair:'#a4caee', bar:'#efa2d4',taxi:'#ffe380' };
  function ring(g, x, y, color, radius = 23) {
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); g.ellipse(x, y, radius, radius * .45, 0, 0, Math.PI * 2); g.stroke();
  }
  function badge(g, x, y, symbol, color) {
    g.fillStyle = '#101525dc'; g.fillRect(x - 12, y - 8, 24, 17);
    g.strokeStyle = color; g.lineWidth = 1; g.strokeRect(x - 12, y - 8, 24, 17);
    g.fillStyle = color; g.font = 'bold 11px monospace'; g.textAlign = 'center'; g.fillText(symbol, x, y + 4);
  }
  function draw(g, time, { self, players = [], state, world }) {
    if (!self || self.interiorId || !state) return;
    const visible = p => Math.abs(p.x - self.x) < 1200 && Math.abs(p.y - self.y) < 950;
    const catalog = root.GaicaniCityActivitiesData?.activities || [];
    const active = state.active?.status === 'active' ? state.active : null;
    const at = Date.now();
    g.save();
    for (const def of catalog) {
      if (!state.capabilities?.includes(def.id) || !palette[def.id] || !visible(def.location)) continue;
      const { x, y } = def.location;
      badge(g, x, y + 24, { fishing: '><', bugs: '*', treasure: '?', photography: '[o]', parkour: '^',delivery:'BOX',market:'SHOP',repair:'FIX',bar:'SODA',taxi:'TAXI' }[def.id], palette[def.id]);
      if (def.id === 'fishing') {
        // A narrow tackle mat stays on the bank; the float is in the river.
        g.fillStyle = '#40524d'; g.fillRect(x - 13, y - 5, 26, 10);
        g.fillStyle = '#c6ab74'; g.fillRect(x - 10, y - 3, 12, 3);
        ring(g, 2532, y + 3 + Math.sin(time / 500) * 2, '#62c5d64c', 17);
      }
      if (def.id === 'bugs') for (let i = 0; i < 5; i++) {
        const bx = x + Math.sin(time / 1300 + i * 2) * (18 + i * 4), by = y - 20 + Math.cos(time / 900 + i) * 12;
        g.globalAlpha = .4 + .5 * Math.abs(Math.sin(time / 550 + i)); g.fillStyle = '#d3ff84'; g.fillRect(bx, by, 3, 3);
        g.fillStyle = '#9bcc7890'; g.fillRect(bx - 2, by + 1, 7, 1);
      }
      g.globalAlpha = 1;
    }
    for(const citizen of root.GaicaniCityActivitiesData?.npcs||[]){if(!visible(citizen))continue;const {x,y}=citizen;g.fillStyle='#090d2080';g.fillRect(x-10,y+12,20,4);g.fillStyle=citizen.color;g.fillRect(x-7,y-21,14,14);g.fillStyle='#4a6588';g.fillRect(x-8,y-6,16,15);g.fillStyle='#e6c259';g.fillRect(x-11,y-5,3,10);g.fillRect(x+8,y-5,3,10);g.fillStyle='#262237';g.fillRect(x-4,y-16,2,2);g.fillRect(x+3,y-16,2,2);g.fillRect(x-6,y+9,4,7);g.fillRect(x+2,y+9,4,7);g.fillStyle='#ffeb99';g.font='9px monospace';g.textAlign='center';g.fillText(citizen.name,x,y-28);}
    if (active?.id === 'parkour') (active.checkpoints || []).forEach((point, i) => {
      if (!visible(point)) return;
      ring(g, point.x, point.y, i < active.step ? '#80cda166' : i === active.step ? '#efddff' : '#9a80ce88', 28);
      g.fillStyle = i < active.step ? '#80cda1' : '#d6bcff'; g.font = 'bold 11px monospace'; g.textAlign = 'center'; g.fillText(String(i + 1), point.x, point.y + 4);
      if (i === active.step) { g.globalAlpha = .35; g.strokeRect(point.x - 28, point.y - 32, 56, 32); g.globalAlpha = 1; }
    });
    if (active?.id === 'treasure' && active.target && visible(active.target)) {
      const p = active.target; g.fillStyle = '#684735'; g.fillRect(p.x - 10, p.y - 12, 20, 13);
      g.fillStyle = '#cbaa67'; g.fillRect(p.x - 10, p.y - 13, 20, 3); g.fillRect(p.x - 2, p.y - 8, 4, 5);
    }
    for (const p of [self, ...players]) {
      const animation = p.activityAnimation;
      if (!animation || animation.until < at || p.interiorId || p.vehicleId || !visible(p)) continue;
      const x = p.x, y = p.y;
      if (animation.kind === 'fishing' || animation.kind === 'reel') {
        const bob = Math.sin(time / 350) * 1.5;
        g.strokeStyle = '#cda87c'; g.lineWidth = 2; g.beginPath(); g.moveTo(x + 6, y - 6); g.lineTo(x + 23, y - 40); g.stroke();
        g.strokeStyle = '#c5e6df99'; g.lineWidth = 1; g.beginPath(); g.moveTo(x + 23, y - 40); g.quadraticCurveTo(x + 48, y - 38, 2531, y + bob); g.stroke();
        g.fillStyle = '#ffb56f'; g.fillRect(2528, y - 4 + bob, 6, 5); ring(g, 2531, y + bob, '#b6f9ee99', 9 + Math.sin(time / 300) * 2);
      } else if (animation.kind === 'bugs' || animation.kind === 'net') {
        const swing = Math.sin(time / 220) * 9;
        g.strokeStyle = '#c9aa8e'; g.lineWidth = 2; g.beginPath(); g.moveTo(x + 6, y - 5); g.lineTo(x + 24 + swing, y - 30); g.stroke();
        g.strokeStyle = '#ddffe2'; g.beginPath(); g.ellipse(x + 28 + swing, y - 36, 10, 13, .4, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#caffd826'; g.fill();
      } else if (animation.kind === 'camera') {
        g.fillStyle = '#43374e'; g.fillRect(x - 9, y - 24, 18, 10); g.fillStyle = '#88eff7'; g.fillRect(x - 3, y - 22, 6, 6);
        g.globalAlpha = Math.max(0, Math.min(.7, (animation.until - at) / 800)); g.fillStyle = '#fff2d5'; g.beginPath(); g.arc(x + 7, y - 24, 16, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
      } else if (animation.kind === 'dig') {
        g.strokeStyle = '#d4b18b'; g.lineWidth = 3; g.beginPath(); g.moveTo(x + 6, y - 5); g.lineTo(x + 18, y + 7); g.stroke();
        g.fillStyle = '#8c97a8'; g.fillRect(x + 15, y + 4, 8, 9);
      } else if (animation.kind === 'checkpoint') ring(g, x, y, '#e0c1ff', 30 + Math.sin(time / 80) * 4);
      else if(animation.kind==='parcel'){g.fillStyle='#bd8956';g.fillRect(x-11,y-7,22,15);g.fillStyle='#f8db92';g.fillRect(x-2,y-7,4,15);}
      else if(animation.kind==='pour'||animation.kind==='serve'){g.fillStyle='#ebd7a7';g.fillRect(x+10,y-6,9,13);g.fillStyle='#ea8fae';g.fillRect(x+11,y,7,6);g.fillStyle='#8be5f4';g.fillRect(x+12,y-17,2,11);}
      else if(animation.kind==='repair'){g.strokeStyle='#c1deed';g.lineWidth=3;g.beginPath();g.moveTo(x+7,y-3);g.lineTo(x+19+Math.sin(time/100)*3,y-16);g.stroke();g.strokeRect(x+15+Math.sin(time/100)*3,y-21,7,6);}
    }
    g.restore();
  }
  root.GaicaniCityActivitiesWorld = { draw };
})(window);
