(function(root){
 'use strict';let api,panel,key='',pending=false,invitation=null;
 const el=id=>document.getElementById(id);
 function command(event,data={}){
   if(pending||!api?.socket()?.connected)return;api.stop();pending=true;
   const timer=setTimeout(()=>{pending=false;api.toast('კავშირი შეფერხდა.');},4000);
   api.socket().emit(event,data,r=>{clearTimeout(timer);pending=false;if(!r||r.error){api.toast(r?.error||'კავშირი შეფერხდა.');return;}if(r.vehicles)api.sync(r.vehicles);if(r.self)api.accept(r.self);update();});
 }
 function update(){
   if(!api)return;const p=api.self(),v=p?.vehicleId?api.fleet().find(v=>v.id===p.vehicleId):api.nearest();
   if(invitation&&(Date.now()>invitation.expiresAt||p?.vehicleId)){el('carInvitation').hidden=true;invitation=null;}
   if(!v||!api.socket()?.connected){el('carMore').hidden=true;el('carOptions').hidden=true;return;}
   el('carMore').hidden=false;
   const driver=v.driverId===p?.id,aboard=p?.vehicleId===v.id;
   el('carDrive').hidden=!aboard||!!v.driverId;el('carChat').hidden=!aboard;el('carHorn').hidden=!driver;
   el('carAccess').disabled=!driver;el('carRadio').disabled=!driver;
   if(document.activeElement!==el('carAccess'))el('carAccess').value=v.access;
   if(document.activeElement!==el('carRadio'))el('carRadio').value=v.radio;
   el('carSettings').hidden=!aboard;el('carInviteRow').hidden=!driver;
   const near=api.players().filter(o=>o.id!==p?.id&&!o.vehicleId&&!o.interiorId&&!o.rideId&&Math.hypot(o.x-v.x,o.y-v.y)<150);
   const signature=JSON.stringify([v.id,v.seats,aboard,near.map(p=>[p.id,p.name])]);
   if(signature!==key){key=signature;const seats=el('carSeats');seats.replaceChildren();
     for(const seat of v.seats){const row=document.createElement('div'),label=document.createElement('span');label.textContent=(seat.id===0?'მძღოლი':'ადგილი '+seat.id)+' · '+(seat.name||'თავისუფალია');row.append(label);
       if(!aboard&&!seat.playerId){const b=document.createElement('button');b.type='button';b.textContent='ჩაჯდომა';b.dataset.seat=String(seat.id);b.onclick=()=>command('city:vehicle:enter',{vehicleId:v.id,seatId:seat.id});row.append(b);}seats.append(row);}
     const selected=el('carInviteTarget').value;el('carInviteTarget').replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent='ახლომდებარე მოთამაშეები';el('carInviteTarget').append(empty);
     near.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;el('carInviteTarget').append(o);});if(near.some(p=>p.id===selected))el('carInviteTarget').value=selected;
   }
   el('carInvite').disabled=!el('carInviteTarget').value;
 }
 function mount(value){api=value;panel=el('vehicleHud');
   const more=document.createElement('button');more.id='carMore';more.type='button';more.textContent='ადგილები და რადიო';more.setAttribute('aria-expanded','false');panel.append(more);
   const options=document.createElement('div');options.id='carOptions';options.hidden=true;
   options.innerHTML="<div id=\"carSeats\"></div><div class=\"car-actions\"><button id=\"carDrive\" type=\"button\">მართვა</button><button id=\"carChat\" type=\"button\">საუბარი</button><button id=\"carHorn\" type=\"button\">სიგნალი</button></div><div id=\"carSettings\"><label>წვდომა<select id=\"carAccess\"><option value=\"everyone\">ყველა</option><option value=\"friends\">მეგობრები</option><option value=\"invite\">მოწვევით</option></select></label><label>რადიო<select id=\"carRadio\"><option value=\"off\">გამორთული</option><option value=\"boom-bap\">გვიანი ღამე · ჰიპ-ჰოპი</option><option value=\"rnb\">ატმის შუშხუნა · რიტმ-ენდ-ბლუზი</option><option value=\"club\">ნეონის ექსპრესი · კლუბური</option></select></label></div><div id=\"carInviteRow\"><select id=\"carInviteTarget\" aria-label=\"ახლომდებარე მოთამაშის მოწვევა\"></select><button id=\"carInvite\" type=\"button\">მოწვევა</button></div><small>გასაჩერებლად აუშვი მართვას. ჩაჯექი ან გადმოდი გაჩერებულ მანქანაში.</small>";
   panel.append(options);more.onclick=()=>{options.hidden=!options.hidden;more.setAttribute('aria-expanded',String(!options.hidden));api.stop();update();};
   el('carDrive').onclick=()=>command('city:vehicle:driver');el('carChat').onclick=()=>api.compose('car');el('carHorn').onclick=()=>command('city:vehicle:horn');
   el('carAccess').onchange=e=>command('city:vehicle:setting',{key:'access',value:e.target.value});el('carRadio').onchange=e=>command('city:vehicle:setting',{key:'radio',value:e.target.value});
   el('carInvite').onclick=()=>command('city:vehicle:invite',{targetId:el('carInviteTarget').value});el('carInviteTarget').onchange=update;
   const invite=document.createElement('div');invite.id='carInvitation';invite.hidden=true;invite.className='car-notice';invite.innerHTML="<span></span><button type=\"button\">ჩაჯდომა</button><button type=\"button\" aria-label=\"დახურვა\">×</button>";document.querySelector('.city-world').append(invite);
   invite.children[1].onclick=()=>{if(invitation)command('city:vehicle:enter',{vehicleId:invitation.vehicleId});invite.hidden=true;invitation=null;};invite.children[2].onclick=()=>{invite.hidden=true;invitation=null;};
   const chat=document.createElement('div');chat.id='carMessages';chat.className='car-messages';chat.hidden=true;chat.setAttribute('aria-live','polite');document.querySelector('.city-world').append(chat);
   api.socket().on('city:vehicle:invited',r=>{invitation=r;invite.querySelector('span').textContent=r.name+" გიწვევს სამგზავროდ · მიდი მანქანასთან";invite.hidden=false;});
   let chatTimer;api.socket().on('city:vehicle:message',m=>{const line=document.createElement('p');line.textContent=m.name+': '+m.text;chat.append(line);while(chat.children.length>4)chat.firstChild.remove();chat.hidden=false;clearTimeout(chatTimer);chatTimer=setTimeout(()=>{chat.hidden=true;},12000);});
   api.socket().on('city:vehicle:horn',m=>{const p=api.self();if(!p)return;root.GaicaniCityAudio.horn(Math.max(0,1-Math.hypot(p.x-m.x,p.y-m.y)/600));});
   api.socket().on('disconnect',()=>{invite.hidden=true;chat.hidden=true;invitation=null;options.hidden=true;});
   setInterval(update,180);
 }
 root.GaicaniCityCarUI={mount,update,command};
})(window);
