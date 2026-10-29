"use strict";

const CITY_GAME_DEFINITIONS = {
  ttt: { name: "ჯვარი-ნული", icon: "✕○", description: "ითამაშეთ რიგრიგობით ნეონის 3×3 დაფაზე." },
  math: { name: "მათემატიკური დუელი", icon: "∑", description: "შეეჯიბრეთ ერთმანეთს ხუთ სწრაფ არითმეტიკულ რაუნდში." },
  rps: { name: "ქვა · ქაღალდი · მაკრატელი", icon: "✊", description: "აირჩიეთ ფარულად. იმარჯვებს ორი რაუნდის მომგები." },
  quiz: { name: "ვიქტორინის დუელი", icon: "A?", description: "ხუთი კითხვა თბილისსა და ზოგად ცოდნაზე." },
  pacman: { name: "პაკმენი", icon: "ᗧ", description: "ორი მოთამაშე ლაბირინთში საუკეთესო ქულისთვის იბრძვის." },
  snake: { name: "გველი", icon: "🐍", description: "ერთი და იგივე 60-წამიანი შეჯიბრი ქულებზე." },
  tetris: { name: "ტეტრისი", icon: "🟦", description: "გაასუფთავე ხაზები და აჯობე მეტოქის ქულას." },
  pong: { name: "პონგი", icon: "🏓", description: "დაამარცხე არკადის მეტოქე და შეადარე რეკორდები." }
};
const CITY_ARCADE_GAMES = new Set(["pacman", "snake", "tetris", "pong"]);

