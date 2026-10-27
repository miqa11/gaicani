"use strict";
function attachVehicleEvents({socket,io,players,garage,publicPlayer,push,cleanText,blockedText}) {
  const self=()=>players.get(socket.id);
  const respond=(ack,result)=>{
    if(typeof ack!=="function")ack=()=>{};
    if(result.error)return ack(result);
    push();ack({ok:true,self:self()?publicPlayer(self()):null,vehicles:garage.list()});
  };
  socket.on('city:vehicle:driver',(_data,ack)=>respond(ack,garage.takeDriver(self())));
  socket.on('city:vehicle:setting',(data,ack)=>respond(ack,garage.setting(self(),data?.key,data?.value)));
  socket.on('city:vehicle:invite',(data,ack)=>{
    const target=players.get(data?.targetId),result=garage.invite(self(),target);
    if(result.ok)io.to(target.id).emit('city:vehicle:invited',result);
    respond(ack,result);
  });
  socket.on('city:vehicle:message',(data,ack)=>{
    const reply=typeof ack==='function'?ack:()=>{},p=self(),v=garage.find(p?.vehicleId),text=cleanText(data?.text,120),now=Date.now();
    if(!p||!v||!v.seats.some(s=>s.playerId===p.id)||!text||blockedText(text))return reply({error:'მანქანის ჩატი მიუწვდომელია.'});
    if(p.lastCarMessage&&now-p.lastCarMessage<1000)return reply({error:'ერთი წამი მოიცადე.'});
    p.lastCarMessage=now;
    const message={fromId:p.id,name:p.name,text,at:now,vehicleId:v.id};
    for(const seat of v.seats){const target=players.get(seat.playerId);if(target&&!garage.relationship(p,target).blocked)io.to(target.id).emit('city:vehicle:message',message);}
    reply({ok:true});
  });
  socket.on('city:vehicle:horn',(_data,ack)=>{
    const p=self(),v=garage.find(p?.vehicleId),now=Date.now(),reply=typeof ack==='function'?ack:()=>{};
    if(!v||v.driverId!==p.id||now-(v.lastHorn||0)<1500)return reply({error:'მოიცადე ან მძღოლის ადგილი დაიკავე.'});
    v.lastHorn=now;
    for(const target of players.values())if(!target.interiorId&&!target.rideId&&Math.hypot(target.x-v.x,target.y-v.y)<600&&!garage.relationship(p,target).blocked)io.to(target.id).emit('city:vehicle:horn',{vehicleId:v.id,x:v.x,y:v.y,at:now});
    reply({ok:true});
  });
}
module.exports={attachVehicleEvents};
