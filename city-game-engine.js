"use strict";

const CITY_GAME_DEFINITIONS = {
  ttt: { name: "Tic-Tac-Toe", icon: "✕○", description: "Take turns on a neon 3×3 board." },
  math: { name: "Math Duel", icon: "∑", description: "Race through five quick arithmetic rounds." },
  rps: { name: "Rock · Paper · Scissors", icon: "✊", description: "Secret picks. First to two round wins." },
  quiz: { name: "Quiz Duel", icon: "A?", description: "Five questions from Tbilisi to general trivia." },
  pacman: { name: "Pac-Man", icon: "ᗧ", description: "Two players race for the highest maze score." },
  snake: { name: "Snake", icon: "🐍", description: "Same 60-second cabinet score challenge." },
  tetris: { name: "Tetris", icon: "🟦", description: "Clear lines and beat your rival's score." },
  pong: { name: "Pong", icon: "🏓", description: "Outscore the arcade opponent, then compare records." }
};
const CITY_ARCADE_GAMES = new Set(["pacman", "snake", "tetris", "pong"]);

const CITY_QUIZ_BANK = [
  { id:"general-1", category:"General", question:"Which planet is known as the Red Planet?", options:["Venus","Mars","Mercury","Jupiter"], answer:1 },
  { id:"general-2", category:"General", question:"Which is the largest ocean on Earth?", options:["Atlantic","Indian","Pacific","Arctic"], answer:2 },
  { id:"gaming-1", category:"Gaming", question:"What is Mario’s brother called?", options:["Wario","Luigi","Toad","Yoshi"], answer:1 },
  { id:"gaming-2", category:"Gaming", question:"Which game is famous for creepers?", options:["Minecraft","Tetris","Pac-Man","Sonic"], answer:0 },
  { id:"tech-1", category:"Technology", question:"What does CPU stand for?", options:["Central Processing Unit","Computer Power Utility","Core Program User","Central Pixel Unit"], answer:0 },
  { id:"tech-2", category:"Technology", question:"What does HTML mainly describe?", options:["Web page structure","Wi-Fi speed","Battery health","Photo color"], answer:0 },
  { id:"geo-1", category:"Geography", question:"What is the capital of Georgia?", options:["Batumi","Kutaisi","Tbilisi","Telavi"], answer:2 },
  { id:"geo-2", category:"Geography", question:"Which river flows through Tbilisi?", options:["Rioni","Mtkvari","Alazani","Enguri"], answer:1 },
  { id:"fun-1", category:"Funny riddle", question:"What gets wetter while it dries?", options:["A towel","A candle","A shadow","A clock"], answer:0 },
  { id:"fun-2", category:"Funny riddle", question:"What has keys but opens no locks?", options:["A map","A piano","A mailbox","A suitcase"], answer:1 },
  { id:"georgian-1", category:"Georgian culture", question:"What is the classic filling in Adjarian khachapuri?", options:["Cheese and egg","Beans and mint","Walnuts and honey","Potato and dill"], answer:0 },
  { id:"georgian-2", category:"Georgian culture", question:"Khinkali are best known for their…", options:["Juicy filling","Sweet icing","Crispy shell","Rice paper"], answer:0 }
];

