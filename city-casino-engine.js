"use strict";

const crypto = require("crypto");

const BET_OPTIONS = [10, 20, 50, 100];
const HISTORY_LIMIT = 200;
const BONUS_SPIN_LIMIT = 3;
const PAIR_MULTIPLIER = 1.2;
const MACHINE_DEFINITIONS = {
  tbilisi: {
    id:"tbilisi", name:"ნეონის თბილისი", subtitle:"თბილისის ნეონი", icon:"🌃", color:"#ff5acb",
    description:"ღამის ტაქსი, თბილი ჭიქა და მტკვრის სანაპიროს განათებები.",
    symbols:[
      {icon:"🌙",label:"შუაღამე",weight:40,multiplier:1},
      {icon:"🍷",label:"მარნის ღვინო",weight:25,multiplier:2},
      {icon:"🏔️",label:"მთაწმინდა",weight:16,multiplier:3},
      {icon:"🚕",label:"ძველი ტაქსი",weight:9,multiplier:4},
      {icon:"💜",label:"ნეონის გული",weight:6,multiplier:8},
      {icon:"💎",label:"ნარიყალას სამკაული",weight:4,multiplier:25,bonus:true}
    ]
  },
  internet: {
    id:"internet", name:"რეტრო ინტერნეტკაფე", subtitle:"ინტერნეტ კაფე 1999", icon:"💾", color:"#64e8ff",
    description:"დისკეტები, დიდი მონიტორები და ბოლო სატელეფონო ინტერნეტკავშირი.",
    symbols:[
      {icon:"📟",label:"პეიჯერი",weight:40,multiplier:1},
      {icon:"💾",label:"დისკეტა",weight:25,multiplier:2},
      {icon:"🖥️",label:"ძველი კომპიუტერი",weight:16,multiplier:3},
      {icon:"🕹️",label:"არკადის ჯოისტიკი",weight:9,multiplier:4},
      {icon:"👾",label:"პიქსელური უცხოპლანეტელი",weight:6,multiplier:8},
      {icon:"📡",label:"იშვიათი სიგნალი",weight:4,multiplier:25,bonus:true}
    ]
  },
  cat: {
    id:"cat", name:"იღბლიანი კატა", subtitle:"ფისოს იღბლიანი კუთხე", icon:"🐈", color:"#ffc66f",
    description:"ეზოს კატამ ხავერდის სკამი და საოცრად იღბლიანი თათი იპოვა.",
    symbols:[
      {icon:"🐾",label:"თათის კვალი",weight:40,multiplier:1},
      {icon:"🧶",label:"ძაფის გორგალი",weight:25,multiplier:2},
      {icon:"🐟",label:"ხინკლის თევზი",weight:16,multiplier:3},
      {icon:"🐈",label:"იღბლიანი კატა",weight:9,multiplier:4},
      {icon:"🪙",label:"ოქროს მონეტა",weight:6,multiplier:8},
      {icon:"🌟",label:"ვარსკვლავის თათი",weight:4,multiplier:25,bonus:true}
    ]
  },
  express: {
    id:"express", name:"შუაღამის ექსპრესი", subtitle:"შუაღამის ექსპრესი", icon:"🚘", color:"#9d8bff",
    description:"ბოლო მგზავრობა სველ ქუჩებში, სანამ ქალაქი გაიღვიძებს.",
    symbols:[
      {icon:"🚦",label:"შუქნიშანი",weight:40,multiplier:1},
      {icon:"🚕",label:"ტაქსი",weight:25,multiplier:2},
      {icon:"🚗",label:"ნეონის მანქანა",weight:16,multiplier:3},
      {icon:"🌉",label:"მდინარის ხიდი",weight:9,multiplier:4},
      {icon:"🏁",label:"ფინიშის დროშა",weight:6,multiplier:8},
      {icon:"🎟️",label:"ბოლო ბილეთი",weight:4,multiplier:25,bonus:true}
    ]
  }
};