const CITY_QUIZ_BANK = [
  { id:"general-1", category:"ზოგადი ცოდნა", question:"რომელ პლანეტას ეძახიან წითელ პლანეტას?", options:["ვენერა","მარსი","მერკური","იუპიტერი"], answer:1 },
  { id:"general-2", category:"ზოგადი ცოდნა", question:"რომელია დედამიწის ყველაზე დიდი ოკეანე?", options:["ატლანტის","ინდოეთის","წყნარი","ჩრდილოეთის ყინულოვანი"], answer:2 },
  { id:"gaming-1", category:"ვიდეოთამაშები", question:"რა ჰქვია მარიოს ძმას?", options:["ვარიო","ლუიჯი","ტოუდი","იოში"], answer:1 },
  { id:"gaming-2", category:"ვიდეოთამაშები", question:"რომელი თამაშია ცნობილი კრიპერებით?", options:["მაინკრაფტი","ტეტრისი","პაკმენი","სონიკი"], answer:0 },
  { id:"tech-1", category:"ტექნოლოგია", question:"რას ნიშნავს პროცესორის აბრევიატურა?", options:["ცენტრალური დამუშავების მოწყობილობა","კომპიუტერის კვების ხელსაწყო","ძირითადი პროგრამის მომხმარებელი","ცენტრალური პიქსელის მოწყობილობა"], answer:0 },
  { id:"tech-2", category:"ტექნოლოგია", question:"რას აღწერს ვებგვერდის მონიშვნის ენა?", options:["ვებგვერდის სტრუქტურას","უსადენო ქსელის სიჩქარეს","ბატარეის მდგომარეობას","ფოტოს ფერს"], answer:0 },
  { id:"geo-1", category:"გეოგრაფია", question:"რომელია საქართველოს დედაქალაქი?", options:["ბათუმი","ქუთაისი","თბილისი","თელავი"], answer:2 },
  { id:"geo-2", category:"გეოგრაფია", question:"რომელი მდინარე მიედინება თბილისში?", options:["რიონი","მტკვარი","ალაზანი","ენგური"], answer:1 },
  { id:"fun-1", category:"სახალისო გამოცანა", question:"რა სველდება, როცა აშრობს?", options:["პირსახოცი","სანთელი","ჩრდილი","საათი"], answer:0 },
  { id:"fun-2", category:"სახალისო გამოცანა", question:"რას აქვს კლავიშები, მაგრამ არცერთ საკეტს არ ხსნის?", options:["რუკა","ფორტეპიანო","საფოსტო ყუთი","ჩემოდანი"], answer:1 },
  { id:"georgian-1", category:"ქართული კულტურა", question:"რა არის აჭარული ხაჭაპურის ტრადიციული შიგთავსი?", options:["ყველი და კვერცხი","ლობიო და პიტნა","ნიგოზი და თაფლი","კარტოფილი და კამა"], answer:0 },
  { id:"georgian-2", category:"ქართული კულტურა", question:"რით გამოირჩევა ხინკალი?", options:["წვნიანი შიგთავსით","ტკბილი მინანქრით","ხრაშუნა ქერქით","ბრინჯის ქაღალდით"], answer:0 }
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
    socketById(invite.fromId)?.emit("city:game:inviteCancelled", { inviteId:invite.id, message:message || "მოწვევა დასრულდა." });
    if (invite.toId !== invite.fromId) socketById(invite.toId)?.emit("city:game:inviteCancelled", { inviteId:invite.id, message:message || "მოწვევა დასრულდა." });
  }
  function clearInvitesFor(id) {
    for (const invite of invites.values()) if (invite.fromId === id || invite.toId === id) clearInvite(invite, true, "მეორე მოთამაშემ ქალაქი დატოვა.");
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
      players:match.players.map(id => { const p=playerById(id); return { id, name:p?p.name:"მოთამაშე", color:p?p.color:"#8d99ff",
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
  function nameOf(id) { const p=playerById(id); return p ? p.name : "მოთამაშე"; }
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
      if (sock) { sock.leave("citygame:"+match.id);sock.emit("city:game:ended",{matchId:match.id,message:message||"თამაში დაიხურა."}); }
    }
  }
  function onDisconnect(id) {
    clearInvitesFor(id);
    const p=playerById(id);
    if (p && p.gameId) endMatch(matches.get(p.gameId), "მეტოქემ ქალაქი დატოვა.");
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
    return {winnerId,draw:!winnerId,scores:Object.assign({},match.state.scores),text:winnerId?nameOf(winnerId)+" იმარჯვებს!":"ფრეა!"};
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
      text:winnerId?nameOf(winnerId)+" იმარჯვებს თამაშში: "+CITY_GAME_DEFINITIONS[match.game].name+" ქულების შეჯიბრი!":"ქულები თანაბარია!"});
  }
  function doTicTacToe(match, player, index) {
    const s=match.state;
    if(!Number.isInteger(index)||index<0||index>8||s.board[index]!==null)return {error:"ეს უჯრა უკვე დაკავებულია."};
    if(s.turnId!==player.id)return {error:"დაელოდე შენს სვლას."};
    s.board[index]=s.marks[player.id];
    const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    const line=lines.find(row=>row.every(i=>s.board[i]===s.marks[player.id]));
    if(line){s.winnerId=player.id;finishPlaying(match,{winnerId:player.id,draw:false,text:nameOf(player.id)+" იგებს ჯვარი-ნულს!"});return {ok:true};}
    if(s.board.every(Boolean)){s.draw=true;finishPlaying(match,{winnerId:null,draw:true,text:"ჯვარი-ნული ფრედ დასრულდა."});return {ok:true};}
    s.turnId=match.players.find(id=>id!==player.id);pushMatch(match);return {ok:true};
  }
  function gameAction(match, player, data) {
    if(match.status!=="playing"||!match.state)return {error:"ამ თამაშში სვლები აღარ მიიღება."};
    if(match.game==="ttt")return doTicTacToe(match,player,Number(data.index));
    const s=match.state,now=Date.now();
    if (CITY_ARCADE_GAMES.has(match.game)) {
      if (!match.arcadeMode || data.type!=="submitScore" || now>s.submitUntil || s.submissions[player.id]) return {error:"ეს ცდა დასრულდა ან შედეგი უკვე გაგზავნილია."};
      const score=Number(data.score);
      if (!Number.isSafeInteger(score) || score<0 || score>5000000) return {error:"ქულა არასწორია."};
      s.scores[player.id]=score;
      s.submissions[player.id]=true;
      saveArcadeRecord(player,match.game,score);
      if (match.players.every(id=>s.submissions[id])) finishArcade(match);
      else pushMatch(match);
      return {ok:true};
    }
    if(match.game==="math") {
      if(data.type!=="answer"||s.stage!=="answering"||now>s.deadlineAt)return {error:"რაუნდი დასრულდა."};
      if(s.submissions[player.id])return {error:"შენი პასუხი უკვე დაფიქსირებულია."};
      const value=Number(data.answer);if(!Number.isFinite(value)||!Number.isInteger(value)||Math.abs(value)>100000)return {error:"შეიყვანე მთელი რიცხვი."};
      s.submissions[player.id]={value,at:now};pushMatch(match);
      if(match.players.every(id=>s.submissions[id]))resolveMathRound(match);
      return {ok:true};
    }
    if(match.game==="quiz") {
      if(data.type!=="answer"||s.stage!=="answering"||now>s.deadlineAt)return {error:"ამ კითხვის დრო დასრულდა."};
      if(s.answers[player.id]!==undefined)return {error:"შენი პასუხი უკვე დაფიქსირებულია."};
      const index=Number(data.answer);if(!Number.isInteger(index)||index<0||index>=s.question.options.length)return {error:"აირჩიე ერთ-ერთი პასუხი."};
      s.answers[player.id]={index,at:now};pushMatch(match);
      if(match.players.every(id=>s.answers[id]!==undefined))resolveQuizRound(match);
      return {ok:true};
    }
    if(match.game==="rps") {
      if(data.type!=="choose"||s.stage!=="choosing"||now>s.deadlineAt)return {error:"რაუნდი დასრულდა."};
      if(s.choices[player.id])return {error:"შენი არჩევანი უკვე დაფიქსირებულია."};
      if(!["rock","paper","scissors"].includes(data.choice))return {error:"აირჩიე ქვა, ქაღალდი ან მაკრატელი."};
      s.choices[player.id]=data.choice;pushMatch(match);
      if(match.players.every(id=>s.choices[id]))resolveRpsRound(match);
      return {ok:true};
    }
    return {error:"უცნობი თამაში."};
  }
  function sendInvite(socket, data, ack) {
    const from=players.get(socket.id),to=players.get(data&&data.targetId);
    const arcadeMode=!!(from&&to&&from.interiorId==="arcade-palace"&&to.interiorId==="arcade-palace");
    if(!from||!to||from===to||((from.interiorId||to.interiorId)&&!arcadeMode)||from.rideId||to.rideId||from.gameId||to.gameId)
      return reply(ack,{error:"ეს მოთამაშე სათამაშოდ მიუწვდომელია."});
    if(!arcadeMode&&Math.hypot(from.x-to.x,from.y-to.y)>135)return reply(ack,{error:"მოწვევამდე უფრო ახლოს მიდი."});
    const now=Date.now();if(now-(from.lastGameInviteAt||0)<10000)return reply(ack,{error:"შემდეგ მოწვევამდე ცოტა დაელოდე."});
    from.lastGameInviteAt=now;
    if(gameBlocked(from,to))return reply(ack,{error:"ამ მოთამაშისთვის თამაშის მოწვევები მიუწვდომელია."});
    if(findInviteByPlayer(to.id))return reply(ack,{error:"ამ მოთამაშეს უკვე აქვს უპასუხო მოწვევა."});
    const id="cgi:"+Date.now().toString(36)+":"+(++sequence).toString(36)+":"+Math.random().toString(36).slice(2,7);
    const invite={id,fromId:from.id,toId:to.id,createdAt:now,arcadeMode};invites.set(id,invite);
    socketById(to.id)?.emit("city:game:inviteRequest",{inviteId:id,fromId:from.id,fromName:from.name,arcadeMode,expiresAt:now+25000});
    socket.emit("city:game:invitePending",{inviteId:id,toName:to.name,arcadeMode,expiresAt:now+25000});
    invite.timer=setTimeout(()=>clearInvite(invite,true,"მოწვევის ვადა გავიდა."),25000);
    reply(ack,{ok:true});
  }
  function respondInvite(socket, data, ack) {
    const invite=invites.get(data&&data.inviteId),to=players.get(socket.id),from=invite&&players.get(invite.fromId);
    if(!invite||!to||invite.toId!==to.id||!from)return reply(ack,{error:"ეს მოწვევა აღარ არის ხელმისაწვდომი."});
    if(!data.accept){clearInvite(invite,false);socket.emit("city:game:inviteCancelled",{inviteId:invite.id,message:"მოწვევა უარყოფილია."});socketById(from.id)?.emit("city:game:inviteDeclined",{inviteId:invite.id,playerName:to.name});reply(ack,{ok:true});return;}
    clearTimeout(invite.timer);invites.delete(invite.id);
    const sameArcade=from.interiorId==="arcade-palace"&&to.interiorId==="arcade-palace";
    if(from.gameId||to.gameId||gameBlocked(from,to)||(invite.arcadeMode?!sameArcade:(from.interiorId||to.interiorId||Math.hypot(from.x-to.x,from.y-to.y)>175))){
      socket.emit("city:game:inviteCancelled",{inviteId:invite.id,message:"The game could not start; check that both players are still nearby."});
      socketById(from.id)?.emit("city:game:inviteCancelled",{inviteId:invite.id,message:"The game could not start; both players must stay nearby."});
      return reply(ack,{error:"ორივე მოთამაშე ახლოს და თავისუფალი უნდა დარჩეს."});
    }
    makeMatch(from,to,invite.arcadeMode);reply(ack,{ok:true});
  }
  function bind(socket) {
    socket.on("city:arcade:records",(data,ack)=>{
      const p=players.get(socket.id);
      if(!p||p.interiorId!=="arcade-palace")return reply(ack,{error:"რეკორდების სანახავად შედი პიქსელების სასახლეში."});
      reply(ack,arcadeRecordsView(p));
    });
    socket.on("city:arcade:record",(data,ack)=>{
      const p=players.get(socket.id),game=data&&data.game,score=Number(data&&data.score);
      if(!p||p.interiorId!=="arcade-palace"||!CITY_ARCADE_GAMES.has(game))return reply(ack,{error:"ეს არკადის აპარატი მიუწვდომელია."});
      if(!Number.isSafeInteger(score)||score<0||score>5000000)return reply(ack,{error:"ქულა არასწორია."});
      const record=saveArcadeRecord(p,game,score);
      reply(ack,{ok:true,record,records:arcadeRecordsView(p)});
    });
    socket.on("reg:sessionBlock",data=>{const owner=socket._regUser&&socket._regUser.usernameLower,target=normalized(data&&data.targetUsername);if(owner&&target)setSessionBlock(owner,target,true);});
    socket.on("reg:sessionUnblock",data=>{const owner=socket._regUser&&socket._regUser.usernameLower,target=normalized(data&&data.targetUsername);if(owner&&target)setSessionBlock(owner,target,false);});
    socket.on("city:game:invite",(data,ack)=>sendInvite(socket,data,ack));
    socket.on("city:game:inviteRespond",(data,ack)=>respondInvite(socket,data,ack));
    socket.on("city:game:inviteCancel",data=>{const invite=invites.get(data&&data.inviteId);if(invite&&invite.fromId===socket.id)clearInvite(invite,true,"მოწვევა გაუქმდა.");});
    socket.on("city:game:block",(data,ack)=>{
      const p=players.get(socket.id),target=players.get(data&&data.targetId);
      if(!p||!target||p===target)return reply(ack,{error:"მოთამაშე მიუწვდომელია."});
      const blocked=!!data.blocked;setSessionBlock(userKey(p),userKey(target),blocked);
      const invite=findInviteByPlayer(target.id);if(blocked&&invite&&((invite.fromId===p.id&&invite.toId===target.id)||(invite.fromId===target.id&&invite.toId===p.id)))clearInvite(invite,true,"თამაშის მოწვევები დაიბლოკა.");
      if(blocked&&p.gameId&&p.gameId===target.gameId)endMatch(matches.get(p.gameId),"თამაში დასრულდა, რადგან მოთამაშემ მოწვევები დაბლოკა.");
      reply(ack,{ok:true,blockedPlayers:blockedNames(p)});
    });
    socket.on("city:game:choose",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId),game=data&&data.game;
      if(!p||!match||!isMember(match,p.id)||match.hostId!==p.id||match.status!=="lobby"||!Object.prototype.hasOwnProperty.call(CITY_GAME_DEFINITIONS,game)||(match.arcadeMode?!CITY_ARCADE_GAMES.has(game):CITY_ARCADE_GAMES.has(game)))return reply(ack,{error:"თამაშის არჩევა მიუწვდომელია."});
      match.game=game;pushMatch(match);reply(ack,{ok:true});
    });
    socket.on("city:game:start",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId);
      if(!p||!match||!isMember(match,p.id)||match.hostId!==p.id||match.status!=="lobby"||!match.game)return reply(ack,{error:"ჯერ აირჩიე თამაში."});
      startGame(match);reply(ack,{ok:true});
    });
    socket.on("city:game:action",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId);
      if(!p||!match||!isMember(match,p.id)||p.gameId!==match.id)return reply(ack,{error:"ეს მატჩი აღარ მიმდინარეობს."});
      const result=gameAction(match,p,data||{});reply(ack,result);
    });
    socket.on("city:game:rematch",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId);
      if(!p||!match||!isMember(match,p.id)||match.status!=="finished")return reply(ack,{error:"ეს მატჩი განმეორებისთვის მზად არ არის."});
      match.rematchVotes.add(p.id);pushMatch(match);
      if(match.players.every(id=>match.rematchVotes.has(id)))startGame(match);
      reply(ack,{ok:true});
    });
    socket.on("city:game:switch",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId);
      if(!p||!match||!isMember(match,p.id)||match.hostId!==p.id||match.status!=="finished")return reply(ack,{error:"სხვა თამაშის არჩევა მხოლოდ მასპინძელს შეუძლია."});
      clearTimeout(match.timer);clearTimeout(match.poseTimer);match.timer=null;match.poseTimer=null;match.status="lobby";match.game=null;match.state=null;match.result=null;match.rematchVotes.clear();setPhonePose(match);pushMatch(match);reply(ack,{ok:true});
    });
    socket.on("city:game:reaction",(data,ack)=>{
      const p=players.get(socket.id),match=matches.get(data&&data.matchId),text=String(data&&data.text||"");
      if(!p||!match||!isMember(match,p.id)||!GAME_REACTIONS.has(text))return reply(ack,{error:"ეს რეაქცია მიუწვდომელია."});
      for(const id of match.players)socketById(id)?.emit("city:game:reaction",{matchId:match.id,fromId:p.id,name:p.name,text});reply(ack,{ok:true});
    });
    socket.on("city:game:leave",(data)=>{
      const p=players.get(socket.id),match=p&&p.gameId&&matches.get(p.gameId);
      if(match&&(!data||!data.matchId||data.matchId===match.id))endMatch(match,p.name+" დაბრუნდა ქალაქში.");
    });
  }

  return { bind, remove:onDisconnect, blockedNames, definitions:CITY_GAME_DEFINITIONS };
}

module.exports = { createCityGameEngine };