function createCityGameEngine({ io, players, registeredUsers, roomName, saveAuthUsers = () => {} }) {
  const invites = new Map();
  const matches = new Map();
  const sessionBlocks = new Map();
  const sessionArcadeRecords = new Map();
  let sequence = 0;
  const GAME_REACTIONS = new Set(["Lucky win!", "Rematch?", "You got me!", "One more round!"]);

  const userKey = (p) => String(p && p.userKey || "").toLowerCase();
  const normalized = (s) => String(s || "").toLowerCase().trim();
  const playerById = (id) => players.get(id);
  const socketById = (id) => io.sockets.sockets.get(id);
  const reply = (ack, value) => { if (typeof ack === "function") ack(value); };
  const isMember = (match, id) => !!(match && match.players.includes(id));

  function arcadeRecordFor(player, game) {
    if (!player || !CITY_ARCADE_GAMES.has(game)) return null;
    const user = registeredUsers.get(userKey(player));
    const record = user?.arcadeRecords?.[game] || sessionArcadeRecords.get(player.id)?.[game];
    return record && Number.isFinite(record.score) ? { score: record.score, achievedAt: record.achievedAt || null } : null;
  }
  function saveArcadeRecord(player, game, score) {
    const previous = arcadeRecordFor(player, game);
    if (previous && previous.score >= score) return previous;
    const record = { score, achievedAt: Date.now() };
    const user = registeredUsers.get(userKey(player));
    if (user) {
      user.arcadeRecords ||= {};
      user.arcadeRecords[game] = record;
      saveAuthUsers();
    } else {
      const records = sessionArcadeRecords.get(player.id) || {};
      records[game] = record;
      sessionArcadeRecords.set(player.id, records);
    }
    if (roomName) io.to(roomName).emit("city:arcade:recordsChanged");
    return record;
  }
  function arcadeRecordsView(player) {
    const arcadePlayers = Array.from(players.values())
      .filter(p => p.interiorId === "arcade-palace")
      .map(p => ({ id:p.id, name:p.name, records:Object.fromEntries(Array.from(CITY_ARCADE_GAMES, game => [game, arcadeRecordFor(p, game)])) }));
    const leaderboards = {};
    for (const game of CITY_ARCADE_GAMES) {
      const rows = [];
      for (const [username, user] of registeredUsers) {
        const record = user.arcadeRecords?.[game];
        if (record && Number.isFinite(record.score)) rows.push({ username:user.username || username, score:record.score, achievedAt:record.achievedAt || null });
      }
      for (const p of players.values()) {
        if (registeredUsers.has(userKey(p))) continue;
        const record = arcadeRecordFor(p, game);
        if (record) rows.push({ username:p.name, score:record.score, achievedAt:record.achievedAt || null });
      }
      rows.sort((a,b) => b.score-a.score || (a.achievedAt||0)-(b.achievedAt||0));
      leaderboards[game] = rows.slice(0,10);
    }
    return { players:arcadePlayers, leaderboards, ownRecords:Object.fromEntries(Array.from(CITY_ARCADE_GAMES, game => [game, arcadeRecordFor(player, game)])) };
  }

  function permanentBlocks(p) {
    const user = registeredUsers.get(userKey(p));
    return new Set((user && Array.isArray(user.blockedUsers) ? user.blockedUsers : []).map(normalized));
  }
  function sessionBlockSet(key) {
    const k = normalized(key);
    if (!sessionBlocks.has(k)) sessionBlocks.set(k, new Set());
    return sessionBlocks.get(k);
  }
  function gameBlocked(a, b) {
    if (!a || !b) return false;
    const aKey = userKey(a), bKey = userKey(b);
    if (sessionBlocks.get(aKey)?.has(bKey) || sessionBlocks.get(bKey)?.has(aKey)) return true;
    return permanentBlocks(a).has(bKey) || permanentBlocks(b).has(aKey);
  }
  function blockedNames(p) {
    if (!p) return [];
    return Array.from(sessionBlocks.get(userKey(p)) || []);
  }
  function syncBlockedPlayers(ownerKey) {
    const key = normalized(ownerKey);
    for (const p of players.values()) if (userKey(p) === key) socketById(p.id)?.emit("city:game:blocks", blockedNames(p));
  }
  function setSessionBlock(ownerKey, targetKey, blocked) {
    const owner = normalized(ownerKey), target = normalized(targetKey);
    if (!owner || !target || owner === target) return;
    const set = sessionBlockSet(owner);
    if (blocked) set.add(target); else set.delete(target);
    if (!set.size) sessionBlocks.delete(owner);
    syncBlockedPlayers(owner);
  }

  function findInviteByPlayer(id) {
    return Array.from(invites.values()).find((invite) => invite.fromId === id || invite.toId === id);
  }
  function clearInvite(invite, notify, message) {
    if (!invite || !invites.has(invite.id)) return;
    clearTimeout(invite.timer);
    invites.delete(invite.id);
    if (!notify) return;
    socketById(invite.fromId)?.emit("city:game:inviteCancelled", { inviteId:invite.id, message:message || "Invitation ended." });
    if (invite.toId !== invite.fromId) socketById(invite.toId)?.emit("city:game:inviteCancelled", { inviteId:invite.id, message:message || "Invitation ended." });
  }
  function clearInvitesFor(id) {
    for (const invite of invites.values()) if (invite.fromId === id || invite.toId === id) clearInvite(invite, true, "The other player left the city.");
  }
  function stateFor(match, viewerId) {
    const s = match.state;
    if (!s) return null;
    if (CITY_ARCADE_GAMES.has(match.game)) return {
      stage:s.stage, deadlineAt:s.deadlineAt, durationMs:s.durationMs,
      scores:Object.assign({}, s.scores),
      submitted:Object.fromEntries(match.players.map(id => [id, !!s.submissions[id]])),
      mySubmitted:!!s.submissions[viewerId], result:s.result || null
    };
    if (match.game === "ttt") return {
      board:s.board.slice(), turnId:s.turnId, marks:Object.assign({}, s.marks),
      winnerId:s.winnerId || null, draw:!!s.draw, round:s.round
    };
    if (match.game === "math") {
      const out = { round:s.round, totalRounds:s.totalRounds, stage:s.stage, question:s.question,
        deadlineAt:s.deadlineAt || null, scores:Object.assign({}, s.scores),
        locked:Object.fromEntries(match.players.map(id => [id, !!s.submissions[id]])),
        mySubmitted:!!s.submissions[viewerId], result:s.stage !== "answering" ? s.result : null };
      if (s.stage !== "answering") out.answer = s.answer;
      return out;
    }
    if (match.game === "rps") {
      const out = { round:s.round, maxRounds:s.maxRounds, targetScore:s.targetScore, stage:s.stage,
        deadlineAt:s.deadlineAt || null, scores:Object.assign({}, s.scores),
        locked:Object.fromEntries(match.players.map(id => [id, !!s.choices[id]])),
        myLocked:!!s.choices[viewerId], myChoice:s.choices[viewerId] || null, result:s.result || null };
      if (s.stage !== "choosing") out.choices = Object.assign({}, s.revealedChoices);
      return out;
    }
    if (match.game === "quiz") {
      const out = { round:s.round, totalRounds:s.totalRounds, stage:s.stage, category:s.question.category,
        question:s.question.question, options:s.question.options.slice(), deadlineAt:s.deadlineAt || null,
        scores:Object.assign({}, s.scores), locked:Object.fromEntries(match.players.map(id => [id, s.answers[id] !== undefined])),
        myAnswer:s.answers[viewerId] === undefined ? null : s.answers[viewerId], result:s.stage !== "answering" ? s.result : null };
      if (s.stage !== "answering") out.correctIndex = s.question.answer;
      return out;
    }
    return null;
  }
  function publicMatch(match, viewerId) {
    return {
      id:match.id,
      players:match.players.map(id => { const p=playerById(id); return { id, name:p?p.name:"Player", color:p?p.color:"#8d99ff",
        arcadeRecord:match.arcadeMode&&p?arcadeRecordFor(p,match.game)?.score??null:null }; }),
      hostId:match.hostId, game:match.game, status:match.status, arcadeMode:!!match.arcadeMode,
      rematchVotes:Array.from(match.rematchVotes), result:match.result || null,
      state:stateFor(match, viewerId)
    };
  }
  function pushMatch(match) {
    if (!match || !matches.has(match.id)) return;
    for (const id of match.players) socketById(id)?.emit("city:game:update", publicMatch(match, id));
  }
  function nameOf(id) { const p=playerById(id); return p ? p.name : "Player"; }
  function setPhonePose(match) {
    const startedAt = Date.now();
    for (const id of match.players) { const p=playerById(id); if(p){p.action="phone";p.actionUntil=0;p.gameStartedAt=startedAt;} }
  }
  function finishPlaying(match, result) {
    match.status="finished"; match.result=result; match.rematchVotes.clear();
    if (match.state) match.state.stage="finished";
    for (const id of match.players) {
      const p=playerById(id); if(!p)continue;
      p.action = result.winnerId ? (result.winnerId===id ? "dance" : "sad") : "wave";
      p.actionUntil=Date.now()+2600;
    }
    clearTimeout(match.poseTimer);
    match.poseTimer=setTimeout(()=>{
      if(!matches.has(match.id)||match.status!=="finished")return;
      for(const id of match.players){const p=playerById(id);if(p&&p.gameId===match.id){p.action="phone";p.actionUntil=0;}}
    },2600);
    pushMatch(match);
  }
  function endMatch(match, message) {
    if (!match || !matches.has(match.id)) return;
    clearTimeout(match.timer); clearTimeout(match.poseTimer); matches.delete(match.id);
    for (const id of match.players) {
      const p=playerById(id), sock=socketById(id);
      if (p && p.gameId===match.id) { p.gameId=null;p.gameStartedAt=0;p.action="idle";p.actionUntil=0; }
      if (sock) { sock.leave("citygame:"+match.id);sock.emit("city:game:ended",{matchId:match.id,message:message||"Game closed."}); }
    }
  }
  function onDisconnect(id) {
    clearInvitesFor(id);
    const p=playerById(id);
    if (p && p.gameId) endMatch(matches.get(p.gameId), "Your opponent left the city.");
  }
  function makeMatch(from, to, arcadeMode) {
    const id="cg:"+Date.now().toString(36)+":"+(++sequence).toString(36)+":"+Math.random().toString(36).slice(2,8);
    const match={id,players:[from.id,to.id],hostId:from.id,game:null,arcadeMode:!!arcadeMode,status:"lobby",state:null,result:null,rematchVotes:new Set(),timer:null,poseTimer:null,usedQuestions:new Set()};
    matches.set(id,match);from.gameId=to.gameId=id;setPhonePose(match);
    const a=socketById(from.id),b=socketById(to.id);a?.join("citygame:"+id);b?.join("citygame:"+id);
    a?.emit("city:game:started",publicMatch(match,from.id));b?.emit("city:game:started",publicMatch(match,to.id));
  }
  function mathQuestion(round) {
    let a,b,answer,question;
    if (round <= 2) {
      a=2+Math.floor(Math.random()*19);b=2+Math.floor(Math.random()*18);
      if(Math.random()<.5){answer=a+b;question=a+" + "+b+" = ?";}else{if(b>a)[a,b]=[b,a];answer=a-b;question=a+" − "+b+" = ?";}
    } else if (round <= 4) {
      a=2+Math.floor(Math.random()*8);b=2+Math.floor(Math.random()*8);answer=a*b;question=a+" × "+b+" = ?";
    } else {
      a=2+Math.floor(Math.random()*8);b=2+Math.floor(Math.random()*7);const c=1+Math.floor(Math.random()*9);answer=a*b+c;question=a+" × "+b+" + "+c+" = ?";
    }
    return {question,answer};
  }
  function nextQuizQuestion(match) {
    const remaining=CITY_QUIZ_BANK.filter(q=>!match.usedQuestions.has(q.id));
    const q=remaining[Math.floor(Math.random()*remaining.length)];match.usedQuestions.add(q.id);return q;
  }
  function startRound(match) {
    if (!matches.has(match.id) || match.status!=="playing") return;
    if (match.game === "math") {
      const q=mathQuestion(match.state ? match.state.round : 1),round=match.state ? match.state.round : 1;
      match.state={round,totalRounds:5,stage:"answering",question:q.question,answer:q.answer,
        deadlineAt:Date.now()+12000,scores:match.state?match.state.scores:Object.fromEntries(match.players.map(id=>[id,0])),submissions:{},result:null};
      match.timer=setTimeout(()=>resolveMathRound(match),12000);
    } else if (match.game === "quiz") {
      const round=match.state?match.state.round:1;
      match.state={round,totalRounds:5,stage:"answering",question:nextQuizQuestion(match),deadlineAt:Date.now()+15000,
        scores:match.state?match.state.scores:Object.fromEntries(match.players.map(id=>[id,0])),answers:{},result:null};
      match.timer=setTimeout(()=>resolveQuizRound(match),15000);
    } else if (match.game === "rps") {
      const round=match.state?match.state.round:1;
      match.state={round,maxRounds:3,targetScore:2,stage:"choosing",deadlineAt:Date.now()+10000,
        scores:match.state?match.state.scores:Object.fromEntries(match.players.map(id=>[id,0])),choices:{},result:null,revealedChoices:null};
      match.timer=setTimeout(()=>resolveRpsRound(match),10000);
    }
    pushMatch(match);
  }
  function scoreResult(match) {
    const [a,b]=match.players,sa=match.state.scores[a]||0,sb=match.state.scores[b]||0;
    const winnerId=sa===sb?null:sa>sb?a:b;
    return {winnerId,draw:!winnerId,scores:Object.assign({},match.state.scores),text:winnerId?nameOf(winnerId)+" wins!":"It’s a draw!"};
  }
  function advanceTimedRound(match, resolve, totalRounds) {
    if (match.state.round >= totalRounds) { finishPlaying(match,scoreResult(match));return; }
    match.timer=setTimeout(()=>{if(!matches.has(match.id)||match.status!=="playing")return;match.state.round++;startRound(match);},2100);
  }
  function resolveMathRound(match) {
    if (!matches.has(match.id)||match.status!=="playing"||match.game!=="math"||match.state.stage!=="answering") return;
    clearTimeout(match.timer);
    const submissions=match.state.submissions,correct=match.players.filter(id=>submissions[id]&&submissions[id].value===match.state.answer)
      .sort((a,b)=>submissions[a].at-submissions[b].at);
    const points={};correct.forEach((id,i)=>{points[id]=i===0?2:1;match.state.scores[id]=(match.state.scores[id]||0)+points[id]});
    match.state.stage="reveal";match.state.deadlineAt=null;match.state.result={answer:match.state.answer,correctBy:correct,points};pushMatch(match);
    advanceTimedRound(match,null,match.state.totalRounds);
  }
  function resolveQuizRound(match) {
    if (!matches.has(match.id)||match.status!=="playing"||match.game!=="quiz"||match.state.stage!=="answering") return;
    clearTimeout(match.timer);
    const answers=match.state.answers,correct=match.players.filter(id=>answers[id]&&answers[id].index===match.state.question.answer)
      .sort((a,b)=>answers[a].at-answers[b].at);
    const points={};correct.forEach((id,i)=>{points[id]=i===0?2:1;match.state.scores[id]=(match.state.scores[id]||0)+points[id]});
    match.state.stage="reveal";match.state.deadlineAt=null;match.state.result={correctBy:correct,points,answers:Object.fromEntries(match.players.map(id=>[id,answers[id]?answers[id].index:null]))};pushMatch(match);
    advanceTimedRound(match,null,match.state.totalRounds);
  }
  function resolveRpsRound(match) {
    if (!matches.has(match.id)||match.status!=="playing"||match.game!=="rps"||match.state.stage!=="choosing") return;
    clearTimeout(match.timer);
    const [a,b]=match.players,ca=match.state.choices[a]||null,cb=match.state.choices[b]||null;
    let winnerId=null;
    if(ca&&!cb)winnerId=a;else if(cb&&!ca)winnerId=b;else if(ca&&cb&&ca!==cb){const wins={rock:"scissors",paper:"rock",scissors:"paper"};if(wins[ca]===cb)winnerId=a;else if(wins[cb]===ca)winnerId=b;}
    if(winnerId)match.state.scores[winnerId]=(match.state.scores[winnerId]||0)+1;
    match.state.stage="reveal";match.state.deadlineAt=null;match.state.revealedChoices={[a]:ca,[b]:cb};match.state.result={winnerId,draw:!winnerId,forfeit:!!(ca!==cb&&(!ca||!cb))};pushMatch(match);
    const scores=match.state.scores;
    if(Math.max(scores[a],scores[b])>=match.state.targetScore||match.state.round>=match.state.maxRounds){finishPlaying(match,scoreResult(match));return;}
    match.timer=setTimeout(()=>{if(!matches.has(match.id)||match.status!=="playing")return;match.state.round++;startRound(match);},1800);
  }
  function startGame(match) {
    clearTimeout(match.timer);clearTimeout(match.poseTimer);match.timer=null;match.poseTimer=null;match.status="playing";match.result=null;match.rematchVotes.clear();match.usedQuestions=new Set();setPhonePose(match);
    if (match.arcadeMode && CITY_ARCADE_GAMES.has(match.game)) {
      const durationMs=60000,submitGraceMs=2500,deadlineAt=Date.now()+durationMs;
      match.state={stage:"playing",durationMs,deadlineAt,submitUntil:deadlineAt+submitGraceMs,
        scores:Object.fromEntries(match.players.map(id=>[id,0])),submissions:{},result:null};
      match.timer=setTimeout(()=>finishArcade(match),durationMs+submitGraceMs);
      pushMatch(match);
    } else if(match.game==="ttt") {
      const [x,o]=match.players;match.state={round:1,board:Array(9).fill(null),turnId:x,marks:{[x]:"X",[o]:"O"},winnerId:null,draw:false};pushMatch(match);
    } else {
      match.state=null;
      if(match.game==="math")match.state={round:1,scores:Object.fromEntries(match.players.map(id=>[id,0]))};
      else if(match.game==="quiz")match.state={round:1,scores:Object.fromEntries(match.players.map(id=>[id,0]))};
      else if(match.game==="rps")match.state={round:1,scores:Object.fromEntries(match.players.map(id=>[id,0]))};
      startRound(match);
    }
  }
  function finishArcade(match) {
    if (!matches.has(match.id) || match.status!=="playing" || !match.state || !CITY_ARCADE_GAMES.has(match.game)) return;
    clearTimeout(match.timer);
    const scores=match.state.scores;
    const [a,b]=match.players,sa=scores[a]||0,sb=scores[b]||0;
    const winnerId=sa===sb?null:sa>sb?a:b;
    finishPlaying(match,{winnerId,draw:!winnerId,scores:Object.assign({},scores),
      text:winnerId?nameOf(winnerId)+" wins the "+CITY_GAME_DEFINITIONS[match.game].name+" score race!":"Score race tied!"});
  }
  function doTicTacToe(match, player, index) {
    const s=match.state;
    if(!Number.isInteger(index)||index<0||index>8||s.board[index]!==null)return {error:"That square is already taken."};
    if(s.turnId!==player.id)return {error:"Wait for your turn."};
    s.board[index]=s.marks[player.id];
    const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    const line=lines.find(row=>row.every(i=>s.board[i]===s.marks[player.id]));
    if(line){s.winnerId=player.id;finishPlaying(match,{winnerId:player.id,draw:false,text:nameOf(player.id)+" wins Tic-Tac-Toe!"});return {ok:true};}
    if(s.board.every(Boolean)){s.draw=true;finishPlaying(match,{winnerId:null,draw:true,text:"Tic-Tac-Toe ended in a draw."});return {ok:true};}
    s.turnId=match.players.find(id=>id!==player.id);pushMatch(match);return {ok:true};
  }
  function gameAction(match, player, data) {
    if(match.status!=="playing"||!match.state)return {error:"This game is not accepting moves."};
    if(match.game==="ttt")return doTicTacToe(match,player,Number(data.index));
    const s=match.state,now=Date.now();
    if (CITY_ARCADE_GAMES.has(match.game)) {
      if (!match.arcadeMode || data.type!=="submitScore" || now>s.submitUntil || s.submissions[player.id]) return {error:"That arcade run has ended or was already submitted."};
      const score=Number(data.score);
      if (!Number.isSafeInteger(score) || score<0 || score>5000000) return {error:"That score is not valid."};
      s.scores[player.id]=score;
      s.submissions[player.id]=true;
      saveArcadeRecord(player,match.game,score);
      if (match.players.every(id=>s.submissions[id])) finishArcade(match);
      else pushMatch(match);
      return {ok:true};
    }
    if(match.game==="math") {
      if(data.type!=="answer"||s.stage!=="answering"||now>s.deadlineAt)return {error:"That round has ended."};
      if(s.submissions[player.id])return {error:"Your answer is already locked."};
      const value=Number(data.answer);if(!Number.isFinite(value)||!Number.isInteger(value)||Math.abs(value)>100000)return {error:"Enter a whole-number answer."};
      s.submissions[player.id]={value,at:now};pushMatch(match);
      if(match.players.every(id=>s.submissions[id]))resolveMathRound(match);
      return {ok:true};
    }
    if(match.game==="quiz") {
      if(data.type!=="answer"||s.stage!=="answering"||now>s.deadlineAt)return {error:"That question has ended."};
      if(s.answers[player.id]!==undefined)return {error:"Your answer is already locked."};
      const index=Number(data.answer);if(!Number.isInteger(index)||index<0||index>=s.question.options.length)return {error:"Choose one of the answers."};
      s.answers[player.id]={index,at:now};pushMatch(match);
      if(match.players.every(id=>s.answers[id]!==undefined))resolveQuizRound(match);
      return {ok:true};
    }
    if(match.game==="rps") {
      if(data.type!=="choose"||s.stage!=="choosing"||now>s.deadlineAt)return {error:"That round has ended."};
      if(s.choices[player.id])return {error:"Your choice is already locked."};
      if(!["rock","paper","scissors"].includes(data.choice))return {error:"Choose rock, paper, or scissors."};
      s.choices[player.id]=data.choice;pushMatch(match);
      if(match.players.every(id=>s.choices[id]))resolveRpsRound(match);
      return {ok:true};
    }
    return {error:"Unknown game."};
  }
  function sendInvite(socket, data, ack) {
    const from=players.get(socket.id),to=players.get(data&&data.targetId);
    const arcadeMode=!!(from&&to&&from.interiorId==="arcade-palace"&&to.interiorId==="arcade-palace");
    if(!from||!to||from===to||((from.interiorId||to.interiorId)&&!arcadeMode)||from.rideId||to.rideId||from.gameId||to.gameId)
      return reply(ack,{error:"That player is not available for a game."});
    if(!arcadeMode&&Math.hypot(from.x-to.x,from.y-to.y)>135)return reply(ack,{error:"Walk closer before inviting them."});
    const now=Date.now();if(now-(from.lastGameInviteAt||0)<10000)return reply(ack,{error:"Give the other player a moment before another invite."});
    from.lastGameInviteAt=now;
    if(gameBlocked(from,to))return reply(ack,{error:"Game invitations are unavailable for this player."});
    if(findInviteByPlayer(to.id))return reply(ack,{error:"That player already has a pending game invitation."});
    const id="cgi:"+Date.now().toString(36)+":"+(++sequence).toString(36)+":"+Math.random().toString(36).slice(2,7);
    const invite={id,fromId:from.id,toId:to.id,createdAt:now,arcadeMode};invites.set(id,invite);
    socketById(to.id)?.emit("city:game:inviteRequest",{inviteId:id,fromId:from.id,fromName:from.name,arcadeMode,expiresAt:now+25000});
    socket.emit("city:game:invitePending",{inviteId:id,toName:to.name,arcadeMode,expiresAt:now+25000});
    invite.timer=setTimeout(()=>clearInvite(invite,true,"The invitation expired."),25000);
    reply(ack,{ok:true});
  }
  function respondInvite(socket, data, ack) {
    const invite=invites.get(data&&data.inviteId),to=players.get(socket.id),from=invite&&players.get(invite.fromId);
    if(!invite||!to||invite.toId!==to.id||!from)return reply(ack,{error:"That invitation is no longer available."});
    if(!data.accept){clearInvite(invite,false);socket.emit("city:game:inviteCancelled",{inviteId:invite.id,message:"Invitation declined."});socketById(from.id)?.emit("city:game:inviteDeclined",{inviteId:invite.id,playerName:to.name});reply(ack,{ok:true});return;}
    clearTimeout(invite.timer);invites.delete(invite.id);
    const sameArcade=from.interiorId==="arcade-palace"&&to.interiorId==="arcade-palace";
    if(from.gameId||to.gameId||gameBlocked(from,to)||(invite.arcadeMode?!sameArcade:(from.interiorId||to.interiorId||Math.hypot(from.x-to.x,from.y-to.y)>175))){
      socket.emit("city:game:inviteCancelled",{inviteId:invite.id,message:"The game could not start; check that both players are still nearby."});
      socketById(from.id)?.emit("city:game:inviteCancelled",{inviteId:invite.id,message:"The game could not start; both players must stay nearby."});
      return reply(ack,{error:"Both players need to stay nearby and available."});
    }
    makeMatch(from,to,invite.arcadeMode);reply(ack,{ok:true});
  }
  function bind(socket) {
    socket.on("city:arcade:records",(data,ack)=>{
      const p=players.get(socket.id);
      if(!p||p.interiorId!=="arcade-palace")return reply(ack,{error:"Enter the Pixel Palace to view its records."});
      reply(ack,arcadeRecordsView(p));
    });
    socket.on("city:arcade:record",(data,ack)=>{
      const p=players.get(socket.id),game=data&&data.game,score=Number(data&&data.score);
      if(!p||p.interiorId!=="arcade-palace"||!CITY_ARCADE_GAMES.has(game))return reply(ack,{error:"That arcade cabinet is unavailable."});
      if(!Number.isSafeInteger(score)||score<0||score>5000000)return reply(ack,{error:"That score is not valid."});
      const record=saveArcadeRecord(p,game,score);
      reply(ack,{ok:true,record,records:arcadeRecordsView(p)});
    });
    socket.on("reg:sessionBlock",data=>{const owner=socket._regUser&&socket._regUser.usernameLower,target=normalized(data&&data.targetUsername);if(owner&&target)setSessionBlock(owner,target,true);});
    socket.on("reg:sessionUnblock",data=>{const owner=socket._regUser&&socket._regUser.usernameLower,target=normalized(data&&data.targetUsername);if(owner&&target)setSessionBlock(owner,target,false);});
    socket.on("city:game:invite",(data,ack)=>sendInvite(socket,data,ack));
    socket.on("city:game:inviteRespond",(data,ack)=>respondInvite(socket,data,ack));
    socket.on("city:game:inviteCancel",data=>{const invite=invites.get(data&&data.inviteId);if(invite&&invite.fromId===socket.id)clearInvite(invite,true,"The invitation was cancelled.");});
    socket.on("city:game:block",(data,ack)=>{
      const p=players.get(socket.id),target=players.get(data&&data.targetId);
      if(!p||!target||p===target)return reply(ack,{error:"That player is unavailable."});
      const blocked=!!data.blocked;setSessionBlock(userKey(p),userKey(target),blocked);
      const invite=findInviteByPlayer(target.id);if(blocked&&invite&&((invite.fromId===p.id&&invite.toId===target.id)||(invite.fromId===target.id&&invite.toId===p.id)))clearInvite(invite,true,"Game invitations were blocked.");
      if(blocked&&p.gameId&&p.gameId===target.gameId)endMatch(matches.get(p.gameId),"Game ended because one player blocked game invitations.");
      reply(ack,{ok:true,blockedPlayers:blockedNames(p)});
    });
    socket.on("city:game:choose",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId),game=data&&data.game;
      if(!p||!match||!isMember(match,p.id)||match.hostId!==p.id||match.status!=="lobby"||!Object.prototype.hasOwnProperty.call(CITY_GAME_DEFINITIONS,game)||(match.arcadeMode?!CITY_ARCADE_GAMES.has(game):CITY_ARCADE_GAMES.has(game)))return reply(ack,{error:"The game selection is unavailable."});
      match.game=game;pushMatch(match);reply(ack,{ok:true});
    });
    socket.on("city:game:start",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId);
      if(!p||!match||!isMember(match,p.id)||match.hostId!==p.id||match.status!=="lobby"||!match.game)return reply(ack,{error:"Choose a game first."});
      startGame(match);reply(ack,{ok:true});
    });
    socket.on("city:game:action",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId);
      if(!p||!match||!isMember(match,p.id)||p.gameId!==match.id)return reply(ack,{error:"This match is no longer active."});
      const result=gameAction(match,p,data||{});reply(ack,result);
    });
    socket.on("city:game:rematch",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId);
      if(!p||!match||!isMember(match,p.id)||match.status!=="finished")return reply(ack,{error:"This match is not ready for a rematch."});
      match.rematchVotes.add(p.id);pushMatch(match);
      if(match.players.every(id=>match.rematchVotes.has(id)))startGame(match);
      reply(ack,{ok:true});
    });
    socket.on("city:game:switch",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId);
      if(!p||!match||!isMember(match,p.id)||match.hostId!==p.id||match.status!=="finished")return reply(ack,{error:"Only the game host can choose another game."});
      clearTimeout(match.timer);clearTimeout(match.poseTimer);match.timer=null;match.poseTimer=null;match.status="lobby";match.game=null;match.state=null;match.result=null;match.rematchVotes.clear();setPhonePose(match);pushMatch(match);reply(ack,{ok:true});
    });
    socket.on("city:game:reaction",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId),text=String(data&&data.text||"");
      if(!p||!match||!isMember(match,p.id)||!GAME_REACTIONS.has(text))return reply(ack,{error:"That reaction is unavailable."});
      for(const id of match.players)socketById(id)?.emit("city:game:reaction",{matchId:match.id,fromId:p.id,name:p.name,text});reply(ack,{ok:true});
    });
    socket.on("city:game:leave",(data)=>{
      const p=players.get(socket.id),match=p&&p.gameId&&matches.get(p.gameId);
      if(match&&(!data||!data.matchId||data.matchId===match.id))endMatch(match,p.name+" returned to the city.");
    });
  }

  return { bind, remove:onDisconnect, blockedNames, definitions:CITY_GAME_DEFINITIONS };
}

module.exports = { createCityGameEngine };