function createCityCasinoEngine({ io, registeredUsers, spendableCoins, ensureCoins, settlePendingCoins, changeCoins, saveAuthUsers, syncCoinSeat, randomInt = crypto.randomInt, georgiaDay }) {
  const machines = MACHINE_DEFINITIONS;
  const accountFor = socket => {
    const identity = socket && socket._regUser;
    if (!identity || identity.isGuest || !identity.usernameLower) return null;
    const user = registeredUsers.get(identity.usernameLower);
    return user && !user.isGuest ? { user, lc:identity.usernameLower } : null;
  };
  const publicMachines = () => Object.values(machines).map(m => ({
    id:m.id,name:m.name,subtitle:m.subtitle,icon:m.icon,color:m.color,description:m.description,
    pairMultiplier:PAIR_MULTIPLIER,
    symbols:m.symbols.map(s => ({ icon:s.icon,label:s.label,weight:s.weight,multiplier:s.multiplier,bonus:!!s.bonus }))
  }));
  function featuredId() {
    const day = typeof georgiaDay === "function" ? georgiaDay() : new Date().toISOString().slice(0,10);
    let hash = 0;
    for (const ch of day) hash = (Math.imul(hash,31) + ch.charCodeAt(0)) | 0;
    const list = Object.keys(machines);
    return list[(hash >>> 0) % list.length];
  }
  function publicLeaderboard() {
    return Array.from(registeredUsers.values())
      .filter(u => u && !u.isGuest && Number.isFinite(u.casinoNet) && u.casinoNet > 0)
      .sort((a,b) => (b.casinoNet||0) - (a.casinoNet||0))
      .slice(0,10)
      .map(u => ({ username:u.username, netWon:Math.floor(u.casinoNet) }));
  }
  function ensureNonce(user) {
    if (!user.casinoSpinNonce) {
      user.casinoSpinNonce = crypto.randomUUID();
      saveAuthUsers();
    }
  }
  function coinState(user, lc) {
    return Number.isFinite(user.coins) ? spendableCoins(user,lc) : ensureCoins(user);
  }
  function stateFor(user, lc, registered = true) {
    if (!registered) return {
      registered:false,coins:null,machines:publicMachines(),betOptions:BET_OPTIONS.slice(),pairMultiplier:PAIR_MULTIPLIER,
      featuredMachineId:featuredId(),leaderboard:publicLeaderboard(),history:[],bonusSpins:0,bonusBet:0,
      disclaimer:"მონეტები მხოლოდ ვირტუალური სათამაშო ქულებია. მათ ფულადი ღირებულება არ აქვთ და ფულით ვერ იყიდი ან გადაცვლი."
    };
    settlePendingCoins(user,lc);
    ensureCoins(user);
    ensureNonce(user);
    return {
      registered:true,coins:coinState(user,lc),nonce:user.casinoSpinNonce,machines:publicMachines(),betOptions:BET_OPTIONS.slice(),
      pairMultiplier:PAIR_MULTIPLIER,featuredMachineId:featuredId(),leaderboard:publicLeaderboard(),
      history:Array.isArray(user.casinoTransactions)?user.casinoTransactions.slice(-30).reverse():[],
      bonusSpins:Math.max(0,Math.floor(user.casinoBonusSpins||0)),bonusBet:Math.max(0,Math.floor(user.casinoBonusBet||0)),
      disclaimer:"მონეტები მხოლოდ ვირტუალური სათამაშო ქულებია. მათ ფულადი ღირებულება არ აქვთ და ფულით ვერ იყიდი ან გადაცვლი."
    };
  }
  function reply(ack, payload) { if (typeof ack === "function") ack(payload); }
  function pickSymbol(machine) {
    const total = machine.symbols.reduce((sum,s) => sum+s.weight,0);
    let n = randomInt(total);
    for (const symbol of machine.symbols) { n -= symbol.weight; if (n < 0) return symbol; }
    return machine.symbols[machine.symbols.length-1];
  }
  function resolveSpin(machine, stake) {
    const drawn = [pickSymbol(machine),pickSymbol(machine),pickSymbol(machine)];
    const counts = new Map();
    for (const s of drawn) counts.set(s.icon,(counts.get(s.icon)||0)+1);
    const triple = drawn[0].icon===drawn[1].icon && drawn[1].icon===drawn[2].icon;
    let pair = false, multiplier = 0, bonus = false;
    if (triple) {
      multiplier = drawn[0].multiplier;
      bonus = !!drawn[0].bonus;
    } else {
      pair = Array.from(counts.values()).some(n => n===2);
      if (pair) multiplier = PAIR_MULTIPLIER;
    }
    const payout = multiplier ? Math.floor(stake*multiplier) : 0;
    return { symbols:drawn.map(s=>s.icon),labels:drawn.map(s=>s.label),triple,pair,multiplier,payout,bonus };
  }
  function syncCoinChange(lc, user, seat) {
    if (seat && typeof syncCoinSeat === "function") syncCoinSeat(seat);
    io.to("user:"+lc).emit("coins:changed",{coins:spendableCoins(user,lc)});
  }
  function stateResponse(user,lc,transaction,extra = {}) {
    return {
      ok:true,duplicate:!!extra.duplicate,transaction,
      coins:spendableCoins(user,lc),nonce:user.casinoSpinNonce,
      bonusSpins:Math.max(0,Math.floor(user.casinoBonusSpins||0)),bonusBet:Math.max(0,Math.floor(user.casinoBonusBet||0)),
      leaderboard:publicLeaderboard()
    };
  }
  function spin(socket, data, ack) {
    const account=accountFor(socket);
    if (!account) return reply(ack,{error:"ვირტუალური მონეტებით სათამაშოდ დარეგისტრირდი ან შედი ანგარიშში. კაზინოს დათვალიერება ახლაც შეგიძლია."});
    const {user,lc}=account;
    const requestId=data&&typeof data.requestId==="string"?data.requestId:"";
    if (!/^[a-f0-9-]{36}$/i.test(requestId)) return reply(ack,{error:"დატრიალების მოთხოვნა არასწორია. სცადე ხელახლა."});
    const machine=machines[data&&data.machineId];
    if (!machine) return reply(ack,{error:"ეს აპარატი მიუწვდომელია."});
    const last=user.casinoLastSpin;
    if (last && last.requestId===requestId) {
      if (last.machineId!==machine.id || last.bet!==(data.freeSpin?0:data.bet) || !!last.freeSpin!==!!data.freeSpin)
        return reply(ack,{error:"ეს დატრიალება სხვა მოთხოვნისთვის უკვე გამოყენებულია."});
      return reply(ack,stateResponse(user,lc,last,{duplicate:true}));
    }
    ensureNonce(user);
    if (typeof data.nonce!=="string" || data.nonce!==user.casinoSpinNonce)
      return reply(ack,{error:"დატრიალების ვადა გავიდა. განაახლე ბალანსი და სცადე ხელახლა."});
    const now=Date.now();
    if (now-(user.casinoLastSpinAt||0)<650) return reply(ack,{error:"დაელოდე მიმდინარე დატრიალების დასრულებას."});

    const freeSpin=data.freeSpin===true;
    let bet,stake;
    if (freeSpin) {
      if (data.bet!==0 || (user.casinoBonusSpins||0)<1 || !Number.isInteger(user.casinoBonusBet) || user.casinoBonusBet<10)
        return reply(ack,{error:"ბონუს დატრიალება ჯერ არ არის მზად."});
      bet=0;stake=user.casinoBonusBet;
    } else {
      bet=data.bet;
      if (!Number.isInteger(bet) || !BET_OPTIONS.includes(bet)) return reply(ack,{error:"აირჩიე სიაში მოცემული ფსონი."});
      stake=bet;
    }
    settlePendingCoins(user,lc);
    ensureCoins(user);
    const balance=spendableCoins(user,lc);
    if (balance<bet) return reply(ack,{error:"ამ ფსონისთვის საკმარისი მონეტა არ გაქვს."});

    const result=resolveSpin(machine,stake);
    if (freeSpin) user.casinoBonusSpins=Math.max(0,(user.casinoBonusSpins||0)-1);
    if (result.bonus) {
      user.casinoBonusSpins=Math.min(BONUS_SPIN_LIMIT,(user.casinoBonusSpins||0)+1);
      user.casinoBonusBet=Math.max(user.casinoBonusBet||0,stake);
    }
    const net=result.payout-bet;
    const transaction={
      requestId,machineId:machine.id,machineName:machine.name,bet,stake,payout:result.payout,net,
      symbols:result.symbols,labels:result.labels,multiplier:result.multiplier,pair:result.pair,triple:result.triple,
      bonus:result.bonus,freeSpin,at:now
    };
    // Synchronous Node event handling makes the balance, table stack, ledger,
    // and nonce rotation one indivisible operation relative to other spins.
    const seat=changeCoins(user,lc,net,{save:false,broadcast:false});
    user.casinoLastSpinAt=now;
    user.casinoTotalWagered=(user.casinoTotalWagered||0)+bet;
    user.casinoTotalPayout=(user.casinoTotalPayout||0)+result.payout;
    user.casinoNet=(user.casinoNet||0)+net;
    if (!Array.isArray(user.casinoTransactions)) user.casinoTransactions=[];
    user.casinoTransactions.push(transaction);
    if (user.casinoTransactions.length>HISTORY_LIMIT) user.casinoTransactions.splice(0,user.casinoTransactions.length-HISTORY_LIMIT);
    user.casinoSpinNonce=crypto.randomUUID();
    user.casinoLastSpin=transaction;
    saveAuthUsers();
    syncCoinChange(lc,user,seat);
    reply(ack,stateResponse(user,lc,transaction));
  }
  function bind(socket) {
    socket.on("casino:state",(_data,ack)=>{
      const account=accountFor(socket);
      reply(ack,account?stateFor(account.user,account.lc,true):stateFor(null,null,false));
    });
    socket.on("casino:spin",(data,ack)=>spin(socket,data||{},ack));
  }
  return { bind, definitions:MACHINE_DEFINITIONS, betOptions:BET_OPTIONS.slice() };
}

module.exports = { createCityCasinoEngine, MACHINE_DEFINITIONS, BET_OPTIONS };
