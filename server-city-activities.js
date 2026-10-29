"use strict";
const crypto = require("node:crypto");

function createCityActivities(options) {
  const {world, players, garage, registeredUsers = new Map(), io, saveAuthUsers = () => {},
    ensureCoins = user => user.coins ||= 0, spendableCoins = user => user.coins || 0,
    changeCoins = (user, _key, delta) => {user.coins = (user.coins || 0) + delta;},
    cleanText = value => String(value || "").trim().slice(0,120), blockedText = () => false,
    now = Date.now, randomInt = crypto.randomInt} = options;
  const data = options.catalog || require("./city-activities-data.js");
  const definitions = new Map(data.activities.map(a => [a.id,a]));
  const items = new Map((data.items || []).map(item => [item.id,item]));
  const handlers = new Map(), sessions = new Map(), guests = new Map(), requests = new Map(), rate = new Map();
  const tracked = new Map(), results = new Map(), observed = new Map(), lastPush = new Map();
  const rooms = new Map(), boards = new Map();
  const DAILY_LIMIT = 600, MAX_STACK = 999;
  const key = p => String(p?.userKey || "").toLowerCase();
  const userFor = p => {const user=registeredUsers.get(key(p));return user&&!user.isGuest?user:null;};
  const blocked = (a,b) => !!(registeredUsers.get(key(a))?.blockedUsers?.includes(key(b))||registeredUsers.get(key(b))?.blockedUsers?.includes(key(a)));
  const cleanId = id => typeof id === "string" && /^[a-zA-Z0-9:_-]{1,80}$/.test(id);
  const copy = value => JSON.parse(JSON.stringify(value));
  const day = () => new Date(now() + 4*3600000).toISOString().slice(0,10);
  function profile(p) {
    const user = userFor(p);
    let value = user ? user.cityActivities : guests.get(p.id);
    if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
    for (const field of ["inventory","collection","claims","cooldowns","relationships","privacy","records"])
      if (!value[field] || typeof value[field] !== "object" || Array.isArray(value[field])) value[field] = {};
    if (!value.earned || value.earned.day !== day()) value.earned = {day:day(),coins:0};
    value.privacy.photos = value.privacy.photos === true;
    value.version = 1;
    if (user) user.cityActivities = value; else guests.set(p.id,value);
    return value;
  }
  function persist(p) {if(userFor(p)) saveAuthUsers();}
  function coinChange(p, amount) {
    const user = userFor(p); if(!user) return 0;
    ensureCoins(user); changeCoins(user,key(p),amount,{save:false});
    io?.to("user:"+key(p)).emit("coins:changed",{coins:spendableCoins(user,key(p))});
    return amount;
  }
  function addItem(p,id,count=1) {
    if(!items.has(id)||!Number.isSafeInteger(count)||count<1||count>20) throw Error("Invalid activity item");
    const pr=profile(p), old=Math.max(0,pr.inventory[id]||0);
    if(old+count>MAX_STACK) return false;
    pr.inventory[id]=old+count;
    const previous=pr.collection[id];pr.collection[id]={count:Math.min(100000,(previous?.count||0)+count),firstAt:previous?.firstAt||now()};
    persist(p); return true;
  }
  function reward(p,amount,onceKey) {
    const pr=profile(p);if(onceKey&&pr.claims[onceKey])return 0;
    if(onceKey)pr.claims[onceKey]=now()||1;
    const earned=Math.max(0,Math.min(200,Math.floor(amount||0),DAILY_LIMIT-pr.earned.coins));
    if(userFor(p)&&earned>0){pr.earned.coins+=earned;coinChange(p,earned);}
    persist(p);return userFor(p)?earned:0;
  }
  function near(p,point,radius=85) {return !!point&&Math.hypot(p.x-point.x,p.y-point.y)<=radius;}
  function release(p) {p.activityLocked=false;p.activityLockId=null;p.activityAnimation=null;}
  function terminal(p,status,message,extra={}) {
    const active=sessions.get(p.id);if(!active||active.status!=="active")return false;
    active.status=status;active.endedAt=now();active.instruction=message;
    Object.assign(active,extra);release(p);results.set(p.id,{id:active.id,status,message,at:now(),...extra});
    return true;
  }
  function finish(p,extra={}) {
    const a=sessions.get(p.id),def=a&&definitions.get(a.id);if(!a||a.status!=="active")return false;
    const coins=reward(p,extra.reward===undefined?def.reward:extra.reward,extra.onceKey||(def.once?def.id:null));
    profile(p).cooldowns[def.id]=now()+Math.max(5000,def.cooldownMs||30000);
    persist(p);return terminal(p,"success",extra.message||"Activity completed.",{coins,...extra,reward:undefined});
  }
  function fail(p,message="Activity ended.") {return terminal(p,"failed",message);}
  function context(p) {
    const active=sessions.get(p.id),definition=active&&definitions.get(active.id);
    return {player:p,active,definition,world,garage,players,data,rooms,boards,now:now(),randomInt,
      near:(point,radius)=>near(p,point,radius),profile:profile(p),user:userFor(p),
      finish:extra=>finish(p,extra),fail:message=>fail(p,message),reward:(n,claim)=>reward(p,n,claim),
      addItem:(id,n)=>addItem(p,id,n),persist:()=>persist(p),cleanText,blockedText,
      balance:()=>userFor(p)?spendableCoins(userFor(p),key(p)):0,coinChange:n=>coinChange(p,n),
      state:()=>state(p),push:other=>push(other||p),key:key(p),engine:api,
      profileFor:other=>profile(other),blocked:other=>blocked(p,other),consent:other=>!blocked(p,other)&&profile(other).privacy.photos===true};
  }
  function publicActive(a) {if(!a)return null;const out={};for(const [k,v]of Object.entries(a))if(!k.startsWith("_"))out[k]=v;return copy(out);}
  function state(p) {
    if(!p)return {serverTime:now(),capabilities:[],profile:null,active:null,matches:[],leaderboards:{},world:{},tracked:null};
    const pr=copy(profile(p)),user=userFor(p);pr.coins=user?spendableCoins(user,key(p)):null;pr.registered=!!user;pr.dailyLimit=DAILY_LIMIT;
    const visibleRooms=[...rooms.values()].filter(r=>!r.private||r.players?.includes(p.id)).map(r=>publicActive(r));
    const leaderboard={};for(const [id,rows]of boards)leaderboard[id]=rows.slice(0,10);
    return {serverTime:now(),capabilities:[...definitions.values()].filter(a=>handlers.has(a.kind)).map(a=>a.id),
      profile:pr,active:publicActive(sessions.get(p.id)),matches:visibleRooms,leaderboards:leaderboard,
      world:{},tracked:tracked.get(p.id)||null,result:results.get(p.id)||null};
  }
  function push(p) {if(p)io?.to(p.id).emit("city:activity:state",state(p));}
  function cancel(p,message="Activity cancelled.") {
    const a=sessions.get(p.id);if(a?.status==="active")handlers.get(definitions.get(a.id)?.kind)?.cancel?.(context(p));
    if(a?.status==="active")terminal(p,"cancelled",message);release(p);return {ok:true};
  }
  function start(p,id,settings={}) {
    const def=definitions.get(id),handler=def&&handlers.get(def.kind);
    if(!def||!handler)return {error:"That activity is unavailable."};
    if(sessions.get(p.id)?.status==="active")return {error:"Finish or leave your current activity first."};
    if(p.rideId||p.gameId||p.gardenSeatId)return {error:"Leave your current seat or game first."};
    if(def.location?.interiorId?(p.interiorId!==def.location.interiorId):!!p.interiorId)return {error:"Go to the activity location first."};
    if(!def.anywhere&&!near(p,def.location,def.radius||100))return {error:"Walk to the marked activity location."};
    if(p.vehicleId&&!def.vehicle)return {error:"Park and leave the car first."};
    if((profile(p).cooldowns[id]||0)>now())return {error:"This activity is cooling down."};
    if(def.once&&profile(p).claims[id])return {error:"You have already discovered this reward."};
    const a={id,token:crypto.randomBytes(12).toString("hex"),status:"active",startedAt:now(),expiresAt:now()+(def.durationMs||180000),step:0,progress:0,instruction:def.description};
    sessions.set(p.id,a);p.activityLocked=def.lock===true;p.activityLockId=p.activityLocked?a.token:null;
    const result=handler.start?.(context(p),settings)||{};
    if(result.error){sessions.delete(p.id);release(p);return result;}
    observed.set(p.id,{x:p.x,y:p.y,at:now(),interiorId:p.interiorId||null});
    return {ok:true};
  }
  function invalidAttempt(p,a,at) {
    const def=definitions.get(a.id),old=observed.get(p.id),elapsed=old?Math.max(1,at-old.at):1;
    if(p.rideId||p.gameId||(!def.vehicle&&p.vehicleId)||((p.interiorId||null)!==(def.location?.interiorId||null)))return "Activity interrupted by changing location or transport.";
    if(old&&Math.hypot(p.x-old.x,p.y-old.y)>500*elapsed/1000+80)return "Activity interrupted by an invalid movement jump.";
    if(at>a.expiresAt)return "Time is up. Try again.";
    return null;
  }
  function dispatch(p,packet) {
    if(!p||!players.has(p.id))return {error:"Join the city first.",state:state(null)};
    if(!packet||typeof packet!=="object"||Array.isArray(packet)||!cleanId(packet.requestId))return {error:"Invalid activity request.",state:state(p)};
    const signature=JSON.stringify(packet);if(signature.length>6000)return {error:"Activity request is too large.",state:state(p)};
    let cache=requests.get(p.id);if(!cache){cache=new Map();requests.set(p.id,cache);}
    const previous=cache.get(packet.requestId);
    if(previous)return previous.signature===signature?{...previous.result,duplicate:true,state:state(p)}:{error:"Request ID was already used.",state:state(p)};
    const limit=rate.get(p.id)||{at:now(),count:0};if(now()-limit.at>=1000){limit.at=now();limit.count=0;}rate.set(p.id,limit);
    if(++limit.count>12)return {error:"Please slow down.",state:state(p)};
    let result={error:"Unknown activity action."};
    if(packet.action==="track") {if(packet.activityId===null){tracked.delete(p.id);result={ok:true};}else if(definitions.has(packet.activityId)&&handlers.has(definitions.get(packet.activityId).kind)){tracked.set(p.id,packet.activityId);result={ok:true};}}
    else if(packet.action==="start")result=start(p,packet.activityId,packet.options||{});
    else if(packet.action==="privacy"){profile(p).privacy.photos=packet.value===true||packet.value?.photos===true;persist(p);result={ok:true};}
    else {
      const a=sessions.get(p.id);
      if(!a||packet.token!==a.token)result={error:"This activity has ended. Start again."};
      else if(packet.action==="cancel"){result=cancel(p);sessions.delete(p.id);results.delete(p.id);tracked.delete(p.id);}
      else if(a.status!=="active")result={error:"This activity has ended. Start again."};
      else if(packet.action==="act"){
        const invalid=invalidAttempt(p,a,now());
        if(invalid){fail(p,invalid);result={error:invalid};}
        else result=handlers.get(definitions.get(a.id).kind)?.act?.(context(p),packet)||{error:"That action is unavailable."};
      }
    }
    cache.set(packet.requestId,{signature,result});while(cache.size>64)cache.delete(cache.keys().next().value);
    return {...result,state:state(p)};
  }
  function command(p,packet) {
    try{return dispatch(p,packet);}catch(error){if(p){fail(p,"Invalid activity action; this attempt was stopped.");release(p);}return {error:"Invalid activity action.",state:state(p)};}
  }
  function tick() {
    const at=now();for(const [id,a]of sessions){const p=players.get(id);if(!p){sessions.delete(id);continue;}
      if(a.status!=="active"){if(at-a.endedAt>10000)sessions.delete(id);continue;}
      const def=definitions.get(a.id),invalid=invalidAttempt(p,a,at);
      if(invalid)fail(p,invalid);
      else try{handlers.get(def.kind)?.tick?.(context(p));}catch(error){fail(p,"This activity was interrupted. Please try again.");}
      observed.set(id,{x:p.x,y:p.y,at,interiorId:p.interiorId||null});
      if(at-(lastPush.get(id)||0)>=500){lastPush.set(id,at);push(p);}
    }
  }
  function remove(p) {if(!p)return;cancel(p,"Connection ended; no unfinished reward was claimed.");sessions.delete(p.id);requests.delete(p.id);rate.delete(p.id);tracked.delete(p.id);observed.delete(p.id);lastPush.delete(p.id);results.delete(p.id);guests.delete(p.id);}
  function attach(socket) {
    socket.on("city:activity:state",(_payload,ack)=>{if(typeof ack==="function")ack({ok:true,state:state(players.get(socket.id))});});
    socket.on("city:activity:command",(packet,ack)=>{const result=command(players.get(socket.id),packet);if(typeof ack==="function")ack(result);});
  }
  function register(kind,handler) {handlers.set(kind,handler);return api;}
  const api={attach,tick,remove,state,command,register,profile,finish,fail,context,push,rooms,boards,blocked};
  if(!options.catalog)require("./server-city-activity-explore")(api);
  if(!options.catalog)require("./server-city-activity-jobs")(api);
  return api;
}
module.exports={createCityActivities};
