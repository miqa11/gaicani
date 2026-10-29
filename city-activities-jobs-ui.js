(function(root){
 'use strict';
 const ka=root.GaicaniCityLanguage.label;
 const UI=root.GaicaniCityActivitiesUI;
 function renderer({mount,active,getState,command,now,node,button,bridge}){
  const select=(label,rows)=>{const s=node('select');s.setAttribute('aria-label',label);for(const row of rows){const o=node('option','',row.label||row.name||ka(row.id||row));o.value=row.id||row;s.append(o);}return s;};
  const form=(label,fields,submit)=>{const f=node('form');const b=node('button','activity-primary',label);b.type='submit';f.append(...fields,b);f.addEventListener('submit',e=>{e.preventDefault();submit();});mount.append(f);return f;};
  const send=(verb,value)=>command('act',{verb,value});
  let timer,update=()=>{};
  function timing(action){const meter=node('progress'),text=node('p');meter.max=1;meter.setAttribute('aria-label','დაჭერის დრო');mount.append(meter,text);let sounded=false;
   timer=setInterval(()=>{const a=getState()?.active,c=a?.challenge;if(!c)return;const t=now(),hit=Math.abs(t-c.at)<=c.windowMs;meter.value=Math.max(0,Math.min(1,(t-(c.at-3000))/4000));text.textContent=hit?"ახლა — "+action:t<c.at?"დაელოდე… "+Math.max(0,(c.at-t)/1000).toFixed(1)+' წმ':'დაგვიანებულია';text.style.color=hit?'#9affc8':'';if(hit&&!sounded){sounded=true;bridge.cue?.(850);}},50);
  }
  if(active.id==='delivery'){
   if(active.step===0){const kind=select('გზავნილის სახეობა',['pizza','flowers','package','letter']),timed=node('input'),label=node('label','activity-consent');timed.type='checkbox';label.append(timed,node('span','',"სწრაფი გზავნილი (90 წამი, მაქსიმუმ 15 მონეტა)"));form('გზავნილის აღება',[kind,label],()=>send('pickup',{kind:kind.value,timed:timed.checked}));}
   else{form('გზავნილის ჩაბარება',[],()=>send('deliver'));const clock=node('p');mount.append(clock);update=()=>{clock.textContent=Math.max(0,Math.ceil((getState().active.expiresAt-now())/1000))+" წამი დარჩა";};}
  }else if(active.id==='market'){
   const stock=active.stock||[],items=select('ბაზრის ნივთი',stock.map(i=>({id:i.id,label:i.name+(i.price?" · ყიდვა "+i.price:'')+(i.sell?" · გაყიდვა "+i.sell:'')}))),quantity=node('input'),action=select('ვაჭრობა',['buy','sell']),balance=node('p');quantity.type='number';quantity.min='1';quantity.max='20';quantity.value='1';quantity.inputMode='numeric';quantity.enterKeyHint='go';quantity.setAttribute('aria-label','რაოდენობა');form('გარიგების დადასტურება',[items,quantity,action],()=>send(action.value,{id:items.value,count:Number(quantity.value)}));mount.append(balance);update=()=>{const pr=getState().profile;balance.textContent=(pr.registered?pr.coins+" ხელმისაწვდომი მონეტა":"სავაჭროდ საჭიროა რეგისტრაცია")+" · გაქვს: "+(pr.inventory[items.value]||0);};items.addEventListener('change',update);
  }else if(active.id==='bar'){
   if(active.waiting){mount.append(node('p','',"ახლომდებარე მოთამაშეებს შეუძლიათ შენი შეკვეთის მიღება. გასაუქმებლად დააჭირე ×-ს."));return {update(){},destroy(){}};}
   mount.append(node('p','',"შეკვეთა: "+active.order.name+' · '+active.order.ingredients.map(ka).join(' → ')));const ingredient=select('ინგრედიენტი',active.ingredients);form('ინგრედიენტის დამატება',[ingredient],()=>send('mix',ingredient.value));timing("ჩაასხი "+ka(active.order.ingredients[active.step]));
   if(active.step===0){mount.append(button("შეუკვეთე ეს სასმელი მოთამაშეს",()=>send('request')));const customer=select('მომლოდინე მომხმარებელი',[]);form('შეკვეთის მიღება',[customer],()=>send('take-order',customer.value));let key='';update=()=>{const list=getState().active.customers||[],next=JSON.stringify(list);if(next===key)return;key=next;const value=customer.value;customer.replaceChildren();for(const p of list){const o=node('option','',p.name);o.value=p.id;customer.append(o);}if([...customer.options].some(o=>o.value===value))customer.value=value;};}
  }else if(active.id==='repair'){
   if(active.step===0){const cars=select('გაჩერებული მანქანა',[]),part=select('ნაწილი',['tires','engine','lights']),note=node('p');form('ნაწილის შემოწმება',[cars,part],()=>send('inspect',{vehicleId:cars.value,part:part.value}));mount.append(note);let previous='';update=()=>{const list=getState().active.cars||[],key=JSON.stringify(list.map(v=>[v.id,v.condition]));if(key!==previous){previous=key;const id=cars.value;cars.replaceChildren();for(const v of list){const o=node('option','',v.model+" · საბურავები "+Math.round(v.condition?.tires??100)+"% / ძრავა "+Math.round(v.condition?.engine??100)+"% / ფარები "+Math.round(v.condition?.lights??100)+'%');o.value=v.id;cars.append(o);}if([...cars.options].some(o=>o.value===id))cars.value=id;}note.textContent=list.length?"აირჩიე ნაწილი, რომლის მდგომარეობაც 95%-ია ან ნაკლები.":"გააჩერე მანქანა სახელოსნოსთან და გადმოდი. ტარება ნაწილებს თანდათან ცვეთს.";};}
   else{form('ნაწილის დამაგრება',[],()=>send('tighten'));timing(ka('tighten'));}
  }else if(active.id==='taxi'){
   let key='';update=()=>{const a=getState().active,k=JSON.stringify([a.role,a.trip,a.passengers]);if(k===key)return;key=k;mount.replaceChildren();
    if(a.trip){mount.append(node('p','',a.trip.driverName+' → '+a.trip.passengerName),node('strong','',a.trip.destination.label+' · '+a.trip.fare+" ვირტუალური მონეტა"),node('p','',a.trip.accepted?"საფასური შეთანხმებულია. თანხა ჩამოიჭრება მხოლოდ დანიშნულების ადგილზე მგზავრის დასტურის შემდეგ.":"დათანხმებამდე შეამოწმე საფასური."));
     if(a.role==='passenger')form(a.trip.accepted?'ჩასვლის დადასტურება და გადახდა':'მგზავრობაზე თანხმობა',[],()=>send(a.trip.accepted?'arrive':'accept'));
     if(a.role==='passenger')mount.append(button('გაჩერება და უსაფრთხოდ გადმოსვლა',()=>send('exit')));
    }else if(a.role==='driver'){const passenger=select('მგზავრი',(a.passengers||[])),destination=select('დანიშნულება',a.destinations||[]),fare=node('input');fare.type='number';fare.min='0';fare.max='100';fare.value='0';fare.inputMode='numeric';fare.enterKeyHint='go';fare.setAttribute('aria-label','საფასური ვირტუალურ მონეტებში');const preference=()=>{const chosen=a.passengers.find(p=>p.id===passenger.value)?.destinationId;if(chosen)destination.value=chosen;};passenger.addEventListener('change',preference);preference();form('მგზავრობის შეთავაზება',[passenger,destination,fare],()=>send('offer',{passengerId:passenger.value,destinationId:destination.value,fare:Number(fare.value)}));mount.append(node('small','',"შეთავაზებამდე სთხოვე მგზავრს ტაქსის აქტივობის გახსნა. სტუმრებს უფასოდ მგზავრობა შეუძლიათ."));}
    else {const dest=select('სასურველი დანიშნულება',a.destinations||[]);form('დანიშნულების მოთხოვნა',[dest],()=>send('request-destination',dest.value));mount.append(node('p','',"დაელოდე მძღოლის შეთავაზებას. საფასურს აქ ნახავ."));}
   };
  }
  update();return {update,destroy(){clearInterval(timer);}};
 }
 for(const id of ['delivery','market','bar','repair','taxi'])UI.registerRenderer(id,renderer);
})(window);
