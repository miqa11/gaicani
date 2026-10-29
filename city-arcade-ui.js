(function () {
  "use strict";
  const bridge=window.GaicaniCityGameBridge;
  if(!bridge)return;
  const socket=bridge.getSocket();
  const panel=document.getElementById("cityArcadePanel");
  const content=document.getElementById("cityArcadeContent");
  const tabs=Array.from(document.querySelectorAll("[data-arcade-tab]"));
  const games=[
    {id:"pacman",name:"პაკმენი",icon:"ᗧ",copy:"შეაგროვე წერტილები, აირიდე მოჩვენებები და მოხსენი რეკორდი."},
    {id:"snake",name:"გველი",icon:"🐍",copy:"შეაგროვე მანათობელი პიქსელები. საკუთარ კუდს არ შეეჯახო."},
    {id:"tetris",name:"ტეტრისი",icon:"🟦",copy:"აბრუნე ჩამომავალი ბლოკები და გაასუფთავე სრული ხაზები."},
    {id:"pong",name:"პონგი",icon:"🏓",copy:"მოიგერიე ბურთი და დაამარცხე მეტოქე."}
  ];
  const gameNames=Object.fromEntries(games.map(g=>[g.id,g.name]));
  let tab="games",records=null,soloGame=null,soloScore=null,soloRecord=null,run=null,runNode=null,runKey="",requestInFlight=false,lastRecordsAt=0;

  function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
  function destroyRun(){if(run&&run.destroy)run.destroy();run=null;runNode=null;runKey=""}
  function requestRecords(){
    if(requestInFlight||!socket)return;
    requestInFlight=true;
    socket.emit("city:arcade:records",{},result=>{
      requestInFlight=false;
      if(result&&result.error){bridge.toast(result.error);return}
      records=result||null;
      lastRecordsAt=Date.now();
      if(!panel.hidden)render();
    });
  }
  function recordScore(game,score){
    if(!socket){soloRecord=null;return}
    socket.emit("city:arcade:record",{game,score},result=>{
      if(result&&result.error){bridge.toast(result.error);soloRecord=null;return}
      records=result.records||records;
      soloRecord=result.record&&result.record.score||score;
      render();
    });
  }
  function changeTab(next){
    if(tab!==next){destroyRun();soloGame=null;soloScore=null;soloRecord=null}
    tab=next;
    tabs.forEach(button=>button.classList.toggle("active",button.dataset.arcadeTab===tab));
    render();
    if((tab==="records"||tab==="versus")&&!records)requestRecords();
  }
  function renderGames(){
    content.appendChild(el("p","arcade-welcome","აირჩიე განათებული აპარატი და ითამაშე შენს მოწყობილობაზე. შეჯიბრისთვის მოიწვიე ამავე არკადაში მყოფი მოთამაშე და შეადარეთ ქულები და რეკორდები."));
    const grid=el("div","arcade-games-grid");
    games.forEach(game=>{
      const card=el("article","arcade-game-card");
      card.append(el("h3","",game.icon+"  "+game.name),el("p","",game.copy));
      const play=el("button","", "▶ თამაში");
      play.type="button";play.addEventListener("click",()=>startSolo(game.id));card.appendChild(play);
      const best=records&&records.ownRecords&&records.ownRecords[game.id];
      card.appendChild(el("small","arcade-best",best?"პირადი რეკორდი · "+best.score:"პირადი რეკორდი · —"));
      grid.appendChild(card);
    });
    content.appendChild(grid);
  }
  function startSolo(game){
    destroyRun();soloGame=game;soloScore=null;soloRecord=null;render();
  }
  function renderSolo(){
    const game=games.find(g=>g.id===soloGame);
    const back=el("button","arcade-back-button","← ყველა აპარატი");
    back.type="button";back.addEventListener("click",()=>{destroyRun();soloGame=null;soloScore=null;soloRecord=null;render()});
    content.appendChild(back);
    content.appendChild(el("h3","arcade-section-title",game.icon+"  "+game.name+" აპარატი"));
    content.appendChild(el("p","arcade-copy","კომპიუტერზე გამოიყენე ისრები ან მოძრაობის კლავიშები; ტელეფონზე — ეკრანის ღილაკები."));
    if(soloScore!==null){
      const result=el("section","arcade-record-group");
      result.append(el("h4","", "ცდა დასრულდა"),el("p","arcade-copy","ქულა · "+soloScore+(soloRecord!==null?"  ✦  პირადი რეკორდი · "+soloRecord:"")));
      const again=el("button","arcade-back-button","ხელახლა თამაში");
      again.type="button";again.addEventListener("click",()=>startSolo(soloGame));result.appendChild(again);content.appendChild(result);return;
    }
    if(!runNode){
      runKey="solo|"+soloGame+"|"+Date.now();
      runNode=el("div","arcade-solo-surface");
      if(window.GaicaniArcadeGames)run=window.GaicaniArcadeGames.mount(soloGame,runNode,{durationMs:60000,onFinish:score=>{
        const gameId=soloGame;soloScore=score;destroyRun();recordScore(gameId,score);render();
      }});
    }
    content.appendChild(runNode);
  }
  function renderRecords(){
    content.appendChild(el("h3","arcade-section-title","🏆 საუკეთესო მოთამაშეები"));
    content.appendChild(el("p","arcade-copy","შენი და მთელი ქალაქის საუკეთესო შედეგები. რეგისტრირებული ანგარიშის რეკორდები ვიზიტებს შორის ინახება."));
    const reload=el("button","arcade-back-button",records?"↻ რეკორდების განახლება":"რეკორდების ჩატვირთვა");
    reload.type="button";reload.addEventListener("click",requestRecords);content.appendChild(reload);
    if(!records){content.appendChild(el("div","arcade-empty","ქალაქის რეკორდები იტვირთება…"));return}
    games.forEach(game=>{
      const group=el("section","arcade-record-group");
      const personal=records.ownRecords&&records.ownRecords[game.id];
      group.appendChild(el("h4","",game.icon+"  "+game.name+"  ·  საუკეთესო "+(personal?personal.score:"—")));
      const leaders=records.leaderboards&&records.leaderboards[game.id]||[];
      if(!leaders.length)group.appendChild(el("div","arcade-empty","რეკორდები ჯერ არ არის. იყავი პირველი!"));
      leaders.slice(0,5).forEach((row,index)=>group.appendChild(el("div","arcade-record-row",(index+1)+". "+row.username+"  ·  "+row.score)));
      content.appendChild(group);
    });
  }
  function playerRecordSummary(player){
    const entry=(records&&records.players||[]).find(p=>p.id===player.id);
    if(!entry)return "რეკორდები არკადის სიის განახლების შემდეგ გამოჩნდება.";
    return games.map(game=>game.name+" "+(entry.records&&entry.records[game.id]?entry.records[game.id].score:"—")).join("  ·  ");
  }
  function renderVersus(){
    content.appendChild(el("h3","arcade-section-title","⚔️ აპარატების შეჯიბრი"));
    content.appendChild(el("p","arcade-copy","Choose someone standing in Pixel Palace. You both play the same 60-second cabinet run; the higher score wins, and your best scores stay on the record board."));
    const self=bridge.getSelf(),players=bridge.getPlayers?bridge.getPlayers():[];
    const rivals=players.filter(p=>p.id!==self?.id&&p.interiorId==="arcade-palace"&&!p.gameId);
    if(!rivals.length){content.appendChild(el("div","arcade-empty","No rival here yet. Invite a friend to the city and meet inside this arcade; they’ll appear here."));return}
    const list=el("div","arcade-challenge-list");
    rivals.forEach(player=>{
      const row=el("div","arcade-challenge-row"),info=el("div");
      info.append(el("strong","",player.name),el("small","",playerRecordSummary(player)));
      const challenge=el("button","", "⚔️ გამოწვევა");
      challenge.type="button";challenge.addEventListener("click",()=>window.GaicaniCityGames?.inviteArcade(player.id));
      row.append(info,challenge);list.appendChild(row);
    });
    content.appendChild(list);
  }
  function render(){
    if(panel.hidden)return;
    tabs.forEach(button=>button.classList.toggle("active",button.dataset.arcadeTab===tab));
    content.replaceChildren();
    if(tab==="games"){if(soloGame)renderSolo();else renderGames()}
    else if(tab==="records")renderRecords();
    else renderVersus();
  }
  function open(){panel.hidden=false;render();requestRecords()}
  function close(){panel.hidden=true;destroyRun();soloGame=null;soloScore=null;soloRecord=null}
  document.getElementById("cityArcadeExit").addEventListener("click",()=>document.getElementById("interiorExit").click());
  tabs.forEach(button=>button.addEventListener("click",()=>changeTab(button.dataset.arcadeTab)));
  socket.on("city:arcade:recordsChanged",()=>{if(!panel.hidden)requestRecords()});
  setInterval(()=>{if(!panel.hidden&&tab==="versus"){renderVersus();if(Date.now()-lastRecordsAt>5000)requestRecords()}},1400);
  window.GaicaniArcadeUI={open,close,get blocksMovement(){return !panel.hidden}};
})();
