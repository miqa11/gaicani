/* Shared activity definitions; locations are outdoor interaction points, never new walls. */
(function(root,factory){const W=typeof module==='object'&&module.exports?require('./city-world'):root.GaicaniCityWorld;const data=factory(W);if(typeof module==='object'&&module.exports)module.exports=data;if(root)root.GaicaniCityActivitiesData=data;})(typeof window==='undefined'?globalThis:window,function(W){
 'use strict';
 function point(x,y,label,interiorId){if(interiorId)return {x,y,label,interiorId};for(let r=0;r<=100;r+=10)for(const [dx,dy]of [[r,0],[-r,0],[0,r],[0,-r]])if(W.isWalkable(x+dx,y+dy,18))return {x:x+dx,y:y+dy,label};throw Error('No safe activity location: '+label);}
 const categories=['Explore','Jobs','Multiplayer','Gaicanians','Games','Collections'];
 const rows=[
 ['fishing','River fishing','Explore',2,'Cast a rod, watch for a bite, and land common, rare, or legendary fish.',2475,1700,'Mtkvari riverbank',12,'fishing'],
 ['treasure','Hidden treasures','Explore',2,'Follow clues and solve locks. Some discoveries need a partner.',420,700,'Old-town courtyard',15,'treasure'],
 ['bugs','Glow-bug catching','Explore',2,'Swing your net at the right moment and fill your insect book.',450,2050,'Garden orchard',8,'bugs'],
 ['photography','City photography','Explore',2,'Frame landmarks, cars, citizens, and consenting friends.',2740,980,'River viewpoint',5,'photography'],
 ['parkour','Courtyard parkour','Games',2,'Jump through checkpoints in an outdoor time trial.',960,1700,'South courtyard',12,'parkour'],
 ['delivery','City deliveries','Jobs',3,'Carry pizza, flowers, packages, or letters to real city destinations.',420,1100,'Delivery counter',12,'delivery'],
 ['taxi','Taxi rides','Jobs',3,'Agree on a destination and fare with a real passenger.',900,700,'Taxi rank',0,'taxi'],
 ['repair','Mechanic workshop','Jobs',3,'Repair tires, engines, and lights on the existing city cars.',1000,1700,'Outdoor mechanic bay',8,'repair'],
 ['bar','Garden refreshments','Jobs',3,'Mix fictional nonalcoholic drinks to order and serve them.',500,2290,'Neon Garden bar',8,'bar'],
 ['market','Citizen street market','Collections',3,'Buy supplies and cosmetics or sell your catches using virtual coins.',980,1100,'Market plaza',0,'market'],
 ['racing','Street races','Multiplayer',4,'Challenge drivers to a sprint or circuit with ordered checkpoints.',540,700,'Rustaveli race start',15,'racing'],
 ['dance-battle','Dance battles','Multiplayer',4,'Challenge a friend to synchronized rhythm cues. Spectators can cheer.',1400,2500,'Neon Garden dance floor',10,'dance-battle'],
 ['hide-seek','Hide and seek','Multiplayer',4,'Hide inside the marked garden zone or find the other players.',700,2850,'Garden play area',8,'hide-seek'],
 ['tag','Tag and chase','Multiplayer',4,'Touch another player to pass the role. No instant tag-backs.',1100,2950,'Garden chase area',8,'tag'],
 ['karaoke','Karaoke stage','Multiplayer',4,'Queue for original text performances and applaud your friends.',1900,2500,'Garden karaoke stage',0,'karaoke'],
 ['photo-booth','Retro photo booth','Multiplayer',4,'Choose poses, frames and stickers for an opt-in group portrait.',2100,2800,'Garden photo booth',0,'photo-booth'],
 ['car-meet','Car meetups','Multiplayer',4,'Paint your car, inspect cosmetics, and vote in a live showcase.',1240,1740,'South parking plaza',0,'car-meet'],
 ['graffiti','Pixel graffiti','Multiplayer',4,'Draw on a designated wall and submit your work for approval.',1540,1740,'Approved art wall',0,'graffiti'],
 ['help','Help a Gaicanian','Gaicanians',5,'Water flowers, recover tools, clean, carry groceries, and prepare the garden.',760,1740,'Citizen help corner',10,'help'],
 ['friendship','Citizen friendships','Gaicanians',5,'Talk, remember shared moments, and unlock personal stories.',480,2300,'Citizen gathering spot',0,'friendship'],
 ['pets','Pet care','Gaicanians',5,'Feed, walk, and find the little animals around the city.',2200,3000,'Pet corner',8,'pets'],
 ['detective','Neighborhood mysteries','Gaicanians',5,'Question citizens, inspect clues, and solve handcrafted cases.',1500,1740,'Detective noticeboard',15,'detective'],
 ['tournament','Arcade tournaments','Games',6,'Compete in the existing Arcade games during a timed tournament.',1979,1103,'Pixel Palace Arcade',0,'tournament'],
 ['dj','DJ booth','Games',6,'Take a timed turn selecting the original garden music.',1400,2220,'Neon Garden DJ booth',0,'dj'],
 ['collectibles','City collection trail','Collections',6,'Discover hats, car decorations, stickers, souvenirs, and retro technology.',960,700,'Collectors corner',5,'collectibles'],
 ['environment','City interactions','Explore',6,'Sit, recycle, feed birds, use the phone, play, and listen to musicians.',420,1690,'Neighborhood square',0,'environment']
 ];
 const activities=rows.map(([id,name,category,phase,description,x,y,label,reward,kind])=>({id,name,category,phase,description,location:point(x,y,label),reward,kind,cooldownMs:reward?60000:1000,mode:category==='Multiplayer'?'multiplayer':'solo',durationMs:180000}));
 activities.find(a=>a.id==='photography').anywhere=true;
 for(const id of ['delivery','taxi'])activities.find(a=>a.id===id).vehicle=true;
 activities.find(a=>a.id==='taxi').anywhere=true;
 activities.find(a=>a.id==='taxi').durationMs=600000;
 const items=[
 {id:'fish-common',name:'River perch',type:'fish',rarity:'common',sell:3}, {id:'fish-rare',name:'Silver trout',type:'fish',rarity:'rare',sell:12}, {id:'fish-legendary',name:'Neon sturgeon',type:'fish',rarity:'legendary',sell:35},
 {id:'bug-common',name:'Garden beetle',type:'insect',rarity:'common',sell:2},{id:'bug-rare',name:'Neon firefly',type:'insect',rarity:'rare',sell:10},
 {id:'rod',name:'Fishing rod',type:'supply',price:15},{id:'net',name:'Butterfly net',type:'supply',price:12},{id:'hat',name:'Retro bucket hat',type:'cosmetic',price:20},
 {id:'sticker',name:'Gaicanian sticker',type:'sticker',price:5},{id:'car-star',name:'Car star decal',type:'vehicle',price:25},{id:'souvenir',name:'Yellow citizen souvenir',type:'collectible',price:10},{id:'cassette',name:'Hidden mixtape',type:'collectible',sell:4},{id:'pager',name:'1999 pager',type:'collectible',sell:8},{id:'pet-food',name:'Pet treats',type:'supply',price:2}
 ];
 const npcs=[
 {id:'g-mzi',name:'Mzi',personality:'cheerful gardener',x:760,y:1740,color:'#ffdc55',job:'flowers',story:'I planted the first night-blooming flower here.'},
 {id:'g-beka',name:'Beka',personality:'careful mechanic',x:1000,y:1700,color:'#f2ca3e',job:'repair',story:'My oldest engine still hums like a cassette player.'},
 {id:'g-lali',name:'Lali',personality:'curious collector',x:980,y:1100,color:'#ffe578',job:'market',story:'A tiny pager once brought this whole street together.'},
 {id:'g-niko',name:'Niko',personality:'shy animal lover',x:2200,y:3000,color:'#ffda5a',job:'pets',story:'Our lost cat always follows the warmest bakery window.'},
 {id:'g-eka',name:'Eka',personality:'energetic host',x:500,y:2290,color:'#ffdf69',job:'bar',story:'The garden opened with three chairs and one borrowed speaker.'},
 {id:'g-dato',name:'Dato',personality:'thoughtful storyteller',x:480,y:2300,color:'#edca4a',job:'friendship',story:'Every courtyard keeps one story that nobody has written down.'}
 ].map(n=>({...n,...point(n.x,n.y,n.name)}));
 return {categories,activities,items,npcs,point};
});
