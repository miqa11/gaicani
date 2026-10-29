"use strict";

module.exports = function installExplore(engine) {
  function animate(c, kind, until, target = c.player) {
    c.player.activityAnimation = {kind, startedAt:c.now, until, target:{x:target.x,y:target.y}};
  }
  function timing(kind, verb, delay, windowMs) {
    return {
      start(c) {
        c.player.activityLocked = true;
        c.player.activityLockId = c.active.token;
        const at = c.now + delay + c.randomInt(2500);
        c.active.challenge = {id:c.active.token, at, windowMs, verb,
          label:kind === "fishing" ? "A bite! Reel now" : "The insect is in reach — swing now"};
        c.active.instruction = kind === "fishing"
          ? "Rod equipped. Your line is cast; wait for the bite."
          : "Net equipped. Wait for the glowing insect to approach.";
        animate(c, kind, at + windowMs);
        c.active.expiresAt = at + windowMs + 1000;
      },
      act(c, packet) {
        const challenge = c.active.challenge;
        if (packet.verb !== verb) return {error:"Use the timing control."};
        if (c.now < challenge.at - challenge.windowMs) return {error:"Wait for the cue."};
        if (c.now > challenge.at + challenge.windowMs) {
          c.fail("Too late — it escaped."); return {ok:true};
        }
        const roll = c.randomInt(100);
        const item = kind === "fishing"
          ? (roll < 2 ? "fish-legendary" : roll < 20 ? "fish-rare" : "fish-common")
          : (roll < 20 ? "bug-rare" : "bug-common");
        if (!c.addItem(item)) {c.fail("Your inventory is full."); return {ok:true};}
        c.finish({message:"Caught " + c.data.items.find(i => i.id === item).name + "!", item});
        animate(c, kind === "fishing" ? "reel" : "net", c.now + 700);
        return {ok:true};
      },
      tick(c) {
        if (c.now > c.active.challenge.at + c.active.challenge.windowMs)
          c.fail("It escaped. Cast or search again.");
      }
    };
  }
  engine.register("fishing", timing("fishing", "reel", 3000, 400));
  engine.register("bugs", timing("bugs", "catch", 1800, 350));

  const trails = [
    {name:"The lost mixtape", points:[
      [450,730,"Look beside the bench below the old balconies."],
      [960,700,"The cassette collector left a date near the taxi rank."]],
      question:"The mixtape says ‘last year of the 1900s’. Which year opens the lock?",
      answer:"1999", choices:["1989","1999","2009"], item:"cassette"},
    {name:"The silent pager", points:[
      [1500,1740,"A message points to the south noticeboard."],
      [2200,1740,"Follow the river lights toward the open courtyard."]],
      question:"A pager receives messages. Which object did its owner leave behind?",
      answer:"pager", choices:["teapot","pager","umbrella"], item:"pager"},
    {name:"Two hands, one treasure", points:[
      [1100,2950,"Find the two marked stones in the garden."],
      [1400,3000,"Bring another treasure hunter to the twin lock."]],
      question:"The lock needs two people. What opens it?",
      answer:"together", choices:["alone","together","coins"], item:"souvenir", cooperative:true}
  ];
  const target = row => ({x:row[0], y:row[1], label:row[2]});
  function partnerAtLock(c) {
    const a = c.active;
    return [...c.players.values()].find(other => {
      if (other.id === c.player.id || c.blocked(other) || other.interiorId || other.vehicleId || other.rideId)
        return false;
      if (c.key && String(other.userKey || "").toLowerCase() === c.key) return false;
      const partner = engine.context(other).active;
      // The second hunter can finish just after the first, without the first losing their reward.
      const ready = partner?.status === "active" ||
        (partner?.status === "success" && partner._partnerId === c.player.id && c.now - partner.endedAt < 10000);
      return ready && partner.id === "treasure" && partner.trail === a.trail &&
        partner.step === trails[a.trail].points.length &&
        Math.hypot(other.x-a.target.x, other.y-a.target.y) <= 65;
    });
  }
  engine.register("treasure", {
    start(c, options) {
      const index = options.trail === undefined ? 0 : options.trail;
      if (!Number.isInteger(index) || !trails[index]) return {error:"Choose one of the three treasure trails."};
      if (c.profile.claims["treasure:"+index]) return {error:"This treasure is already in your journal."};
      c.active.trail = index;
      c.active.trailName = trails[index].name;
      c.active.target = target(trails[index].points[0]);
      c.active.instruction = c.active.target.label;
    },
    act(c, packet) {
      const a = c.active, trail = trails[a.trail];
      if (packet.verb === "search" && !a.choices) {
        if (!c.near(a.target,65)) return {error:"Reach the clue marker first."};
        a.step++;
        a.progress = a.step / (trail.points.length+1);
        animate(c,"dig",c.now+750,a.target);
        if (a.step < trail.points.length) {
          a.target = target(trail.points[a.step]); a.instruction = a.target.label;
        } else {
          a.choices = trail.choices.map(id => ({id,label:id})); a.instruction = trail.question;
        }
        return {ok:true};
      }
      if (packet.verb !== "solve" || !a.choices || !c.near(a.target,65))
        return {error:"Collect the clues and stand at the lock."};
      if (packet.value !== trail.answer) {
        c.fail("The lock stays closed. Follow the clues and try again."); return {ok:true};
      }
      const partner = trail.cooperative ? partnerAtLock(c) : null;
      if (trail.cooperative && !partner)
        return {error:"A second real treasure hunter must solve this trail beside the twin lock."};
      if (c.profile.claims["treasure:"+a.trail]) return {error:"Already claimed."};
      if (!c.addItem(trail.item)) return {error:"Make room in your inventory before opening the chest."};
      if (partner) a._partnerId = partner.id;
      c.finish({onceKey:"treasure:"+a.trail, message:trail.name+" discovered.", item:trail.item});
      animate(c,"dig",c.now+900,a.target);
      return {ok:true};
    }
  });

  function photoSubjects(c) {
    const raw = [
      ...(c.world.landmarks || []).map(s => ({...s,type:"landmark",x:s.interactX??s.x,y:s.interactY??s.y})),
      ...(c.garage?.list() || []).map(s => ({...s,type:"vehicle",name:s.name||s.model})),
      ...(c.world.npcs || []).map(s => ({...s,type:"citizen"})),
      ...(c.world.garden?.npcs || []).map(s => ({...s,type:"citizen"})),
      ...(c.data.npcs || []).map(s => ({...s,type:"citizen"})),
      ...[...c.players.values()].map(s => ({...s,type:"player"}))
    ];
    return raw.filter(s => Number.isFinite(s.x) && Number.isFinite(s.y) && !s.rideId &&
      Math.abs(s.x-c.player.x) <= 285 && Math.abs(s.y-c.player.y) <= 165 &&
      (s.interiorId || null) === (c.player.interiorId || null) &&
      (s.type !== "player" || s.id === c.player.id || c.consent(s)))
      .map(s => ({id:s.id,type:s.type,name:s.name||s.model||s.id,color:s.color||"#ffdc55",x:s.x,y:s.y,
        model:s.model,collected:!!c.profile.claims["photo:"+s.type+":"+s.id]}));
  }
  engine.register("photography", {
    start(c) {
      c.active.subjects = photoSubjects(c);
      c.active.instruction = "Photograph a new landmark, citizen, car, or consenting friend for your album. Each subject earns coins once.";
    },
    tick(c) {c.active.subjects = photoSubjects(c);},
    act(c, packet) {
      if (packet.verb !== "capture" || !packet.value || typeof packet.value !== "object" || Array.isArray(packet.value))
        return {error:"Choose a photo subject."};
      const value = packet.value;
      // Re-evaluate live consent, blocks, scene and range; never authorize stale menu subjects.
      const subject = photoSubjects(c).find(s => s.id === value.targetId && s.type === value.targetType);
      if (!subject) return {error:"The subject is too far away or has not consented."};
      const frame = ["neon","gold","mint"].includes(value.frame) ? value.frame : "neon";
      const pose = ["wave","dance"].includes(value.pose) ? value.pose : "wave";
      const photo = {x:c.player.x,y:c.player.y,
        allowedPlayerIds:subject.type === "player" && subject.id !== c.player.id ? [c.player.id,subject.id] : [c.player.id],
        subject,frame,pose,title:subject.name,at:c.now};
      const album = Array.isArray(c.profile.records.photos) ? c.profile.records.photos : [];
      album.unshift({subjectId:subject.id,type:subject.type,title:subject.name,at:c.now,frame});
      c.profile.records.photos = album.slice(0,24);
      c.persist();
      c.finish({photo,onceKey:"photo:"+subject.type+":"+subject.id,message:"Photo added to your album. Save it locally if you like."});
      animate(c,"camera",c.now+800,subject);
      return {ok:true,photo};
    }
  });

  engine.register("parkour", {
    start(c) {
      c.active.checkpoints = [[960,1780],[1060,1780],[1170,1780],[1280,1780],[1400,1780]]
        .map((p,i) => ({x:p[0],y:p[1],label:"Jump checkpoint "+(i+1)}));
      c.active.target = c.active.checkpoints[0];
      c.active.lastJump = c.player.jumpSerial || 0;
      c.active.expiresAt = c.now+90000;
      c.active.instruction = "Jump inside each ring in order. Each ring needs a new jump.";
    },
    tick(c) {
      const a = c.active;
      if (!c.near(a.target,30) || !(c.player.jumpRemaining > 0) || (c.player.jumpSerial || 0) <= a.lastJump) return;
      a.lastJump = c.player.jumpSerial;
      a.step++;
      a.progress = a.step / a.checkpoints.length;
      if (a.step === a.checkpoints.length) {
        const elapsed = c.now-a.startedAt;
        // Guest IDs are connection-scoped; account bests remain stable across reconnects.
        const id = c.user ? c.key : c.player.id;
        const rows = c.boards.get("parkour") || [];
        const prior = rows.find(r => r.id === id);
        if (!prior || elapsed < prior.time) {
          const next = rows.filter(r => r.id !== id);
          next.push({id,name:c.player.name,time:elapsed,at:c.now});
          next.sort((x,y) => x.time-y.time);
          c.boards.set("parkour",next.slice(0,20));
        }
        const best = c.profile.records.parkour;
        if (!best || elapsed < best) c.profile.records.parkour = elapsed;
        c.persist();
        c.finish({time:elapsed,message:"Course complete in "+(elapsed/1000).toFixed(2)+" seconds."});
      } else a.target = a.checkpoints[a.step];
      animate(c,"checkpoint",c.now+500);
    },
    act() {return {error:"Checkpoints use your real position and jump, not a submitted score."};}
  });
};

