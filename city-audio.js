/* Original Neon Garden music, spatial playback and device-local preferences.
   All instruments are synthesized here; no commercial recordings are included. */
(function (root, factory) {
  const audio = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = audio;
  if (root) root.GaicaniCityAudio = audio;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";
  const STORAGE_KEY = "gaicani_city_audio_v1";
  const defaults = { music: true, effects: true, musicVolume: .45, effectsVolume: .5, muted: false };
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const originalTracks = [
    { id: "rustaveli-afterhours", title: "Rustaveli Afterhours", style: "Original · 1990s boom bap", kind: "original", bpm: 92, bars: 32, swing: .022,
      bass: [45, 41, 38, 40], chords: [[57,60,64,71],[53,57,60,67],[50,53,57,64],[52,56,59,62]],
      melody: [76,null,72,74,null,79,76,null,72,71,null,69,72,null,74,71,69,null,65,67,null,72,69,null,64,67,null,71,68,null,64,null] },
    { id: "peach-soda-96", title: "Peach Soda '96", style: "Original · velvet R&B", kind: "original", bpm: 104, bars: 32, swing: .016,
      bass: [38, 43, 36, 41], chords: [[62,65,69,72],[58,62,65,69],[60,64,67,71],[57,60,64,67]],
      melody: [77,null,76,72,null,69,72,null,74,77,null,81,77,null,74,null,76,null,79,76,72,null,71,null,72,76,null,74,69,null,67,null] },
    { id: "neon-express-99", title: "Neon Express '99", style: "Original · midnight club", kind: "original", bpm: 124, bars: 32, swing: 0,
      bass: [40, 36, 43, 38], chords: [[64,67,71,74],[60,64,67,71],[62,67,71,74],[62,65,69,72]],
      melody: [76,79,null,83,79,76,null,74,72,76,null,79,76,72,null,71,74,79,null,83,81,79,null,76,77,74,null,81,77,74,null,72] }
  ].map(track => Object.assign(track, { duration: track.bars * 4 * 60 / track.bpm, credit: "Original Gaicani composition · synthesized in the browser" }));

  function normalizePreferences(value) {
    const raw = value && typeof value === "object" ? value : {};
    const result = Object.assign({}, defaults);
    for (const key of ["music", "effects", "muted"]) if (typeof raw[key] === "boolean") result[key] = raw[key];
    for (const key of ["musicVolume", "effectsVolume"]) if (Number.isFinite(raw[key])) result[key] = clamp(raw[key], 0, 1);
    return result;
  }
  function readPreferences() {
    try { return normalizePreferences(JSON.parse(root.localStorage.getItem(STORAGE_KEY))); }
    catch (_) { return normalizePreferences(); }
  }
  function spatial(listener) {
    if(listener?.carRadio && listener.carRadio.station !== 'off') return {gain:.8,pan:0,distance:0};
    if (!listener || !listener.inGarden || listener.interior || !Number.isFinite(listener.x) || !Number.isFinite(listener.y)) return { gain: 0, pan: 0, distance: Infinity };
    const garden = listener.garden || {}, floor = garden.danceFloor || { x: 1040, y: 2260, w: 680, h: 520 };
    const dj = garden.dj || { x: 1200, y: 2070, w: 360, h: 120 };
    const source = { x: dj.x + (dj.w || 0) / 2, y: dj.y + (dj.h || 0) / 2 };
    const speakers = garden.speakers?.length ? garden.speakers : [{ x: 1030, y: 2180 }, { x: 1730, y: 2180 }];
    const distance = Math.min(...speakers.map(s => Math.hypot(listener.x - s.x, listener.y - s.y)), Math.hypot(listener.x - source.x, listener.y - source.y));
    const floorDistance = Math.hypot(listener.x - (floor.x + floor.w / 2), listener.y - (floor.y + floor.h / 2));
    const speakerGain = 1 / (1 + Math.pow(distance / 440, 1.5));
    const danceGain = .72 / (1 + Math.pow(floorDistance / 460, 2));
    return { gain: clamp(Math.max(speakerGain, danceGain), .08, 1), pan: clamp((source.x - listener.x) / 1100, -.72, .72), distance };
  }
  function transport(epoch, now, tracks) {
    const playlist = tracks?.length ? tracks : originalTracks;
    const total = playlist.reduce((sum, track) => sum + track.duration, 0);
    const absolute = Math.max(0, (now - epoch) / 1000);
    let position = absolute % total, index = 0;
    while (index < playlist.length - 1 && position >= playlist[index].duration) { position -= playlist[index].duration; index++; }
    const track = playlist[index], beat = position * track.bpm / 60, phase = beat - Math.floor(beat);
    return { track, index, position, beat, phase, pulse: Math.pow(1 - phase, 3), bar: Math.floor(beat / 4), bpm: track.bpm,
      title: track.title, cycle: Math.floor(absolute / total), step: Math.floor(beat * 4) };
  }
  function validateTracks(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) throw Error("Supply a nonempty authorized playlist");
    return tracks.map((track, index) => {
      if (!track || track.kind !== "audio" || typeof track.url !== "string" || !/^\/(?!\/)|^https:\/\//.test(track.url) ||
          /(?:youtube\.com|youtu\.be|spotify\.com)/i.test(track.url) || !track.license || !track.credit ||
          !Number.isFinite(track.duration) || track.duration < 10 || !Number.isFinite(track.bpm) || track.bpm < 40 || track.bpm > 200) {
        throw Error("Audio tracks require an authorized HTTPS/local audio URL, credit, license, duration and BPM");
      }
      return { id: track.id || "authorized-" + index, title: String(track.title || "Authorized track"), kind: "audio", url: track.url,
        credit: String(track.credit), license: String(track.license), duration: track.duration, bpm: track.bpm, style: track.style || "Licensed selection" };
    });
  }
  function createScheduleLedger() {
    const scheduled = new Map();
    return {
      claim(key, wallTime, now) {
        for (const [id, at] of scheduled) if (at < now - 1000) scheduled.delete(id);
        if (scheduled.has(key)) return false;
        scheduled.set(key, wallTime);
        // The normal 125 ms lookahead needs only a handful of entries. Keep a
        // hard bound as well, including unusual system-clock changes.
        while (scheduled.size > 128) scheduled.delete(scheduled.keys().next().value);
        return true;
      },
      clear() { scheduled.clear(); },
      size() { return scheduled.size; }
    };
  }

  let preferences = readPreferences(), tracks = originalTracks, epoch = Date.now(), listener = { inGarden: false }, spatialState = spatial(listener);
  let gardenTracks=originalTracks,sourceKey='garden';
  let context = null, musicGain = null, effectsGain = null, panner = null, lowpass = null, compressor = null, noise = null;
  let unlocked = false, disposed = false, timer = null, lastMixAt = 0, targetGain = 0, settingsPanel = null, muteButton = null, settingsButton = null;
  const scheduledSteps = createScheduleLedger();
  let media = null, mediaSource = null, mediaTrackId = "", mediaAllowed = true, lastMediaAttempt = 0;
  const voices = new Set();

  function stopVoices() {
    for (const source of voices) { try { source.stop(); } catch (_) {} }
    voices.clear();
  }
  function connectVoice(source, nodes, output, stopAt, startAt, offset) {
    let previous = source;
    for (const node of nodes) { previous.connect(node); previous = node; }
    previous.connect(output); voices.add(source);
    source.onended = () => { voices.delete(source); source.disconnect(); nodes.forEach(node => node.disconnect()); };
    if (offset === undefined) source.start(startAt); else source.start(startAt, offset);
    source.stop(stopAt);
  }
  function note(midi, when, duration, level, type, mellow) {
    const oscillator = context.createOscillator(), envelope = context.createGain(), filter = context.createBiquadFilter();
    oscillator.type = type || "triangle"; oscillator.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    filter.type = "lowpass"; filter.frequency.value = mellow ? 1200 : 3400; filter.Q.value = .6;
    envelope.gain.setValueAtTime(.0001, when); envelope.gain.exponentialRampToValueAtTime(Math.max(.0002, level), when + .012);
    envelope.gain.exponentialRampToValueAtTime(Math.max(.0001, level * .36), when + Math.min(.16, duration * .4));
    envelope.gain.exponentialRampToValueAtTime(.0001, when + duration);
    connectVoice(oscillator, [filter, envelope], musicGain, when + duration + .03, when);
  }
  function drum(kind, when, level) {
    if (kind === "kick") {
      const oscillator = context.createOscillator(), envelope = context.createGain();
      oscillator.type = "sine"; oscillator.frequency.setValueAtTime(145, when); oscillator.frequency.exponentialRampToValueAtTime(43, when + .11);
      envelope.gain.setValueAtTime(level, when); envelope.gain.exponentialRampToValueAtTime(.0001, when + .29);
      connectVoice(oscillator, [envelope], musicGain, when + .31, when); return;
    }
    const source = context.createBufferSource(), filter = context.createBiquadFilter(), envelope = context.createGain();
    source.buffer = noise; filter.type = kind === "hat" ? "highpass" : "bandpass"; filter.frequency.value = kind === "hat" ? 7600 : 1900;
    filter.Q.value = kind === "hat" ? .7 : .8;
    const duration = kind === "hat" ? .055 : .16;
    envelope.gain.setValueAtTime(level, when); envelope.gain.exponentialRampToValueAtTime(.0001, when + duration);
    connectVoice(source, [filter, envelope], musicGain, when + duration + .01, when, kind === "hat" ? .2 : .05);
    if (kind !== "hat") note(50, when, .08, level * .16, "triangle", true);
  }
  function playStep(track, step, when) {
    const bar = Math.floor(step / 16) % track.bars, n = step % 16, section = Math.floor(bar / 4), chordIndex = Math.floor(bar / 2) % 4;
    const club = track.id === "neon-express-99", rnb = track.id === "peach-soda-96", breakdown = bar >= 16 && bar < 20;
    const swung = n % 2 ? track.swing : 0, at = when + swung;
    if (!breakdown || n === 0) {
      if (club ? n % 4 === 0 : [0, rnb ? 6 : 7, 10].includes(n) || (bar % 2 && n === 14)) drum("kick", at, club ? .65 : .58);
      if (n === 4 || n === 12) {
        drum("snare", at, .25);
        if (club) { drum("snare", at + .012, .12); drum("snare", at + .025, .075); }
      }
      if (n % 2 === 0 || (bar % 4 === 3 && n > 11)) drum("hat", at, n % 4 === 2 ? .09 : .05);
      if (bar % 8 === 7 && n === 15) drum("snare", at, .08);
    } else if (n % 4 === 2) drum("hat", at, .04);
    const rootNote = track.bass[chordIndex];
    if ([0, 6, 10, 14].includes(n) && (!breakdown || n === 0)) note(rootNote + (n === 14 && bar % 2 ? 12 : 0), at, n === 0 ? .36 : .19, .14, "triangle", true);
    if ((n === 0 || (n === 10 && section > 0)) && (bar >= 2 || breakdown)) {
      const duration = (breakdown ? 3 : 1.6) * 60 / track.bpm;
      track.chords[chordIndex].forEach((pitch, i) => note(pitch, at + i * .008, duration, breakdown ? .022 : .026, "sine", true));
    }
    if (bar >= 4 && !breakdown && n % 2 === 0) {
      const pitch = track.melody[(Math.floor(step / 2) + Math.floor(bar / 8) * 3) % track.melody.length];
      if (pitch !== null) note(pitch + (bar >= 24 && n === 14 ? 12 : 0), at, (club ? .16 : .24), club ? .036 : .032, club ? "triangle" : "sine", false);
    }
    if (bar >= 8 && n === 15 && bar % 2 === 0) note(rootNote + 24, at, .12, .022, "sine", false);
  }
  function setParameter(parameter, value, constant) {
    if (!parameter || !context || context.state === "closed") return;
    parameter.setTargetAtTime(value, context.currentTime, constant || .18);
  }
  function mix(force) {
    const now = Date.now(); if (!force && now - lastMixAt < 80) return; lastMixAt = now;
    spatialState = spatial(listener);
    targetGain = preferences.muted || !preferences.music || root.document?.hidden ? 0 : spatialState.gain * preferences.musicVolume;
    setParameter(musicGain?.gain, targetGain, targetGain ? .32 : .18);
    setParameter(effectsGain?.gain, preferences.muted || !preferences.effects || root.document?.hidden ? 0 : preferences.effectsVolume, .04);
    setParameter(panner?.pan, spatialState.pan, .18);
    setParameter(lowpass?.frequency, 1500 + spatialState.gain * 7000, .2);
  }
  function ensureMedia(track, position, gesture) {
    if (!root.Audio || !context) return;
    if (!media) {
      media = new root.Audio(); media.crossOrigin = "anonymous"; media.preload = "metadata";
      mediaSource = context.createMediaElementSource(media); mediaSource.connect(musicGain);
      media.addEventListener("error", () => { mediaAllowed = false; refreshControls(); });
    }
    if (mediaTrackId !== track.id) {
      mediaTrackId = track.id; media.src = track.url; mediaAllowed = true;
      media.addEventListener("loadedmetadata", () => { if (mediaTrackId === track.id && Number.isFinite(media.duration)) media.currentTime = Math.min(position, Math.max(0, media.duration - .1)); }, { once: true });
    }
    if (Math.abs((media.currentTime || 0) - position) > 1.5 && media.readyState >= 1) media.currentTime = Math.min(position, Math.max(0, (media.duration || track.duration) - .1));
    if (targetGain > .001 && media.paused && mediaAllowed && (gesture || Date.now() - lastMediaAttempt > 1500)) {
      lastMediaAttempt = Date.now(); const result = media.play();
      if (result?.catch) result.catch(() => { mediaAllowed = false; refreshControls(); });
    }
    if (targetGain <= .001 && media && !media.paused) media.pause();
  }
  function tick() {
    if (!context || context.state !== "running" || disposed) return;
    mix(false);
    const now = Date.now(), current = transport(epoch, now, tracks);
    if (current.track.kind === "audio") { ensureMedia(current.track, current.position, false); refreshTrackLabel(current); return; }
    if (media && !media.paused) media.pause();
    if (targetGain <= .001) return;
    let wall = now, count = 0;
    while (wall <= now + 125 && count++ < 5) {
      const time = transport(epoch, wall + 1, tracks), stepMs = 60000 / time.bpm / 4;
      const fraction = (time.beat * 4) - Math.floor(time.beat * 4);
      const stepWall = wall - fraction * stepMs;
      const key = time.cycle + ":" + time.index + ":" + time.step;
      if (stepWall >= now - 12 && scheduledSteps.claim(key, stepWall, now)) {
        if (time.track.kind === "original") playStep(time.track, time.step, context.currentTime + Math.max(.004, (stepWall - now) / 1000));
      }
      wall = stepWall + stepMs + 2;
    }
    refreshTrackLabel(current);
  }
  function createContext() {
    const AudioContext = root.AudioContext || root.webkitAudioContext;
    if (!AudioContext || disposed) return false;
    context = new AudioContext();
    musicGain = context.createGain(); musicGain.gain.value = 0;
    effectsGain = context.createGain(); effectsGain.gain.value = preferences.effectsVolume;
    lowpass = context.createBiquadFilter(); lowpass.type = "lowpass"; lowpass.frequency.value = 8500;
    compressor = context.createDynamicsCompressor(); compressor.threshold.value = -14; compressor.ratio.value = 4;
    compressor.attack.value = .005; compressor.release.value = .18;
    if (context.createStereoPanner) { panner = context.createStereoPanner(); musicGain.connect(panner); panner.connect(lowpass); }
    else musicGain.connect(lowpass);
    lowpass.connect(compressor); effectsGain.connect(compressor); compressor.connect(context.destination);
    noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = noise.getChannelData(0); let seed = 1999;
    for (let i = 0; i < samples.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; samples[i] = ((seed >>> 0) / 4294967295) * 2 - 1; }
    timer = root.setInterval(tick, 25); return true;
  }
  function unlock() {
    if (disposed) return Promise.resolve(false);
    try {
      if (!context && !createContext()) return Promise.resolve(false);
      mediaAllowed = true; mix(true);
      const current = transport(epoch, Date.now(), tracks);
      if (current.track.kind === "audio") ensureMedia(current.track, current.position, true);
      const result = context.state === "running" ? Promise.resolve() : context.resume();
      return result.then(() => { unlocked = context.state === "running"; mix(true); tick(); refreshControls(); return unlocked; }).catch(() => false);
    } catch (_) { return Promise.resolve(false); }
  }
  function update(value) {
    listener = Object.assign({}, value || {});
    const radio=value?.carRadio, index=['boom-bap','rnb','club'].indexOf(radio?.station),key=index>=0?'car:'+radio.vehicleId+':'+radio.station:'garden';
    const nextEpoch=index>=0?radio.epoch:value?.gardenEpoch;
    if(key!==sourceKey || (Number.isFinite(nextEpoch)&&nextEpoch!==epoch)){
      sourceKey=key;tracks=index>=0?[originalTracks[index]]:gardenTracks;epoch=Number.isFinite(nextEpoch)?nextEpoch:epoch;stopVoices();scheduledSteps.clear();
    }
    mix(false);
  }
  function cue(frequency) {
    if (!context || context.state !== "running" || preferences.muted || !preferences.effects || root.document?.hidden) return;
    const oscillator = context.createOscillator(), envelope = context.createGain(), at = context.currentTime;
    oscillator.type = "sine"; oscillator.frequency.value = clamp(Number(frequency) || 580, 120, 1600);
    envelope.gain.setValueAtTime(.06, at); envelope.gain.exponentialRampToValueAtTime(.0001, at + .11);
    connectVoice(oscillator, [envelope], effectsGain, at + .12, at);
  }
  function savePreferences(value) {
    preferences = normalizePreferences(Object.assign({}, preferences, value));
    try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch (_) {}
    mix(true); refreshControls();
  }
  function configureTracks(value) { gardenTracks = validateTracks(value); if(sourceKey==='garden')tracks=gardenTracks; mediaTrackId = ""; stopVoices(); scheduledSteps.clear(); refreshControls(); }
  function horn(level=1) {
    if(!context||context.state!=='running'||preferences.muted||!preferences.effects||root.document?.hidden)return;
    const at=context.currentTime;
    for(const frequency of [330,415]){const oscillator=context.createOscillator(),gain=context.createGain();oscillator.type='triangle';oscillator.frequency.value=frequency;gain.gain.setValueAtTime(.06*clamp(level,0,1),at);gain.gain.exponentialRampToValueAtTime(.0001,at+.24);connectVoice(oscillator,[gain],effectsGain,at+.25,at);}
  }
  function getBeat(now) { return transport(epoch, Number.isFinite(now) ? now : Date.now(), tracks); }
  function getState() {
    const time = getBeat();
    return { preferences: Object.assign({}, preferences), unlocked, contextState: context?.state || "waiting", supported: !!(root.AudioContext || root.webkitAudioContext),
      targetGain, spatialGain: spatialState.gain, pan: spatialState.pan, voices: voices.size, scheduledSteps: scheduledSteps.size(), epoch, title: time.title,
      position: time.position, bpm: time.bpm, playlist: tracks.map(track => ({ id: track.id, title: track.title, kind: track.kind, credit: track.credit })) };
  }
  function refreshTrackLabel(time) {
    if (!settingsPanel) return;
    const label = settingsPanel.querySelector(".city-audio-track");
    const text = (time || getBeat()).title;
    if (label.textContent !== text) label.textContent = text;
  }
  function refreshControls() {
    if (muteButton) {
      muteButton.textContent = preferences.muted ? "🔇" : "♫";
      muteButton.setAttribute("aria-label", preferences.muted ? "ხმის ჩართვა" : "ხმის გამორთვა");
      muteButton.setAttribute("aria-pressed", String(preferences.muted)); muteButton.title = preferences.muted ? "ხმის ჩართვა" : "ხმის გამორთვა";
    }
    if (!settingsPanel) return;
    for (const key of ["music", "effects"]) settingsPanel.querySelector('[data-audio-toggle="' + key + '"]').checked = preferences[key];
    for (const key of ["musicVolume", "effectsVolume"]) {
      settingsPanel.querySelector('[data-audio-volume="' + key + '"]').value = String(Math.round(preferences[key] * 100));
      settingsPanel.querySelector('[data-audio-output="' + key + '"]').textContent = Math.round(preferences[key] * 100) + "%";
    }
    settingsPanel.querySelector(".city-audio-mute").textContent = preferences.muted ? "ხმის ჩართვა" : "ყველა ხმის გამორთვა";
    const status = settingsPanel.querySelector(".city-audio-status");
    const statusText = !(root.AudioContext || root.webkitAudioContext) ? "ამ ბრაუზერში ხმა მიუწვდომელია" : !unlocked ? "ხმა დაიწყება სამყაროსთან შეხებისას" : preferences.muted ? "ხმა გამორთულია" : "ხმა ჩართულია · ბაღის მუსიკა და მანქანის რადიო";
    if (status.textContent !== statusText) status.textContent = statusText;
    refreshTrackLabel();
  }
  function mountControls(options) {
    if (!root.document || settingsPanel) return settingsPanel;
    muteButton = options?.button || root.document.getElementById("soundButton");
    if (!muteButton) return null;
    muteButton.addEventListener("click", () => { savePreferences({ muted: !preferences.muted }); unlock(); });
    settingsButton = root.document.createElement("button"); settingsButton.type = "button"; settingsButton.className = "city-icon-button city-audio-settings-button";
    settingsButton.textContent = "⚙"; settingsButton.setAttribute("aria-label", "ხმისა და მუსიკის პარამეტრები"); settingsButton.setAttribute("aria-expanded", "false");
    settingsButton.setAttribute("aria-controls", "cityAudioPanel"); muteButton.insertAdjacentElement("afterend", settingsButton);
    settingsPanel = root.document.createElement("section"); settingsPanel.id = "cityAudioPanel"; settingsPanel.className = "city-audio-panel"; settingsPanel.hidden = true;
    settingsPanel.setAttribute("role", "dialog"); settingsPanel.setAttribute("aria-label", "ხმისა და მუსიკის პარამეტრები");
    settingsPanel.innerHTML = '<header><strong>♫ NIGHT RADIO</strong><button type="button" class="city-audio-close" aria-label="დახურვა">×</button></header>' +
      '<p class="city-audio-status" role="status"></p><label class="city-audio-toggle"><input type="checkbox" data-audio-toggle="music"> მუსიკა</label>' +
      '<label class="city-audio-volume">მუსიკის ხმა <output data-audio-output="musicVolume"></output><input aria-label="მუსიკის ხმა" type="range" min="0" max="100" step="1" data-audio-volume="musicVolume"></label>' +
      '<label class="city-audio-toggle"><input type="checkbox" data-audio-toggle="effects"> ხმოვანი ეფექტები</label>' +
      '<label class="city-audio-volume">ეფექტების ხმა <output data-audio-output="effectsVolume"></output><input aria-label="ეფექტების ხმა" type="range" min="0" max="100" step="1" data-audio-volume="effectsVolume"></label>' +
      '<button type="button" class="city-audio-mute"></button><small>NEON GARDEN · ORIGINAL MIX</small><b class="city-audio-track"></b>';
    (options?.container || root.document.querySelector(".city-app") || root.document.body).appendChild(settingsPanel);
    const close = () => { settingsPanel.hidden = true; settingsButton.setAttribute("aria-expanded", "false"); };
    settingsButton.addEventListener("click", () => { settingsPanel.hidden = !settingsPanel.hidden; settingsButton.setAttribute("aria-expanded", String(!settingsPanel.hidden)); unlock(); });
    settingsPanel.querySelector(".city-audio-close").addEventListener("click", () => { close(); settingsButton.focus(); });
    settingsPanel.querySelector(".city-audio-mute").addEventListener("click", () => { savePreferences({ muted: !preferences.muted }); unlock(); });
    settingsPanel.querySelectorAll("[data-audio-toggle]").forEach(input => input.addEventListener("change", () => { savePreferences({ [input.dataset.audioToggle]: input.checked }); unlock(); }));
    settingsPanel.querySelectorAll("[data-audio-volume]").forEach(input => input.addEventListener("input", () => { savePreferences({ [input.dataset.audioVolume]: Number(input.value) / 100 }); unlock(); }));
    settingsPanel.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); close(); settingsButton.focus(); } });
    root.document.addEventListener("pointerdown", event => { if (!settingsPanel.hidden && !settingsPanel.contains(event.target) && event.target !== settingsButton) close(); });
    refreshControls(); return settingsPanel;
  }
  function visibility() {
    if (!context) return;
    if (root.document.hidden) { stopVoices(); scheduledSteps.clear(); if (media) media.pause(); mix(true); context.suspend().catch(() => {}); }
    else if (unlocked) context.resume().then(() => { mix(true); tick(); }).catch(() => {});
  }
  function gesture(event) { if (event.isTrusted && !event.repeat) unlock(); }
  function dispose() {
    disposed = true; if (timer) root.clearInterval(timer); stopVoices(); if (media) { media.pause(); media.removeAttribute("src"); }
    if (context && context.state !== "closed") context.close().catch(() => {});
    if (root.document) { root.document.removeEventListener("pointerdown", gesture, true); root.document.removeEventListener("keydown", gesture, true); root.document.removeEventListener("visibilitychange", visibility); }
  }
  if (root.document) {
    root.document.addEventListener("pointerdown", gesture, true); root.document.addEventListener("keydown", gesture, true);
    root.document.addEventListener("visibilitychange", visibility);
    root.addEventListener("pagehide", event => { if (!event.persisted) dispose(); });
  }
  return { update, cue, horn, unlock, getBeat, getState, mountControls, configureTracks, setPreferences: savePreferences, dispose,
    model: { defaults, originalTracks, normalizePreferences, spatial, transport, validateTracks, createScheduleLedger } };
});
