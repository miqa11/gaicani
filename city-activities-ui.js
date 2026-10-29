/* Activity discovery and shared in-world controls. Gameplay results come from the server. */
(function (root) {
  'use strict';
  const ka = root.GaicaniCityLanguage.label;
  const categories = ['აღმოჩენა', 'სამუშაოები', 'მეგობრებთან', 'გაიკანელები', 'თამაშები', 'კოლექციები'];
  const colors = { 'აღმოჩენა': '#72e9de', 'სამუშაოები': '#ffd68c', 'მეგობრებთან': '#ff8ed5', 'გაიკანელები': '#ffe96c', 'თამაშები': '#bba0ff', 'კოლექციები': '#9acaff' };
  let bridge, world, socket, overlay, panel, content, hud, launcher, message, tabs;
  let snapshot = null, category = 'აღმოჩენა', opened = false, connected = false, pending = false, lastFocus = null, clockOffset = 0;
  let lastActiveKey = '', menuKey = '', sequence = 0, renderers = new Map(), liveRenderer = null, photos = [];
  const node = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
  const button = (text, action, className = '') => { const e = node('button', className, text); e.type = 'button'; e.addEventListener('click', action); return e; };
  const catalog = () => (snapshot?.catalog || root.GaicaniCityActivitiesData?.activities || []).filter(a => snapshot?.capabilities?.includes(a.id));
  const find = id => catalog().find(a => a.id === id);
  const now = () => Date.now() + clockOffset;
  function locationOf(activity) { return activity?.location || activity?.target || null; }
  function distanceTo(location) { const self = bridge?.getSelf(); return self && location ? Math.hypot(self.x - location.x, self.y - location.y) : Infinity; }
  function status(text, error = false) { if (!message) return; message.textContent = text || ''; message.classList.toggle('is-error', error); }
  function accept(state) {
    if (!state || typeof state !== 'object') return;
    snapshot = state;
    if (Number.isFinite(state.serverTime)) clockOffset = state.serverTime - Date.now();
    // Position/timer pushes must not reset a selected trail or move keyboard focus.
    const nextMenuKey = JSON.stringify([state.capabilities, state.profile, state.leaderboards]);
    if (opened && nextMenuKey !== menuKey) { menuKey = nextMenuKey; render(); }
    updateHud();
  }
  function requestState() {
    if (!socket?.connected) return;
    socket.emit('city:activity:state', {}, result => {
      if (result?.error) status(result.error, true);
      else accept(result?.state || result);
    });
  }
  function command(action, data = {}) {
    if (pending || !socket?.connected) { if (!socket?.connected) status("გასაგრძელებლად ხელახლა დაუკავშირდი ქალაქს.", true); return Promise.resolve(null); }
    pending = true;
    const payload = { ...data, action, requestId: 'activity-' + Date.now().toString(36) + '-' + (++sequence).toString(36) };
    if (action === 'act' || action === 'cancel') payload.token = snapshot?.active?.token;
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending = false; status("ქალაქმა არ უპასუხა. ჯილდო განმეორებით არ მიღებულა.", true); requestState(); resolve(null); }, 5000);
      socket.emit('city:activity:command', payload, result => {
        clearTimeout(timer); pending = false;
        if (result?.state) accept(result.state);
        if (result?.error) { status(result.error, true); bridge?.toast?.(result.error); }
        else { status(result?.message || ''); if (result?.message) bridge?.toast?.(result.message); }
        resolve(result);
      });
    });
  }
  function open(selectedCategory) {
    if (!overlay) return;
    if (categories.includes(selectedCategory)) category = selectedCategory;
    lastFocus = document.activeElement; opened = true; overlay.hidden = false; launcher.setAttribute('aria-expanded', 'true');
    bridge?.stop?.(); render(); requestState(); panel.querySelector('.activities-close').focus();
  }
  function close() {
    if (!opened) return;
    opened = false; overlay.hidden = true; launcher.setAttribute('aria-expanded', 'false');
    if (lastFocus?.isConnected) lastFocus.focus();
  }
  function track(activity) {
    command('track', { activityId: activity.id }).then(result => { if (result?.ok) { close(); bridge?.toast?.("მიჰყევი აქტივობის ნიშნულს: " + activity.name + "."); } });
  }
  function start(activity, options = {}) {
    bridge?.stop?.();
    return command('start', { activityId: activity.id, options }).then(result => { if (result?.ok) { close(); updateHud(); hud.querySelector('.activity-play button,.activity-play input,.activity-play select')?.focus({ preventScroll: true }); } return result; });
  }
  function renderInventory() {
    const profile = snapshot?.profile || {}, inventory = profile.inventory || {}, collection = profile.collection || {};
    const intro = node('p', 'activities-note', profile.registered ? "ინვენტარი და აღმოჩენები შენს ანგარიშზე ინახება." : "სტუმრის აღმოჩენები მხოლოდ ამ ვიზიტის განმავლობაში რჩება. კოლექციების შესანახად და მონეტების მისაღებად დარეგისტრირდი.");
    content.append(intro);
    const consent = node('label', 'activity-consent'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = profile.privacy?.photos === true;
    checkbox.addEventListener('change', () => command('privacy', { value: { photos: checkbox.checked } }));
    consent.append(checkbox, node('span', '', "ახლომდებარე მოთამაშეებს ჩემი პერსონაჟის ფოტოზე გამოჩენის ნება მივცე. თავდაპირველად გამორთულია."));
    content.append(consent);
    if (photos.length) {
      const album = node('div', 'activity-photo-album');
      for (const photo of photos) { const card = node('article'), img = node('img'); img.src = photo.url; img.alt = photo.title; card.append(img, node('strong', '', photo.title), download(photo)); album.append(card); }
      content.append(album);
    }
    const memories = profile.records?.photos || [];
    if (memories.length) {
      const journal = node('div', 'activity-photo-journal'); journal.append(node('h3', '', 'ფოტოაღმოჩენების ალბომი'));
      for (const photo of memories.slice(0, 12)) journal.append(node('p', '', (photo.title || photo.subjectId) + ' · ' + ka(photo.type || 'city')));
      journal.append(node('small', 'activities-note', "ალბომში აღმოჩენები ინახება. ფოტოს ფაილები შენს მოწყობილობაზე რჩება."));
      content.append(journal);
    }
    const items = root.GaicaniCityActivitiesData?.items || [];
    const itemList = Array.isArray(items) ? items : Object.values(items);
    const ids = [...new Set([...Object.keys(inventory), ...Object.keys(collection)])];
    if (!ids.length) content.append(node('p', 'activities-empty', "კოლექცია პირველი აღმოჩენით იწყება."));
    const grid = node('div', 'activity-collection-grid');
    for (const id of ids) {
      const item = itemList.find(item => item.id === id), entry = node('article', 'activity-collection-item');
      entry.append(node('strong', '', item?.name || id), node('span', '', "გაქვს: " + (inventory[id] || 0)), node('small', '', "ნაპოვნია: " + (collection[id]?.count || inventory[id] || 0)));
      if (item?.rarity) entry.append(node('small', 'rarity-' + item.rarity, ka(item.rarity)));
      grid.append(entry);
    }
    content.append(grid);
    for (const [label, prefix] of [['თევზების ალბომი', 'fish-'], ['მწერების ალბომი', 'bug-']]) {
      const book = node('section', 'activity-collection-book'); book.append(node('h3', '', label));
      for (const item of itemList.filter(item => item.id.startsWith(prefix))) {
        const found = collection[item.id]?.count || 0;
        book.append(node('p', found ? 'is-found' : '', (found ? '✓ ' : '◇ ') + item.name + ' · ' + (found ? found + " აღმოჩენილი" : "აღმოუჩენელი")));
      }
      content.append(book);
    }
  }
  function render() {
    if (!content) return;
    const selectedTrails = new Map([...content.querySelectorAll('[data-trail]')].map(select => [select.dataset.trail, select.value]));
    const focused = content.contains(document.activeElement) ? { card: document.activeElement.closest('[data-activity-id]')?.dataset.activityId, index: [...(document.activeElement.closest('[data-activity-id]')?.querySelectorAll('button,select,input') || [])].indexOf(document.activeElement) } : null;
    const scrollTop = content.scrollTop;
    tabs.querySelectorAll('button').forEach(b => { const active = b.dataset.category === category; b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1; });
    content.replaceChildren();
    const profile = snapshot?.profile;
    panel.querySelector('.activities-wallet').textContent = profile?.registered ? (profile.coins || 0) + " ვირტუალური მონეტა" : 'სტუმარი';
    if (category === 'კოლექციები') renderInventory();
    const activities = catalog().filter(a => a.category === category);
    if (!activities.length && category !== 'კოლექციები') content.append(node('p', 'activities-empty', snapshot ? "ამ კატეგორიაში ახლა აქტივობები არ არის." : "აქტივობების დაფასთან დაკავშირება…"));
    for (const activity of activities) {
      const card = node('article', 'activity-card'); card.dataset.activityId = activity.id; card.style.setProperty('--activity-accent', colors[category]);
      card.append(node('h3', '', activity.name), node('p', '', activity.description));
      const location = locationOf(activity), info = node('div', 'activity-meta');
      info.append(node('span', '', ka(activity.mode || (activity.multiplayer ? 'multiplayer' : 'solo'))), node('span', '', location?.label || 'ქალაქი'), node('span', '', activity.reward ? "მაქსიმუმ " + activity.reward + " ვირტუალური მონეტა" : 'უფასო აქტივობა'));
      card.append(info);
      const controls = node('div', 'activity-card-actions');
      controls.append(button(snapshot?.tracked === activity.id ? 'მონიშნულია' : 'ადგილის მონიშვნა', () => track(activity)));
      const cooldown = Math.max(0, (profile?.cooldowns?.[activity.id] || 0) - now());
      const options = {};
      if (activity.id === 'treasure') {
        const select = node('select'); select.setAttribute('aria-label', 'განძის მარშრუტი'); select.dataset.trail = activity.id;
        ['დაკარგული კასეტა', 'ჩუმი პეიჯერი', 'ორი მეგობარი, ერთი განძი'].forEach((label, value) => { const o = node('option', '', label); o.value = String(value); select.append(o); });
        if (selectedTrails.has(activity.id)) select.value = selectedTrails.get(activity.id);
        options.trail = Number(select.value);
        select.addEventListener('change', () => { options.trail = Number(select.value); }); card.append(select);
      }
      const begin = button(cooldown > 0 ? "მზად იქნება: " + Math.ceil(cooldown / 1000) + ' წმ' : 'დაწყება', () => start(activity, options), 'activity-primary activity-start');
      begin.disabled = !connected || cooldown > 0;
      controls.append(begin); card.append(controls); content.append(card);
      if (activity.id === 'parkour') {
        const rows = snapshot?.leaderboards?.parkour || [];
        if (rows.length) {
          const scores = node('ol', 'activity-leaderboard'); scores.setAttribute('aria-label', 'პარკურის საუკეთესო დროები');
          for (const row of rows.slice(0, 5)) scores.append(node('li', '', row.name + ' · ' + (row.time / 1000).toFixed(2) + ' წმ'));
          card.append(scores);
        }
      }
    }
    content.scrollTop = scrollTop;
    if (focused?.card) content.querySelector('[data-activity-id="' + focused.card + '"]')?.querySelectorAll('button,select,input')[focused.index]?.focus({ preventScroll: true });
  }
  function updateMenuTimers() {
    if (!opened) return;
    content.querySelectorAll('[data-activity-id]').forEach(card => {
      const begin = card.querySelector('.activity-start'); if (!begin) return;
      const remaining = Math.max(0, (snapshot?.profile?.cooldowns?.[card.dataset.activityId] || 0) - now());
      begin.disabled = !connected || remaining > 0;
      begin.textContent = remaining ? "მზად იქნება: " + Math.ceil(remaining / 1000) + ' წმ' : 'დაწყება';
    });
  }
  function trackedLocation() {
    const active = snapshot?.active;
    return active?.target || locationOf(find(snapshot?.tracked));
  }
  function updateHud() {
    if (!hud) return;
    const active = snapshot?.active, tracked = find(snapshot?.tracked), target = trackedLocation();
    hud.hidden = !connected || (!active && !tracked);
    if (hud.hidden) return;
    const activity = find(active?.id) || tracked;
    // Network progress updates must not erase a half-written answer or a drawing.
    const signature = JSON.stringify([active?.id, active?.token, active?.status, active?.step, active?.challenge?.id, active?.challenge?.type, !!active?.choices, tracked?.id, connected]);
    if (signature !== lastActiveKey) {
      lastActiveKey = signature; liveRenderer?.destroy?.(); liveRenderer = null; hud.replaceChildren();
      const head = node('div', 'activity-hud-head'); head.append(node('strong', '', activity?.name || "ქალაქის აქტივობა"), button('×', () => active ? command('cancel') : command('track', { activityId: null }), 'activity-dismiss'));
      head.lastChild.setAttribute('aria-label', active ? 'აქტივობის დასრულება' : 'მონიშვნის გაუქმება'); hud.append(head);
      hud.append(node('p', 'activity-instruction', active?.instruction || "მიჰყევი ნიშნულს: " + (target?.label || activity?.location?.label || "აქტივობა") + '.'));
      hud.append(node('p', 'activity-distance'));
      const mount = node('div', 'activity-play'); hud.append(mount);
      if (active?.status === 'active') {
        const renderer = renderers.get(active.id) || renderers.get(activity?.kind);
        if (renderer) liveRenderer = renderer({ mount, active, activity, state: snapshot, getState: () => snapshot, command, now, node, button, bridge, world });
        else if (Number.isFinite(active.progress)) { const progress = node('progress'); progress.max = 1; progress.value = active.progress; progress.setAttribute('aria-label', 'აქტივობის მიმდინარეობა'); mount.append(progress); }
      } else if (active) {
        mount.append(node('strong', 'activity-result', active.status === 'success' ? 'შესრულებულია!' : active.status === 'failed' ? 'სცადე ხელახლა' : 'აქტივობა დასრულდა'));
        if (Number.isFinite(active.time)) mount.append(node('span', 'activity-clock', (active.time / 1000).toFixed(2) + ' წმ'));
      } else if (activity) mount.append(button('დაწყება', () => start(activity), 'activity-primary'));
    }
    hud.querySelector('.activity-instruction').textContent = active?.instruction || "მიჰყევი ნიშნულს: " + (target?.label || activity?.location?.label || "აქტივობა") + '.';
    liveRenderer?.update?.(snapshot);
    const label = hud.querySelector('.activity-distance'), distance = distanceTo(target);
    label.textContent = Number.isFinite(distance) ? Math.round(distance) + " ნაბიჯი · " + (target?.label || "დანიშნულება") : '';
  }
  function draw(g, time) {
    if (!snapshot || !bridge?.getSelf() || bridge.getSelf().interiorId) return;
    const target = trackedLocation();
    if (!target || target.interiorId) return;
    g.save(); g.translate(target.x, target.y); g.strokeStyle = '#ffe78c'; g.fillStyle = '#ffe78c'; g.lineWidth = 2;
    g.beginPath(); g.ellipse(0, 0, 17, 8, 0, 0, Math.PI * 2); g.stroke();
    const lift = Math.sin(time / 220) * 3; g.beginPath(); g.moveTo(-6, -25 + lift); g.lineTo(6, -25 + lift); g.lineTo(0, -17 + lift); g.closePath(); g.fill();
    g.restore();
  }
  function drawMini(g, width, height) {
    if (!snapshot || !world) return;
    g.save();
    // Only a few nearby points plus the tracked target keep the tiny map legible.
    const nearby = catalog().filter(a => !a.location?.interiorId).sort((a, b) => distanceTo(a.location) - distanceTo(b.location)).slice(0, 4);
    for (const activity of nearby) { const p = activity.location; if (!p) continue; g.fillStyle = colors[activity.category] || '#ffe78c'; g.fillRect(p.x / world.width * width - 1.5, p.y / world.height * height - 1.5, 3, 3); }
    const target = trackedLocation();
    if (target && !target.interiorId) { const x = target.x / world.width * width, y = target.y / world.height * height; g.strokeStyle = '#fff2a8'; g.lineWidth = 1; g.strokeRect(x - 3, y - 3, 6, 6); }
    g.restore();
  }
  function download(photo) {
    const link = node('a', 'activity-download', 'ფოტოს შენახვა'); link.href = photo.url; link.download = 'gaicani-' + photo.id + '.png'; return link;
  }
  async function keepPhoto(metadata, mount) {
    if (!metadata || !bridge.capturePhoto) { bridge.toast("კამერა მიუწვდომელია. ხელახლა დაკავშირების შემდეგ სცადე."); return; }
    try {
      const canvas = await bridge.capturePhoto(metadata);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('No image');
      const photo = { id: Date.now().toString(36), title: metadata.title || 'ქალაქის ფოტო', url: URL.createObjectURL(blob) };
      photos.unshift(photo); if (photos.length > 12) URL.revokeObjectURL(photos.pop().url);
      if (mount?.isConnected) { const preview = node('img', 'activity-photo-preview'); preview.src = photo.url; preview.alt = photo.title; mount.append(preview, download(photo)); }
      bridge.toast("ფოტო კოლექციებში დაემატა. მოწყობილობაზე შესანახად ჩამოტვირთე სურათი.");
    } catch (_) { bridge.toast("ფოტო ვერ შეინახა. სცადე ხელახლა."); }
  }
  function timingRenderer({ mount, getState, command, now, bridge }) {
    const canvas = node('canvas', 'activity-timing-canvas'); canvas.width = 480; canvas.height = 130; canvas.setAttribute('aria-label', "დროის მაჩვენებელი: დააჭირე, როცა ნიშნული განათებულ მონაკვეთში მოხვდება");
    const label = node('p', 'activity-timing-status'), hit = button('მოემზადე…', () => { const c = getState()?.active?.challenge; if (c) command('act', { verb: c.verb }); }, 'activity-primary activity-hit');
    label.setAttribute('role', 'status');
    mount.append(canvas, label, hit, node('small', 'activities-note', "ნიშნის გამოჩენისას შეეხე ღილაკს ან დააჭირე შეყვანის ღილაკს.")); let frame, sounded = false, announced = '';
    function key(event) {
      if (event.key !== 'Enter' || event.repeat || opened || /INPUT|SELECT|TEXTAREA|BUTTON|A/.test(event.target?.tagName || '') || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); event.stopImmediatePropagation(); hit.click();
    }
    document.addEventListener('keydown', key, true);
    function paint() {
      if (!canvas.isConnected) return;
      const a = getState()?.active, c = a?.challenge, g = canvas.getContext('2d');
      if (!c) { frame = requestAnimationFrame(paint); return; }
      const t = now(), start = a.startedAt, end = c.at + c.windowMs * 2, span = Math.max(1, end - start), x = Math.max(0, Math.min(1, (t - start) / span));
      const inWindow = Math.abs(t - c.at) <= c.windowMs;
      g.fillStyle = a.id === 'bugs' ? '#162d2c' : '#102637'; g.fillRect(0, 0, 480, 130);
      if (a.id === 'bugs') {
        g.fillStyle = '#387350'; for (let n = 0; n < 18; n++) g.fillRect(n * 29, 60 + n % 3 * 4, 4, 20);
        g.strokeStyle = '#f3cfa1'; g.lineWidth = 3; g.beginPath(); g.moveTo(50, 72); g.lineTo(135, 35); g.stroke();
        g.strokeStyle = '#c1f8dc'; g.beginPath(); g.ellipse(149, 29, 24, 17, -.4, 0, Math.PI * 2); g.stroke();
        for (let n = 0; n < 4; n++) { g.beginPath(); g.moveTo(130 + n * 10, 16); g.lineTo(140 + n * 8, 44); g.stroke(); }
        const bx = 340 - x * 185, by = 29 + Math.sin(t / 180) * (inWindow ? 2 : 13);
        g.fillStyle = '#ffe66b33'; g.fillRect(bx - 11, by - 11, 28, 28); g.fillStyle = '#ffe66b'; g.fillRect(bx - 2, by - 2, 8, 8);
        g.fillStyle = '#c6ffd9'; g.fillRect(bx - 7, by - 4, 5, 4); g.fillRect(bx + 6, by - 4, 5, 4);
      } else {
        g.fillStyle = '#67d7ce'; for (let n = 0; n < 8; n++) g.fillRect(n * 65 + Math.sin(t / 450 + n) * 9, 40 + n % 3 * 6, 38, 2);
        g.strokeStyle = '#f3cfa1'; g.lineWidth = 3; g.beginPath(); g.moveTo(18, 49); g.lineTo(120, 9); g.lineTo(227, 50 + (inWindow ? Math.sin(t / 25) * 7 : 0)); g.stroke();
        g.fillStyle = inWindow ? '#ffe884' : '#ff84c7'; g.fillRect(221, 44 + (inWindow ? Math.sin(t / 25) * 7 : 0), 12, 12);
      }
      g.fillStyle = '#30344e'; g.fillRect(15, 90, 450, 23);
      g.fillStyle = '#69c491'; g.fillRect(15 + Math.max(0, (c.at - c.windowMs - start) / span) * 450, 90, Math.max(4, c.windowMs * 2 / span * 450), 23);
      g.fillStyle = '#fff2b1'; g.fillRect(15 + x * 446, 85, 4, 33);
      const text = inWindow ? "ახლა! " + (c.label || c.verb) : t < c.at ? (a.id === 'bugs' ? "დაელოდე მწერის მოახლოებას…" : "დააკვირდი წყალს და დაელოდე ჩაკბეჩას…") : "დრო გავიდა";
      if (text !== announced) { label.textContent = text; announced = text; }
      hit.textContent = c.verb === 'catch' ? 'ბადის მოქნევა' : c.verb === 'reel' ? 'ამოქაჩვა' : (c.label || "დააჭირე");
      if (inWindow && !sounded) { sounded = true; bridge.cue?.(900); }
      frame = requestAnimationFrame(paint);
    }
    frame = requestAnimationFrame(paint); return { destroy() { cancelAnimationFrame(frame); document.removeEventListener('keydown', key, true); } };
  }
  function treasureRenderer({ mount, active, command }) {
    if (active.choices?.length) {
      const form = node('form', 'activity-answer-form'), answer = node('input'), list = node('datalist'); list.id = 'treasureAnswers';
      answer.setAttribute('aria-label', 'განძის საკეტის პასუხი'); answer.setAttribute('list', list.id); answer.enterKeyHint = 'go'; answer.autocomplete = 'off'; answer.maxLength = 30; answer.placeholder = 'ჩაწერე საკეტის პასუხი';
      for (const choice of active.choices) { const option = node('option'); option.value = choice.label; option.label = choice.label; list.append(option); }
      const submit = node('button', 'activity-primary', 'გახსნა'); submit.type = 'submit';
      form.append(node('small', 'activities-note', "მინიშნების სიტყვები: " + active.choices.map(c => c.label).join(' · ')), answer, list, submit); form.addEventListener('submit', e => { e.preventDefault(); if (answer.value.trim()) command('act', { verb: 'solve', value: root.GaicaniCityLanguage.answer(answer.value.trim().toLowerCase()) }); }); mount.append(form);
    } else mount.append(button('ადგილის დათვალიერება', () => command('act', { verb: 'search' }), 'activity-primary'));
  }
  function parkourRenderer({ mount, getState, now }) {
    const progress = node('progress'), score = node('span', 'activity-clock'); progress.max = 1; progress.setAttribute('aria-label', "პარკურის საკონტროლო წერტილების გავლა");
    mount.append(progress, score, node('p', 'activities-note', "მირბინე რგოლთან და ახტი მასში. წერტილები რიგით უნდა გაიარო."));
    return { update() { const a = getState().active; progress.value = a.progress || 0; score.textContent = ((now() - a.startedAt) / 1000).toFixed(1) + "წმ · " + (a.step || 0) + '/' + (a.checkpoints?.length || 5); } };
  }
  function photographyRenderer({ mount, active, getState, command }) {
    const form = node('form', 'activity-camera-form'), subjects = node('select'), frames = node('select'), poses = node('select');
    subjects.setAttribute('aria-label', 'ფოტოს ობიექტი'); frames.setAttribute('aria-label', 'ფოტოს ჩარჩო'); poses.setAttribute('aria-label', 'ფოტოს პოზა');
    function fillSubjects() {
      const before = subjects.value; subjects.replaceChildren();
      for (const subject of getState().active?.subjects || []) { const option = node('option', '', subject.name || subject.label || subject.id); option.value = JSON.stringify({ targetType: subject.type || subject.targetType, targetId: subject.id || subject.targetId }); subjects.append(option); }
      if ([...subjects.options].some(o => o.value === before)) subjects.value = before;
    }
    fillSubjects();
    for (const value of ['neon', 'gold', 'mint']) { const o = node('option', '', (value === 'mint' ? 'პიტნისფერი' : ka(value)) + " ჩარჩო"); o.value = value; frames.append(o); }
    for (const value of ['wave', 'dance']) { const o = node('option', '', ka(value) + " პოზა"); o.value = value; poses.append(o); }
    const shutter = node('button', 'activity-primary', 'ფოტოს გადაღება'); shutter.type = 'submit';
    form.append(subjects, frames, poses, shutter); mount.append(form, node('small', 'activities-note', "ჩანან მხოლოდ თანახმა ახლომდებარე მოთამაშეები. ფოტო შენს მოწყობილობაზე ინახება და ავტომატურად არ ზიარდება."));
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!subjects.value) return;
      const choice = JSON.parse(subjects.value), result = await command('act', { verb: 'capture', value: { ...choice, frame: frames.value, pose: poses.value } });
      if (result?.ok) keepPhoto(result.photo || result.state?.result?.photo, document.querySelector('#cityActivityHud .activity-play'));
    });
    let signature = JSON.stringify(active.subjects);
    return { update() { const subjectsKey = JSON.stringify(getState().active?.subjects); if (signature !== subjectsKey) { signature = subjectsKey; fillSubjects(); } shutter.disabled = !subjects.options.length; } };
  }
  renderers.set('fishing', timingRenderer); renderers.set('bugs', timingRenderer);
  renderers.set('treasure', treasureRenderer); renderers.set('parkour', parkourRenderer); renderers.set('photography', photographyRenderer);
  function mount(options) {
    if (bridge) return;
    bridge = options.bridge; world = options.world; socket = bridge.getSocket(); connected = !!socket?.connected;
    launcher = button('✦ აქტივობები', () => open(), 'activities-launcher'); launcher.id = 'activitiesButton'; launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-controls', 'cityActivities');
    overlay = node('section', 'activities-overlay'); overlay.id = 'cityActivities'; overlay.hidden = true;
    panel = node('div', 'activities-window'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'activitiesTitle');
    const heading = node('header', 'activities-header'), title = node('div'); title.append(node('small', '', 'თბილისი 1999 · ქალაქის ცხოვრება'));
    const h = node('h2', '', 'რას გააკეთებ ამაღამ?'); h.id = 'activitiesTitle'; title.append(h, node('span', 'activities-wallet', 'სტუმარი'));
    const dismiss = button('×', close, 'activities-close'); dismiss.setAttribute('aria-label', 'აქტივობების დახურვა'); heading.append(title, dismiss); panel.append(heading);
    tabs = node('nav', 'activities-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'აქტივობების კატეგორიები');
    categories.forEach(name => { const b = button(name, () => { category = name; render(); }); b.dataset.category = name; b.setAttribute('role', 'tab'); tabs.append(b); });
    tabs.addEventListener('keydown', event => { if (!['ArrowRight', 'ArrowLeft'].includes(event.key)) return; event.preventDefault(); const index = categories.indexOf(category); category = categories[(index + (event.key === 'ArrowRight' ? 1 : -1) + categories.length) % categories.length]; render(); tabs.querySelector('[aria-selected="true"]').focus(); });
    panel.append(tabs); message = node('p', 'activities-status'); message.setAttribute('role', 'status'); panel.append(message);
    content = node('div', 'activities-content'); content.setAttribute('role', 'tabpanel'); panel.append(content, node('footer', 'activities-footer', "ვირტუალური მონეტები მხოლოდ სათამაშო ქულებია. აქტივობის ჯილდოებს ქალაქის სერვერი ამოწმებს."));
    overlay.append(panel); hud = node('section', 'activity-hud'); hud.id = 'cityActivityHud'; hud.setAttribute('aria-label', 'მიმდინარე აქტივობა'); hud.hidden = true;
    document.querySelector('.city-world').append(launcher, overlay, hud);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', event => {
      if (!opened) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
      if (event.key === 'Tab') { const focusable = [...panel.querySelectorAll('button:not(:disabled),input,select,textarea,a[href]')].filter(e => e.offsetParent !== null); const first = focusable[0], last = focusable.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
      if (event.target?.closest('.activities-tabs') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      if (!/INPUT|SELECT|TEXTAREA/.test(event.target?.tagName || '') && ['KeyE', 'KeyF', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) { event.stopImmediatePropagation(); if (event.code !== 'Space') event.preventDefault(); }
    }, true);
    socket.on('city:activity:state', result => accept(result?.state || result));
    socket.on('connect', () => { connected = true; requestState(); });
    socket.on('city:joined', () => { connected = true; requestState(); });
    socket.on('disconnect', () => { connected = false; pending = false; updateHud(); if (opened) { render(); status("კავშირი გაწყდა. შენახული კოლექციების აღსადგენად ხელახლა შემოდი.", true); } });
    setInterval(() => { updateHud(); updateMenuTimers(); }, 250); requestState();
  }
  root.GaicaniCityActivitiesUI = { mount, open, close, draw, drawMini, command, accept, requestState, start, getState: () => snapshot, get blocksMovement() { return opened; }, registerRenderer(id, renderer) { renderers.set(id, renderer); lastActiveKey = ''; updateHud(); } };
})(typeof window !== 'undefined' ? window : globalThis);
