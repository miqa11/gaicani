(function () {
  "use strict";
  const bridge=window.GaicaniCityGameBridge;
  if(!bridge)return;
  const socket=bridge.getSocket();
  const invitePanel=document.getElementById("cityGameInvite"),inviteTitle=document.getElementById("cityGameInviteTitle"),inviteText=document.getElementById("cityGameInviteText"),inviteActions=document.getElementById("cityGameInviteActions");
  const dimmer=document.getElementById("cityGameDimmer"),phone=document.getElementById("cityGamePhone"),screen=document.getElementById("cityGameScreen"),playersLine=document.getElementById("cityGamePlayers"),title=document.getElementById("cityGameTitle"),reaction=document.getElementById("cityGameReaction");
  const phoneKicker=phone.querySelector(".city-game-header small"),phoneFooter=phone.querySelector(".city-game-footer");
  const gameButton=document.getElementById("playerGameButton"),blockButton=document.getElementById("playerGameBlockButton");
  const games=[
    {id:"ttt",name:"Tic-Tac-Toe",icon:"✕○",description:"Take turns on a neon 3×3 board."},
    {id:"math",name:"Math Duel",icon:"∑",description:"Race through five quick arithmetic rounds."},
    {id:"rps",name:"Rock · Paper · Scissors",icon:"✊",description:"Secret picks. First to two round wins."},
    {id:"quiz",name:"Quiz Duel",icon:"A?",description:"Five questions across six playful categories."},
    {id:"pacman",name:"Pac-Man",icon:"ᗧ",description:"Race for the highest maze score.",arcade:true},
    {id:"snake",name:"Snake",icon:"🐍",description:"Grab as many pixels as you can.",arcade:true},
    {id:"tetris",name:"Tetris",icon:"🟦",description:"Clear lines before the stack reaches the top.",arcade:true},
    {id:"pong",name:"Pong",icon:"🏓",description:"Beat the cabinet and post your score.",arcade:true}
  ];
  let invitation=null,match=null,selectingGame=false,accountBlocks=new Set(),sessionBlocks=new Set(),reactionTimer=0,arcadeRun=null,arcadeRunNode=null,arcadeRunKey="";
  const gameNames=Object.fromEntries(games.map(g=>[g.id,g.name]));

  function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
  function btn(text,run,cls,disabled){const b=el("button","game-button"+(cls?" "+cls:""),text);b.type="button";b.disabled=!!disabled;b.addEventListener("click",run);return b}
  function gameEvent(name,data,onResult){socket.emit(name,Object.assign({matchId:match&&match.id},data||{}),r=>{if(r&&r.error)bridge.toast(r.error);else if(onResult)onResult(r)})}
  function stopCity(){bridge.stop()}
  function hideInvite(){invitation=null;invitePanel.hidden=true;inviteActions.replaceChildren()}
  function showInvite(data){invitation=data;renderInvite();stopCity()}
  function renderInvite(){
    if(!invitation){invitePanel.hidden=true;return}
    invitePanel.hidden=false;inviteActions.replaceChildren();
    if(invitation.kind==="incoming"){
      inviteTitle.textContent=invitation.arcadeMode?"⚔️ Arcade challenge":"🎮 Game invitation";inviteText.textContent=invitation.arcadeMode?invitation.fromName+" challenges you to a retro cabinet score race.":invitation.fromName+" wants to play a quick game with you.";
      const accept=el("button","game-button primary",invitation.arcadeMode?"Accept · play at the cabinet":"Accept · take out your phone");accept.addEventListener("click",()=>socket.emit("city:game:inviteRespond",{inviteId:invitation.inviteId,accept:true},r=>{if(r&&r.error)bridge.toast(r.error)}));
      const decline=el("button","game-button","Decline");decline.addEventListener("click",()=>socket.emit("city:game:inviteRespond",{inviteId:invitation.inviteId,accept:false},()=>hideInvite()));inviteActions.append(accept,decline);
    }else{
      inviteTitle.textContent="📱 Invitation sent";inviteText.textContent="Waiting for "+(invitation.toName||"the other player")+" to accept.";
      const cancel=el("button","game-button","Cancel invitation");cancel.addEventListener("click",()=>{if(invitation.inviteId)socket.emit("city:game:inviteCancel",{inviteId:invitation.inviteId});hideInvite()});inviteActions.appendChild(cancel);
    }
  }
  function currentPlayerId(){const p=bridge.getSelf();return p&&p.id}
  function updatePlayerCard(){
    const targetId=bridge.getTargetId(),target=targetId&&bridge.getPlayer(targetId),self=bridge.getSelf();
    if(!target){gameButton.hidden=true;blockButton.hidden=true;return}
    const lc=String(target.name||"").toLowerCase(),distance=self?Math.hypot(self.x-target.x,self.y-target.y):Infinity;
    const accountBlocked=accountBlocks.has(lc),sessionBlocked=sessionBlocks.has(lc);
    gameButton.hidden=!!(accountBlocked||sessionBlocked||target.gameId||distance>140);
    blockButton.hidden=false;blockButton.disabled=accountBlocked;blockButton.textContent=accountBlocked?"🚫 Account block active":sessionBlocked?"✅ Allow game invites":"🚫 Block game invites";
    blockButton.title=accountBlocked?"Remove this account block from your dashboard.":"Block or allow game invitations from this player in this session.";
  }
  gameButton.addEventListener("click",()=>{
    const targetId=bridge.getTargetId(),target=targetId&&bridge.getPlayer(targetId);
    if(!target)return;
    gameButton.disabled=true;socket.emit("city:game:invite",{targetId},r=>{gameButton.disabled=false;if(r&&r.error)bridge.toast(r.error);else{document.getElementById("playerCard").hidden=true;bridge.toast("📱 Invitation sent")}});
  });
  function inviteArcade(targetId){
    const target=bridge.getPlayer(targetId);
    if(!target||target.interiorId!=="arcade-palace"){bridge.toast("Meet them inside the Pixel Palace first.");return}
    if(match||invitation){bridge.toast("Finish the current game invitation first.");return}
    socket.emit("city:game:invite",{targetId,arcade:true},r=>{if(r&&r.error)bridge.toast(r.error)});
  }
  blockButton.addEventListener("click",()=>{
    const targetId=bridge.getTargetId(),target=targetId&&bridge.getPlayer(targetId);if(!target)return;
    const blocked=!sessionBlocks.has(String(target.name).toLowerCase());
    socket.emit("city:game:block",{targetId,blocked},r=>{if(r&&r.error){bridge.toast(r.error);return}sessionBlocks=new Set((r&&r.blockedPlayers||[]).map(x=>String(x).toLowerCase()));updatePlayerCard();bridge.toast(blocked?"Game invitations blocked for this player.":"Game invitations allowed again.")});
  });

  function renderInviteStatusLine(parent,matchData){
    const names=(matchData.players||[]).map(p=>p.name).join("  ✦  ");
    playersLine.textContent=names||"Two players · one city";
  }
  function heading(parent,text,copy){parent.appendChild(el("h3","game-heading",text));if(copy)parent.appendChild(el("p","game-copy",copy))}
  function scoreline(parent,state){
    const row=el("div","game-scoreline");(match.players||[]).forEach(p=>row.appendChild(el("span","",p.name+"  "+((state.scores&&state.scores[p.id])||0))));parent.appendChild(row);
  }
  function status(parent,text){parent.appendChild(el("p","game-status",text))}
  function resultBox(parent,titleText,copy){const box=el("div","game-result");if(titleText)box.appendChild(el("strong","",titleText));if(copy)box.appendChild(el("span","",copy));parent.appendChild(box);return box}
  function addCountdown(parent,deadline){if(!deadline)return;const time=el("div","game-countdown","");time.dataset.deadline=String(deadline);parent.appendChild(time);updateCountdowns()}
  function updateCountdowns(){document.querySelectorAll(".game-countdown[data-deadline]").forEach(node=>{const left=Math.max(0,Math.ceil((Number(node.dataset.deadline)-Date.now())/1000));node.textContent=left+"s"})}
  function lobbyView(){
    const host=currentPlayerId()===match.hostId,selected=match.game;
    const availableGames=games.filter(g=>!!g.arcade===!!match.arcadeMode);
    heading(screen,selected&&!selectingGame?gameNames[selected]:"Choose a game",host?(match.arcadeMode?"Choose a cabinet for a 60-second score race.":"Pick a quick game for both phones."):(match.players.find(p=>p.id===match.hostId)?.name||"Your friend")+" is choosing the game.");
    if(!selected||selectingGame){
      const grid=el("div","game-choice-grid");availableGames.forEach(g=>{const card=el("button","game-choice-card"+(selected===g.id?" selected":""));card.type="button";card.disabled=!host;card.append(el("b","",g.icon+"  "+g.name),el("small","",g.description));if(host)card.addEventListener("click",()=>gameEvent("city:game:choose",{game:g.id},()=>{selectingGame=false}));grid.appendChild(card)});screen.appendChild(grid);
      if(!host)status(screen,"Waiting for the inviter to choose…");
    }else{
      const chosen=games.find(g=>g.id===selected);resultBox(screen,chosen.icon+"  "+chosen.name,chosen.description);
      const actions=el("div","game-actions");
      if(host){actions.appendChild(btn("Start together ▶",()=>gameEvent("city:game:start",{}),"primary"));actions.appendChild(btn("Choose a different game",()=>{selectingGame=true;renderCityGame()}));}
      else status(screen,"The inviter will start when you’re both ready.");screen.appendChild(actions);
    }
  }
  function finalActions(parent){
    if(match.status!=="finished")return;
    const actions=el("div","game-actions"),me=currentPlayerId(),votes=match.rematchVotes||[];
    const rematch=btn(votes.includes(me)?"Waiting for rematch…":"🔁 Rematch",()=>gameEvent("city:game:rematch",{}),"primary",votes.includes(me));actions.appendChild(rematch);
    if(me===match.hostId)actions.appendChild(btn("🎮 Choose another game",()=>gameEvent("city:game:switch",{})));
    actions.appendChild(btn("Return to the city",leaveMatch));parent.appendChild(actions);
  }
  function renderTtt(){
    const s=match.state,me=currentPlayerId();heading(screen,"Tic-Tac-Toe","X and O take turns. First to make a line wins.");
    const board=el("div","game-board"),myMark=s.marks[me];
    if(s.winnerId)resultBox(screen,"Round complete",match.result&&match.result.text||"A player won.");else if(s.draw)resultBox(screen,"Draw","The board is full.");
    else status(screen,s.turnId===me?"Your turn · "+myMark:"Their turn · "+s.marks[s.turnId]);
    s.board.forEach((mark,index)=>{const cell=el("button","game-cell"+(mark==="O"?" mark-o":"")+(mark?" mark-animate":""),mark||"");cell.type="button";cell.disabled=match.status!=="playing"||!!mark||s.turnId!==me;cell.setAttribute("aria-label",mark?"Square "+(index+1)+" marked "+mark:"Empty square "+(index+1));cell.addEventListener("click",()=>gameEvent("city:game:action",{type:"move",index}));board.appendChild(cell)});
    screen.appendChild(board);finalActions(screen);
  }
  function renderMath(){
    const s=match.state,me=currentPlayerId();heading(screen,"Math Duel","Same problem for both players · first correct answer earns a speed point.");scoreline(screen,s);
    if(s.stage==="answering"&&match.status==="playing"){
      status(screen,"Round "+s.round+" / "+s.totalRounds);screen.appendChild(el("p","game-question",s.question));addCountdown(screen,s.deadlineAt);
      const locked=!!s.mySubmitted,form=el("form","game-input"),input=el("input");form.setAttribute("data-enter-submit","");input.enterKeyHint="done";input.type="number";input.step="1";input.inputMode="numeric";input.placeholder="Your answer";input.disabled=locked;input.setAttribute("aria-label","Your answer");
      const submit=btn(locked?"Locked ✓":"Submit",e=>{},"primary",locked);submit.type="submit";form.addEventListener("submit",e=>{e.preventDefault();if(input.value.trim())gameEvent("city:game:action",{type:"answer",answer:input.value.trim()})});form.append(input,submit);screen.appendChild(form);
      const other=match.players.find(p=>p.id!==me);status(screen,locked?"Your answer is locked.":(s.locked&&s.locked[other.id]?other.name+" has answered.":"Waiting for both answers…"));
    }else{
      resultBox(screen,"Answer: "+s.answer,s.result&&s.result.correctBy.length?s.result.correctBy.map(id=>match.players.find(p=>p.id===id)?.name+" +"+s.result.points[id]).join("  ·  "):"No correct answers this round.");
      if(match.status==="finished"){resultBox(screen,match.result&&match.result.text||"Math Duel finished.","Final score · "+match.players.map(p=>p.name+" "+(s.scores[p.id]||0)).join("  ·  "));finalActions(screen)}else status(screen,"Next round starting…");
    }
  }
  function renderRps(){
    const s=match.state,me=currentPlayerId();heading(screen,"Rock · Paper · Scissors","Best of three · choices stay secret until both lock in.");scoreline(screen,s);
    if(s.stage==="choosing"&&match.status==="playing"){
      status(screen,"Round "+s.round+" / 3");addCountdown(screen,s.deadlineAt);
      const choices=[["rock","✊","Rock"],["paper","✋","Paper"],["scissors","✌️","Scissors"]],row=el("div","game-rps"),locked=!!s.myLocked;
      choices.forEach(([id,icon,label])=>{const b=el("button",s.myChoice===id?"selected":"");b.type="button";b.disabled=locked;b.append(el("span","",icon),el("small","",label));b.addEventListener("click",()=>gameEvent("city:game:action",{type:"choose",choice:id}));row.appendChild(b)});screen.appendChild(row);
      const other=match.players.find(p=>p.id!==me);status(screen,locked?"Choice locked 🔒 · waiting for reveal.":(s.locked&&s.locked[other.id]?other.name+" has locked a choice.":"Choose secretly before the timer ends."));
    }else{
      const symbols={rock:"✊ Rock",paper:"✋ Paper",scissors:"✌️ Scissors"},choices=s.choices||{};
      resultBox(screen,s.result&&s.result.winnerId?match.players.find(p=>p.id===s.result.winnerId)?.name+" wins the round":s.result&&s.result.forfeit?"Round won by timeout":"Round tied",match.players.map(p=>p.name+": "+(choices[p.id]?symbols[choices[p.id]]:"No choice")).join("  ·  "));
      if(match.status==="finished"){resultBox(screen,match.result&&match.result.text||"Match complete",match.players.map(p=>p.name+" "+s.scores[p.id]).join("  ·  "));finalActions(screen)}else status(screen,"Next round starting…");
    }
  }
  function renderQuiz(){
    const s=match.state,me=currentPlayerId();heading(screen,"Four-Answer Quiz Duel",s.category+" · both players get the same question.");scoreline(screen,s);
    if(s.stage==="answering"&&match.status==="playing"){
      status(screen,"Question "+s.round+" / "+s.totalRounds);screen.appendChild(el("p","game-question",s.question));addCountdown(screen,s.deadlineAt);
      const list=el("div","game-answer-list"),myAnswer=s.myAnswer,locked=myAnswer!==null;
      s.options.forEach((option,index)=>{const b=el("button","game-answer",String.fromCharCode(65+index)+" · "+option);b.type="button";b.disabled=locked;b.addEventListener("click",()=>gameEvent("city:game:action",{type:"answer",answer:index}));list.appendChild(b)});screen.appendChild(list);
      const other=match.players.find(p=>p.id!==me);status(screen,locked?"Your answer is locked.":(s.locked&&s.locked[other.id]?other.name+" has answered.":"Choose A, B, C, or D."));
    }else{
      const answer=s.correctIndex,answers=s.result&&s.result.answers||{};const list=el("div","game-answer-list");s.options.forEach((option,index)=>{const cls="game-answer"+(index===answer?" correct":"")+(answers[me]===index&&index!==answer?" wrong":"");const b=el("div",cls,String.fromCharCode(65+index)+" · "+option);list.appendChild(b)});screen.appendChild(list);
      resultBox(screen,"Correct answer: "+String.fromCharCode(65+answer),s.result&&s.result.correctBy.length?s.result.correctBy.map(id=>match.players.find(p=>p.id===id)?.name+" +"+s.result.points[id]).join("  ·  "):"No points this question.");
      if(match.status==="finished"){scoreline(screen,s);resultBox(screen,match.result&&match.result.text||"Quiz complete","Final score");finalActions(screen)}else status(screen,"Next question starting…");
    }
  }
  function destroyArcadeRun(){
    if(arcadeRun&&arcadeRun.destroy)arcadeRun.destroy();
    arcadeRun=null;arcadeRunNode=null;arcadeRunKey="";
  }
  function renderArcadeRace(){
    const game=games.find(g=>g.id===match.game),s=match.state,me=currentPlayerId();
    heading(screen,game?game.icon+"  "+game.name:"ARCADE RACE","Both players get the same 60-second run. Highest score wins.");
    scoreline(screen,s);
    const records=(match.players||[]).map(p=>p.name+" record: "+(p.arcadeRecord||0)).join("  ·  ");
    status(screen,records);
    if(match.status==="playing"){
      if(s.mySubmitted)status(screen,"Your score is locked. Waiting for your rival…");
      else addCountdown(screen,s.deadlineAt);
      const key=match.id+"|"+match.game+"|"+s.deadlineAt;
      if(arcadeRunKey!==key){
        destroyArcadeRun();
        arcadeRunKey=key;arcadeRunNode=el("div","arcade-race-surface");
        if(window.GaicaniArcadeGames){
          arcadeRun=window.GaicaniArcadeGames.mount(match.game,arcadeRunNode,{deadlineAt:s.deadlineAt,onFinish:score=>gameEvent("city:game:action",{type:"submitScore",score})});
        }else status(screen,"Arcade game controls could not load.");
      }
      if(arcadeRunNode)screen.appendChild(arcadeRunNode);
    }else if(match.status==="finished"){
      const scores=match.result&&match.result.scores||s.scores||{};
      resultBox(screen,match.result&&match.result.text||"Score race complete.",match.players.map(p=>p.name+": "+(scores[p.id]||0)+" · record "+(p.arcadeRecord||0)).join("  —  "));
      finalActions(screen);
    }
  }
  function renderCityGame(){
    if(!match){destroyArcadeRun();dimmer.hidden=true;phone.hidden=true;phone.classList.remove("arcade-match");phoneKicker.textContent="GAICANI MOBILE";phoneFooter.hidden=false;return;}
    dimmer.hidden=false;phone.hidden=false;renderInviteStatusLine(playersLine,match);
    phone.classList.toggle("arcade-match",!!match.arcadeMode);phoneKicker.textContent=match.arcadeMode?"PIXEL PALACE · CABINET DUEL":"GAICANI MOBILE";phoneFooter.hidden=!!match.arcadeMode;
    title.textContent=match.game?gameNames[match.game]||"NEON GAMES":"NEON GAMES";screen.replaceChildren();
    if(match.status==="lobby"||!match.game)lobbyView();
    else if(match.game==="ttt")renderTtt();
    else if(match.game==="math")renderMath();
    else if(match.game==="rps")renderRps();
    else if(match.game==="quiz")renderQuiz();
    else if(match.arcadeMode&&games.some(g=>g.id===match.game&&g.arcade))renderArcadeRace();
    else destroyArcadeRun();
  }
  function leaveMatch(){if(match)socket.emit("city:game:leave",{matchId:match.id});}
  document.getElementById("cityGameClose").addEventListener("click",leaveMatch);
  document.querySelectorAll("[data-game-reaction]").forEach(b=>b.addEventListener("click",()=>{if(match)gameEvent("city:game:reaction",{text:b.dataset.gameReaction})}));
  function showReaction(data){if(!match||data.matchId!==match.id)return;reaction.textContent=data.name+" · "+data.text;reaction.hidden=false;clearTimeout(reactionTimer);reactionTimer=setTimeout(()=>reaction.hidden=true,2300);bridge.cue(640)}
  socket.on("auth:authenticated",u=>{accountBlocks=new Set((u&&u.blockedUsers||[]).map(x=>String(x).toLowerCase()));updatePlayerCard()});
  socket.on("city:joined",d=>{sessionBlocks=new Set((d&&d.gameBlockedPlayers||[]).map(x=>String(x).toLowerCase()));updatePlayerCard()});
  socket.on("city:game:blocks",list=>{sessionBlocks=new Set((list||[]).map(x=>String(x).toLowerCase()));updatePlayerCard()});
  socket.on("city:game:inviteRequest",d=>showInvite({kind:"incoming",inviteId:d.inviteId,fromId:d.fromId,fromName:d.fromName,arcadeMode:!!d.arcadeMode}));
  socket.on("city:game:invitePending",d=>showInvite({kind:"outgoing",inviteId:d.inviteId,toName:d.toName,arcadeMode:!!d.arcadeMode}));
  socket.on("city:game:inviteDeclined",d=>{if(invitation&&invitation.inviteId===d.inviteId)hideInvite();bridge.toast((d.playerName||"Player")+" declined the game invitation.")});
  socket.on("city:game:inviteCancelled",d=>{if(invitation&&(!d.inviteId||invitation.inviteId===d.inviteId)){hideInvite();if(d.message)bridge.toast(d.message)}});
  socket.on("city:game:started",data=>{hideInvite();match=data;selectingGame=false;reaction.hidden=true;renderCityGame()});
  socket.on("city:game:update",data=>{if(match&&data&&data.id===match.id){match=data;if(match.status!=="lobby")selectingGame=false;renderCityGame()}});
  socket.on("city:game:reaction",showReaction);
  socket.on("city:game:ended",d=>{if(match&&(!d||!d.matchId||d.matchId===match.id)){match=null;selectingGame=false;renderCityGame();if(d&&d.message)bridge.toast(d.message)}});
  socket.on("disconnect",()=>{match=null;hideInvite();renderCityGame();updatePlayerCard()});
  window.addEventListener("keydown",e=>{if(e.key==="Escape"){if(invitation){if(invitation.kind==="incoming")socket.emit("city:game:inviteRespond",{inviteId:invitation.inviteId,accept:false});else if(invitation.inviteId)socket.emit("city:game:inviteCancel",{inviteId:invitation.inviteId});hideInvite()}else if(match)leaveMatch()}});
  setInterval(updateCountdowns,250);
  window.GaicaniCityGames={get active(){return !!match},get blocksMovement(){return !!match||!!invitation},updatePlayerCard,renderCityGame,inviteArcade};
})();
