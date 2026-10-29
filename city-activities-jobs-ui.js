(function(root){
 'use strict';
 const UI=root.GaicaniCityActivitiesUI;
 function renderer({mount,active,getState,command,now,node,button,bridge}){
  const select=(label,rows)=>{const s=node('select');s.setAttribute('aria-label',label);for(const row of rows){const o=node('option','',row.label||row.name||row.id||row);o.value=row.id||row;s.append(o);}return s;};
  const form=(label,fields,submit)=>{const f=node('form');const b=node('button','activity-primary',label);b.type='submit';f.append(...fields,b);f.addEventListener('submit',e=>{e.preventDefault();submit();});mount.append(f);return f;};
  const send=(verb,value)=>command('act',{verb,value});
  let timer,update=()=>{};
  function timing(action){const meter=node('progress'),text=node('p');meter.max=1;meter.setAttribute('aria-label','Timing window');mount.append(meter,text);let sounded=false;
   timer=setInterval(()=>{const a=getState()?.active,c=a?.challenge;if(!c)return;const t=now(),hit=Math.abs(t-c.at)<=c.windowMs;meter.value=Math.max(0,Math.min(1,(t-(c.at-3000))/4000));text.textContent=hit?'NOW — '+action:t<c.at?'Wait… '+Math.max(0,(c.at-t)/1000).toFixed(1)+'s':'Too late';text.style.color=hit?'#9affc8':'';if(hit&&!sounded){sounded=true;bridge.cue?.(850);}},50);
  }
  if(active.id==='delivery'){
   if(active.step===0){const kind=select('Parcel type',['pizza','flowers','package','letter']),timed=node('input'),label=node('label','activity-consent');timed.type='checkbox';label.append(timed,node('span','','Timed delivery (90 seconds, up to 15 coins)'));form('Pick up parcel',[kind,label],()=>send('pickup',{kind:kind.value,timed:timed.checked}));}
   else{form('Hand over parcel',[],()=>send('deliver'));const clock=node('p');mount.append(clock);update=()=>{clock.textContent=Math.max(0,Math.ceil((getState().active.expiresAt-now())/1000))+' seconds remaining';};}
  }else if(active.id==='market'){
   const stock=active.stock||[],items=select('Market item',stock.map(i=>({id:i.id,label:i.name+(i.price?' · Buy '+i.price:'')+(i.sell?' · Sell '+i.sell:'')}))),quantity=node('input'),action=select('Trade',['buy','sell']),balance=node('p');quantity.type='number';quantity.min='1';quantity.max='20';quantity.value='1';quantity.inputMode='numeric';quantity.enterKeyHint='go';quantity.setAttribute('aria-label','Quantity');form('Confirm trade',[items,quantity,action],()=>send(action.value,{id:items.value,count:Number(quantity.value)}));mount.append(balance);update=()=>{const pr=getState().profile;balance.textContent=(pr.registered?pr.coins+' available coins':'Registration required for trading')+' · Owned: '+(pr.inventory[items.value]||0);};items.addEventListener('change',update);
  }else if(active.id==='bar'){
   if(active.waiting){mount.append(node('p','','Your order is open to nearby players. You can cancel using ×.'));return {update(){},destroy(){}};}
   mount.append(node('p','','Ticket: '+active.order.name+' · '+active.order.ingredients.join(' → ')));const ingredient=select('Ingredient',active.ingredients);form('Pour ingredient',[ingredient],()=>send('mix',ingredient.value));timing('pour '+active.order.ingredients[active.step]);
   if(active.step===0){mount.append(button('Request this drink from a player',()=>send('request')));const customer=select('Waiting customer',[]);form('Accept player order',[customer],()=>send('take-order',customer.value));let key='';update=()=>{const list=getState().active.customers||[],next=JSON.stringify(list);if(next===key)return;key=next;const value=customer.value;customer.replaceChildren();for(const p of list){const o=node('option','',p.name);o.value=p.id;customer.append(o);}if([...customer.options].some(o=>o.value===value))customer.value=value;};}
  }else if(active.id==='repair'){
   if(active.step===0){const cars=select('Parked car',[]),part=select('Part',['tires','engine','lights']),note=node('p');form('Inspect part',[cars,part],()=>send('inspect',{vehicleId:cars.value,part:part.value}));mount.append(note);let previous='';update=()=>{const list=getState().active.cars||[],key=JSON.stringify(list.map(v=>[v.id,v.condition]));if(key!==previous){previous=key;const id=cars.value;cars.replaceChildren();for(const v of list){const o=node('option','',v.model+' · tires '+Math.round(v.condition?.tires??100)+'% / engine '+Math.round(v.condition?.engine??100)+'% / lights '+Math.round(v.condition?.lights??100)+'%');o.value=v.id;cars.append(o);}if([...cars.options].some(o=>o.value===id))cars.value=id;}note.textContent=list.length?'Choose a part at 95% or below.':'Park a car within the mechanic bay, then get out. Driving gradually wears its parts.';};}
   else{form('Tighten fitting',[],()=>send('tighten'));timing('tighten');}
  }else if(active.id==='taxi'){
   let key='';update=()=>{const a=getState().active,k=JSON.stringify([a.role,a.trip,a.passengers]);if(k===key)return;key=k;mount.replaceChildren();
    if(a.trip){mount.append(node('p','',a.trip.driverName+' → '+a.trip.passengerName),node('strong','',a.trip.destination.label+' · '+a.trip.fare+' virtual coins'),node('p','',a.trip.accepted?'Fare accepted. Payment happens only after passenger confirmation at the destination.':'Review the fare before accepting.'));
     if(a.role==='passenger')form(a.trip.accepted?'Confirm arrival and pay':'Accept trip',[],()=>send(a.trip.accepted?'arrive':'accept'));
     if(a.role==='passenger')mount.append(button('Stop and exit safely',()=>send('exit')));
    }else if(a.role==='driver'){const passenger=select('Passenger',(a.passengers||[])),destination=select('Destination',a.destinations||[]),fare=node('input');fare.type='number';fare.min='0';fare.max='100';fare.value='0';fare.inputMode='numeric';fare.enterKeyHint='go';fare.setAttribute('aria-label','Fare in virtual coins');const preference=()=>{const chosen=a.passengers.find(p=>p.id===passenger.value)?.destinationId;if(chosen)destination.value=chosen;};passenger.addEventListener('change',preference);preference();form('Offer trip',[passenger,destination,fare],()=>send('offer',{passengerId:passenger.value,destinationId:destination.value,fare:Number(fare.value)}));mount.append(node('small','','Ask a passenger to open Taxi rides before offering. Guests can take free trips.'));}
    else {const dest=select('Requested destination',a.destinations||[]);form('Request destination',[dest],()=>send('request-destination',dest.value));mount.append(node('p','','Waiting for the driver to offer a trip. You can review the fare here.'));}
   };
  }
  update();return {update,destroy(){clearInterval(timer);}};
 }
 for(const id of ['delivery','market','bar','repair','taxi'])UI.registerRenderer(id,renderer);
})(window);
