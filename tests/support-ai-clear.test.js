const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createSupportAI } = require('../server-supportai');

test('bulk clear removes every saved reply and persists without resetting bot preferences or counters', async () => {
  let saved; const events = [], now = Date.now();
  const initial = { enabled:false, counts:{asked:300,answered:250,skipped:7}, optOut:['a:blocked'], lastMet:{'a:recent':now}, convs:Array.from({length:250},(_,i)=>({id:String(i),messages:[{text:'private reply'}]})) };
  const ai = createSupportAI({file:'test',readJson:()=>initial,writeAtomic:(_f,data)=>saved=JSON.parse(data),onUpdate:d=>events.push(d)});
  assert.equal(ai.view().convs.length,200);
  assert.equal(ai.clearAll().removed,250);
  assert.deepEqual(ai.view().convs,[]);
  assert.equal(ai.view().total,0);
  assert.equal(ai.enabled,false);
  assert.deepEqual(ai.view().counts,initial.counts);
  assert.deepEqual(ai.clearAll(),{ok:true,removed:0});
  await new Promise(r=>setTimeout(r,2100));
  assert.deepEqual(saved,{...initial,convs:[]});
  assert.ok(events.every(e=>e.cleared===true));
});

test('ongoing conversations keep only new replies after clear, without double counting or restoring old messages', async () => {
  const events=[];let saved;
  const ai=createSupportAI({file:'test',readJson:()=>({}),writeAtomic:(_f,s)=>saved=JSON.parse(s),onUpdate:d=>events.push(JSON.parse(JSON.stringify(d))),log:()=>{}});
  const user={userName:'tester',connected:true,emit(){}};
  const bot=ai.start(user);user.partner=bot;
  bot.emit('message',{text:'old private reply'});
  const counts={...ai.view().counts};
  ai.clearAll();events.length=0;
  bot.skip();assert.ok(!events.some(e=>e.conv));
  bot.emit('message',{text:'new reply'});
  assert.deepEqual(ai.view().convs[0].messages.map(m=>m.text),['new reply']);
  assert.equal(ai.view().counts.answered,counts.answered);
  assert.equal(ai.view().counts.asked,counts.asked);
  assert.ok(ai.remove(ai.view().convs[0].id));
  bot.disconnect();
  await new Promise(r=>setTimeout(r,2100));
  assert.deepEqual(saved.convs,[]);
});

test('clear socket handler denies non-admins and guests before invoking deletion', () => {
  const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
  const handler=source.slice(source.indexOf('  socket.on("supportAI:clearAll",'),source.indexOf('  socket.on("supportAI:delete",'));
  const auth=source.slice(source.indexOf('  const supportAccount = () => {'),source.indexOf('  // Every registered account, for Support'));
  for(const identity of [null,{isGuest:true,usernameLower:'admin'},{usernameLower:'ordinary'},{usernameLower:'admin'}]){
    let callback,clears=0,result;
    vm.runInNewContext(auth+handler,{socket:{_regUser:identity,on:(_event,fn)=>callback=fn},registeredUsers:new Map([['admin',{isAdmin:true}],['ordinary',{isAdmin:false}]]),supportAI:{clearAll(){clears++;return {ok:true};}}});
    callback({},r=>result=r);
    const allowed=identity?.usernameLower==='admin'&&!identity.isGuest;
    assert.equal(clears,allowed?1:0);
    assert.equal(allowed?result.ok:result.error,allowed?true:'forbidden');
  }
});
