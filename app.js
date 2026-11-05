/* Projektzeit BR Events – eigenständige Version (PWA) mit Dropbox-Abgleich */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const { emptyState, normalizeState, mergeState, sameState, Dropbox } = window.PZSync;

  const MODES = { praesenz: "Präsenz", ho: "Homeoffice" };
  const KINDS = { arbeit: "Arbeit", telefon: "Telefonat", fahrt: "Fahrt" };
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
  const fmtMin = m => { m = Math.max(0, Math.round(m)); return Math.floor(m / 60) + ":" + pad(m % 60); };
  const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const uid = () => "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const eur = n => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
  const dec = n => n.toFixed(2).replace(".", ",");
  const dDE = s => s.split("-").reverse().join(".");

  const DEFAULTS = {
    ratePr: 0, rateHo: 0, rateFa: 0, rateKm: 0, round: 0, name: "", client: "BR Events",
    autoFahrt: false, autoRoute: "", autoMin: 15, autoKm: 0,
    tasks: ["Planung", "Vor-Ort-Termin", "Abstimmung", "Technik", "Dokumentation"],
    showAmounts: false
  };
  const SYNC_FILE = "/projektzeit.json";
  const LS_STATE = "pz_state";

  /* ---------- Zustand ---------- */
  let state = emptyState();
  let entries = [];            // sichtbare (nicht gelöschte) Einträge
  let settings = Object.assign({}, DEFAULTS);
  let timer = null;            // {startedAt, mode, kind, task, pausedAt, pauseMs}
  let mode = "praesenz";
  let kind = "arbeit";
  let viewType = "month";
  let anchor = new Date();
  let editingId = null;

  const kindOf = e => e.kind || "arbeit";
  const catOf = e => kindOf(e) === "fahrt" ? "fahrt" : (e.mode === "ho" ? "ho" : "praesenz");
  const tagText = e => kindOf(e) === "fahrt" ? "Fahrt" : MODES[e.mode] || e.mode;
  const clientName = () => (settings.client || "").trim() || "Auftraggeber";

  function readLocal() {
    try { return normalizeState(JSON.parse(localStorage.getItem(LS_STATE) || "null")); }
    catch (e) { return emptyState(); }
  }
  function writeLocal() {
    try { localStorage.setItem(LS_STATE, JSON.stringify(state)); }
    catch (e) { setSync("Lokaler Speicher voll – bitte Sicherung speichern", true); }
  }
  function applyState() {
    entries = Object.values(state.entries).filter(e => e && !e.deleted && e.date);
    settings = Object.assign({}, DEFAULTS, state.settings || {});
    timer = state.timer && state.timer.startedAt ? state.timer : null;
  }
  function stamp(prev) { return Math.max(Date.now(), (Number(prev) || 0) + 1); }

  function commit() { writeLocal(); applyState(); fillSettings(); render(); scheduleSync(); }

  const store = {
    async saveEntry(e) {
      const old = state.entries[e.id];
      state.entries[e.id] = Object.assign({}, e, { updatedAt: stamp(old && old.updatedAt) });
      commit();
    },
    async deleteEntry(id) {
      const old = state.entries[id];
      state.entries[id] = { id, deleted: true, date: old ? old.date : "", updatedAt: stamp(old && old.updatedAt) };
      commit();
    },
    async setTimer(t) {
      state.timer = t; state.timerAt = stamp(state.timerAt);
      commit();
    },
    async saveSettings(s) {
      state.settings = s; state.settingsAt = stamp(state.settingsAt);
      commit();
    }
  };

  function setSync(t, warn) { $("sync").textContent = t; $("sync").classList.toggle("warn", !!warn); }

  async function run(fn) {
    try { await fn(); }
    catch (e) { setSync("Speichern fehlgeschlagen – bitte erneut versuchen", true); }
  }

  /* ---------- Dropbox-Abgleich ---------- */
  let syncTimer = null, syncing = false, syncAgain = false;
  function scheduleSync(delay) {
    if (!Dropbox.connected()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, delay == null ? 1500 : delay);
  }

  async function syncNow() {
    if (!Dropbox.connected()) { renderSyncBox(); return; }
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    setSync("Gleiche ab …");
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const remote = await Dropbox.download(SYNC_FILE);
        let remoteState = null;
        if (remote) {
          try { remoteState = normalizeState(JSON.parse(remote.text)); }
          catch (e) { throw new Error("Die Datei in Dropbox ist beschädigt."); }
        }
        const merged = mergeState(state, remoteState);
        if (!sameState(merged, state)) {
          state = merged; writeLocal(); applyState(); fillSettings(); render();
          backfill();
        }
        if (remoteState && sameState(merged, remoteState)) break;
        try {
          await Dropbox.upload(SYNC_FILE, JSON.stringify(merged), remote ? remote.rev : null);
          break;
        } catch (e) {
          if (e.conflict && attempt < 3) continue;   // anderes Gerät war schneller: neu laden und zusammenführen
          throw e;
        }
      }
      setSync("Abgeglichen " + hm(new Date()) + " Uhr");
      $("dbxErr").textContent = "";
    } catch (e) {
      if (e.auth) { setSync("Dropbox getrennt – bitte neu verbinden", true); renderSyncBox(); }
      else if (e.offline) setSync("Offline – wird später abgeglichen");
      else { setSync("Abgleich fehlgeschlagen", true); $("dbxErr").textContent = e.message || String(e); }
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; scheduleSync(300); }
    }
  }

  function renderSyncBox() {
    const connected = Dropbox.connected();
    const fixedKey = !!(window.PZ_CONFIG && window.PZ_CONFIG.dropboxAppKey);
    $("dbxState").textContent = connected
      ? "Verbunden. Einträge werden automatisch mit Dropbox abgeglichen (Ordner „Apps“ in deiner Dropbox)."
      : "Nicht verbunden – Einträge liegen nur auf diesem Gerät.";
    $("dbxKeyRow").hidden = connected || fixedKey;
    if (!fixedKey && document.activeElement !== $("dbxKey")) $("dbxKey").value = Dropbox.appKey();
    $("dbxConnect").hidden = connected;
    $("dbxSyncNow").hidden = !connected;
    $("dbxDisconnect").hidden = !connected;
    $("pdfDbx").hidden = !connected;
  }

  $("dbxConnect").addEventListener("click", async () => {
    $("dbxErr").textContent = "";
    if (!(window.PZ_CONFIG && window.PZ_CONFIG.dropboxAppKey)) Dropbox.setAppKey($("dbxKey").value);
    if (!Dropbox.appKey()) { $("dbxErr").textContent = "Bitte zuerst den Dropbox-App-Key eintragen."; return; }
    try { await Dropbox.connect(); }
    catch (e) { $("dbxErr").textContent = e.message || String(e); }
  });
  $("dbxSyncNow").addEventListener("click", () => syncNow());
  $("dbxDisconnect").addEventListener("click", async () => {
    await Dropbox.disconnect();
    renderSyncBox();
    setSync("Nur auf diesem Gerät gespeichert");
  });

  /* ---------- Sicherung / Übernahme ---------- */
  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  $("backupOut").addEventListener("click", () => {
    downloadBlob("Projektzeit_Sicherung_" + ymd(new Date()) + ".json",
      new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
  });
  $("backupIn").addEventListener("click", () => $("backupFile").click());
  $("backupFile").addEventListener("change", async ev => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const incoming = normalizeState(JSON.parse(await file.text()));
      const before = entries.length;
      state = mergeState(state, incoming);
      commit();
      backfill();
      $("backupOk").textContent = "Eingelesen: " + Object.keys(incoming.entries).length + " Einträge (jetzt " + entries.length + ", vorher " + before + ").";
    } catch (e) {
      $("backupOk").textContent = "";
      $("dbxErr").textContent = "Die Datei konnte nicht gelesen werden.";
    }
  });

  /* ---------- Automatische Fahrten bei Präsenz ---------- */
  const minHM = n => { n = ((n % 1440) + 1440) % 1440; return pad(Math.floor(n / 60)) + ":" + pad(n % 60); };
  async function reconcileDay(date, list) {
    const pres = list.filter(e => catOf(e) === "praesenz" && e.date === date);
    const ids = ["auto-hin-" + date, "auto-rueck-" + date];
    const existing = ids.map(id => list.find(e => e.id === id));
    if (!pres.length) {
      for (const ex of existing) if (ex) await store.deleteEntry(ex.id);
      return;
    }
    if (!settings.autoFahrt) return;
    const dur = Math.max(1, Number(settings.autoMin) || 30), km = Math.max(0, Number(settings.autoKm) || 0);
    const first = Math.min(...pres.map(e => toMin(e.start)));
    const last = Math.max(...pres.map(e => toMin(e.end)));
    const route = settings.autoRoute || "Arbeitsweg";
    const want = [
      { id: ids[0], date, start: minHM(first - dur), end: minHM(first), pause: 0, minutes: dur, mode: "praesenz", kind: "fahrt", km, task: route + " (Hinfahrt)", auto: true },
      { id: ids[1], date, start: minHM(last), end: minHM(last + dur), pause: 0, minutes: dur, mode: "praesenz", kind: "fahrt", km, task: route + " (Rückfahrt)", auto: true }
    ];
    for (let i = 0; i < 2; i++) {
      const ex = existing[i], w = want[i];
      if (ex && ex.manual) continue;
      if (ex && ex.start === w.start && ex.end === w.end && ex.minutes === w.minutes && ex.km === w.km && ex.task === w.task) continue;
      w.createdAt = ex ? (ex.createdAt || Date.now()) : Date.now();
      if (ex && ex.billed) w.billed = true;
      await store.saveEntry(w);
    }
  }
  function dayAfter(date, changed, removedId) {
    let l = entries.filter(e => e.date === date && e.id !== removedId && (!changed || e.id !== changed.id));
    if (changed && changed.date === date) l.push(changed);
    return l;
  }
  // Ein gelöschter Auto-Eintrag ist nur ausgeblendet (hidden), damit er nicht neu entsteht
  const allForDay = date => Object.values(state.entries).filter(e => e && !e.deleted && e.date === date);
  let backfilling = false;
  async function backfill() {
    if (!settings.autoFahrt || backfilling) return;
    backfilling = true;
    try {
      const dates = [...new Set(entries.filter(e => catOf(e) === "praesenz").map(e => e.date))];
      for (const d of dates) await reconcileDay(d, allForDay(d));
    } catch (e) {}
    backfilling = false;
  }
  async function saveWithAuto(entry, oldDate) {
    await store.saveEntry(entry);
    await reconcileDay(entry.date, dayAfter(entry.date, entry));
    if (oldDate && oldDate !== entry.date) await reconcileDay(oldDate, dayAfter(oldDate, entry));
  }
  async function deleteWithAuto(e) {
    if (e.auto) { await store.saveEntry(Object.assign({}, e, { hidden: true, manual: true })); return; }
    await store.deleteEntry(e.id);
    await reconcileDay(e.date, dayAfter(e.date, null, e.id));
  }

  /* ---------- Rundung & Beträge ---------- */
  const billMin = m => settings.round > 0 ? Math.ceil(m / settings.round) * settings.round : m;
  const rateOf = c => Number(c === "ho" ? settings.rateHo : c === "fahrt" ? settings.rateFa : settings.ratePr) || 0;
  const rateKm = () => Number(settings.rateKm) || 0;
  const hasRates = () => rateOf("praesenz") > 0 || rateOf("ho") > 0 || rateOf("fahrt") > 0 || rateKm() > 0;
  const eurOf = e => billMin(e.minutes) / 60 * rateOf(catOf(e)) + (kindOf(e) === "fahrt" ? (Number(e.km) || 0) * rateKm() : 0);
  // Stundenzettel: Fahrtzeit zählt als Arbeitszeit (Präsenz-Satz), Kilometer separat
  const eurOfExport = e => kindOf(e) === "fahrt"
    ? billMin(e.minutes) / 60 * rateOf("praesenz") + (Number(e.km) || 0) * rateKm()
    : eurOf(e);
  const isBilled = e => kindOf(e) === "fahrt" && !!e.billed;

  /* ---------- Doppelte Einträge erkennen ---------- */
  const dupKey = e => [e.date, e.start, e.end, kindOf(e), e.mode, e.task || ""].join("|");
  function duplicateIds(list) {
    const seen = {}, dup = new Set();
    list.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).forEach(e => {
      const k = dupKey(e);
      if (seen[k]) dup.add(e.id); else seen[k] = true;
    });
    return dup;
  }

  /* ---------- Stempeluhr ---------- */
  function setMode(m, k) {
    mode = m; kind = k || kind;
    document.querySelectorAll(".mseg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.m === mode)));
    document.querySelectorAll(".kseg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.k === kind)));
    $("clock").dataset.mode = kind === "fahrt" ? "fahrt" : mode;
    $("mseg").hidden = kind === "fahrt";
    $("km").hidden = kind !== "fahrt";
    $("task").placeholder = kind === "fahrt" ? "Strecke, z. B. Leipzig – Messe (optional)"
      : kind === "telefon" ? "Mit wem / worüber? (optional)" : "Woran arbeitest du? (optional)";
  }
  function switchTo(m, k) {
    if (!timer) { setMode(m, k); return; }
    if (timer.mode === m && (timer.kind || "arbeit") === k) return;
    const t = timer;
    run(async () => {
      await stopTimer(t);
      setMode(m, k);
      await store.setTimer({ startedAt: Date.now(), mode: m, kind: k, task: k === (t.kind || "arbeit") ? (t.task || "") : "", pausedAt: null, pauseMs: 0 });
    });
  }
  document.querySelectorAll(".mseg button").forEach(b => b.addEventListener("click", () => switchTo(b.dataset.m, timer ? (timer.kind || "arbeit") : kind)));
  document.querySelectorAll(".kseg button").forEach(b => b.addEventListener("click", () => switchTo(timer ? timer.mode : mode, b.dataset.k)));

  const pauseMsOf = t => (t.pauseMs || 0) + (t.pausedAt ? Date.now() - t.pausedAt : 0);

  async function stopTimer(t) {
    const s = new Date(t.startedAt), e = new Date();
    const pMs = pauseMsOf(t);
    const minutes = Math.round((e - s - pMs) / 60000);
    const k = t.kind || "arbeit";
    if (minutes >= 1) {
      const entry = { id: uid(), date: ymd(s), start: hm(s), end: hm(e), pause: Math.round(pMs / 60000), minutes, mode: t.mode, kind: k, task: t.task || "", createdAt: Date.now() };
      if (k === "fahrt") entry.km = Math.max(0, Number($("km").value) || 0);
      await saveWithAuto(entry);
    }
    $("km").value = "";
    await store.setTimer(null);
  }

  let goBusy = false;   // verhindert doppelte Einträge durch Doppelklick
  $("go").addEventListener("click", () => {
    if (goBusy) return;
    goBusy = true;
    run(async () => {
      if (timer) { await stopTimer(timer); $("task").value = ""; }
      else await store.setTimer({ startedAt: Date.now(), mode, kind, task: $("task").value.trim(), pausedAt: null, pauseMs: 0 });
    }).finally(() => { setTimeout(() => { goBusy = false; }, 600); });
  });

  $("pauseBtn").addEventListener("click", () => run(async () => {
    if (!timer) return;
    const t = Object.assign({}, timer);
    if (t.pausedAt) { t.pauseMs = (t.pauseMs || 0) + (Date.now() - t.pausedAt); t.pausedAt = null; }
    else t.pausedAt = Date.now();
    await store.setTimer(t);
  }));

  $("task").addEventListener("keydown", e => { if (e.key === "Enter" && !timer) $("go").click(); });

  function tick() {
    if (!timer) return;
    const now = timer.pausedAt || Date.now();
    const sec = Math.max(0, Math.floor((now - timer.startedAt - (timer.pauseMs || 0)) / 1000));
    $("timer").textContent = Math.floor(sec / 3600) + ":" + pad(Math.floor(sec / 60) % 60) + ":" + pad(sec % 60);
  }
  setInterval(tick, 1000);

  /* ---------- Feste Tätigkeiten ---------- */
  function renderTasks() {
    const chips = $("chips"); chips.textContent = "";
    const dl = $("taskList"); dl.textContent = "";
    (settings.tasks || []).forEach(t => {
      const b = document.createElement("button"); b.textContent = t; b.type = "button";
      b.disabled = !!timer;
      b.addEventListener("click", () => { $("task").value = t; $("task").focus(); });
      chips.appendChild(b);
      const o = document.createElement("option"); o.value = t; dl.appendChild(o);
    });
  }

  /* ---------- Nachtragen & Bearbeiten ---------- */
  function resetForm() {
    editingId = null;
    $("mDate").value = ymd(new Date()); $("mFrom").value = ""; $("mTo").value = "";
    $("mPause").value = 0; $("mTask").value = ""; $("mKm").value = ""; $("mKind").value = "arbeit"; syncKindForm(); $("mErr").textContent = "";
    $("addTitle").textContent = "Zeit nachtragen";
    $("mSave").textContent = "Eintrag speichern";
    $("mCancel").hidden = true;
  }
  function syncKindForm() { const f = $("mKind").value === "fahrt"; $("mModeL").hidden = f; $("mKmL").hidden = !f; }
  $("mKind").addEventListener("change", syncKindForm);

  function startEdit(e) {
    editingId = e.id;
    $("mDate").value = e.date; $("mFrom").value = e.start; $("mTo").value = e.end;
    $("mPause").value = e.pause || 0; $("mMode").value = e.mode === "ho" ? "ho" : "praesenz"; $("mTask").value = e.task || "";
    $("mKind").value = kindOf(e); $("mKm").value = e.km || ""; syncKindForm();
    $("addTitle").textContent = "Eintrag bearbeiten";
    $("mSave").textContent = "Änderungen speichern";
    $("mCancel").hidden = false; $("mErr").textContent = "";
    $("add").open = true;
    $("add").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    $("mFrom").focus({ preventScroll: true });
    render();
  }
  $("mCancel").addEventListener("click", () => { resetForm(); $("add").open = false; render(); });

  $("mSave").addEventListener("click", () => {
    const date = $("mDate").value, from = $("mFrom").value, to = $("mTo").value;
    const pause = Math.max(0, Number($("mPause").value) || 0);
    if (!date || !from || !to) { $("mErr").textContent = "Bitte Datum, Von und Bis ausfüllen."; return; }
    let mins = toMin(to) - toMin(from);
    if (mins <= 0) mins += 1440;
    mins -= pause;
    if (mins <= 0) { $("mErr").textContent = "Die Pause ist länger als die Arbeitszeit."; return; }
    $("mErr").textContent = "";
    const old = editingId ? entries.find(x => x.id === editingId) : null;
    const entry = {
      id: editingId || uid(), date, start: from, end: to, pause, minutes: mins,
      mode: $("mMode").value, kind: $("mKind").value, task: $("mTask").value.trim(), createdAt: old ? (old.createdAt || Date.now()) : Date.now()
    };
    if (entry.kind === "fahrt") entry.km = Math.max(0, Number($("mKm").value) || 0);
    if (old && old.auto) { entry.auto = true; entry.manual = true; }
    if (old && old.billed) entry.billed = true;
    run(async () => {
      await saveWithAuto(entry, old ? old.date : null);
      const wasEdit = !!editingId;
      resetForm();
      if (wasEdit) $("add").open = false;
      anchor = new Date(date + "T12:00");
      render();
    });
  });

  /* ---------- Einstellungen ---------- */
  function fillSettings() {
    if ($("settings").contains(document.activeElement)) return;
    $("sRatePr").value = settings.ratePr || ""; $("sRateHo").value = settings.rateHo || "";
    $("sRateFa").value = settings.rateFa || ""; $("sRateKm").value = settings.rateKm || "";
    $("sRound").value = String(settings.round || 0); $("sName").value = settings.name || "";
    $("sClient").value = settings.client || "";
    $("sAmounts").checked = !!settings.showAmounts;
    $("sAuto").checked = !!settings.autoFahrt; $("sRoute").value = settings.autoRoute || "";
    $("sAutoMin").value = settings.autoMin || ""; $("sAutoKm").value = settings.autoKm || "";
    $("sTasks").value = (settings.tasks || []).join("\n");
  }
  $("sSave").addEventListener("click", () => {
    const s = {
      ratePr: Math.max(0, Number($("sRatePr").value) || 0),
      rateHo: Math.max(0, Number($("sRateHo").value) || 0),
      rateFa: Math.max(0, Number($("sRateFa").value) || 0),
      rateKm: Math.max(0, Number(String($("sRateKm").value).replace(",", ".")) || 0),
      round: Number($("sRound").value) || 0,
      name: $("sName").value.trim(),
      client: $("sClient").value.trim(),
      showAmounts: $("sAmounts").checked,
      autoFahrt: $("sAuto").checked,
      autoRoute: $("sRoute").value.trim(),
      autoMin: Math.max(1, Math.round(Number($("sAutoMin").value) || 30)),
      autoKm: Math.max(0, Number($("sAutoKm").value) || 0),
      tasks: $("sTasks").value.split("\n").map(x => x.trim()).filter(Boolean).slice(0, 30)
    };
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    run(async () => {
      await store.saveSettings(s);
      backfill();
      $("sOk").textContent = "Gespeichert.";
      setTimeout(() => { $("sOk").textContent = ""; }, 2500);
    });
  });

  /* ---------- Zeitraum ---------- */
  function range() {
    if (viewType === "month") {
      const s = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const e = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      return { s, e, label: s.toLocaleDateString("de-DE", { month: "long", year: "numeric" }), key: s.getFullYear() + "-" + pad(s.getMonth() + 1) };
    }
    const s = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
    const e = new Date(s); e.setDate(s.getDate() + 6);
    const t = new Date(s); t.setDate(t.getDate() + 3);
    const y1 = new Date(t.getFullYear(), 0, 4);
    const kw = 1 + Math.round(((t - y1) / 86400000 - 3 + ((y1.getDay() + 6) % 7)) / 7);
    return {
      s, e, kw, label: "KW " + kw + " · " + s.getDate() + "." + (s.getMonth() + 1) + ".–" + e.getDate() + "." + (e.getMonth() + 1) + ".",
      key: t.getFullYear() + "-KW" + pad(kw)
    };
  }
  const inRange = r => { const a = ymd(r.s), b = ymd(r.e); return e => e.date >= a && e.date <= b; };
  const periodEntries = () => entries.filter(e => !e.hidden).filter(inRange(range()))
    .sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));
  const billableEntries = () => periodEntries().filter(e => !isBilled(e));

  document.querySelectorAll(".vseg button").forEach(b => b.addEventListener("click", () => {
    viewType = b.dataset.v;
    document.querySelectorAll(".vseg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    render();
  }));
  function shift(dir) {
    if (viewType === "month") anchor = new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
    else { anchor = new Date(anchor); anchor.setDate(anchor.getDate() + 7 * dir); }
    render();
  }
  $("prev").addEventListener("click", () => shift(-1));
  $("next").addEventListener("click", () => shift(1));

  function sums(list) {
    const o = { pr: 0, ho: 0, fa: 0, bpr: 0, bho: 0, bfa: 0, tel: 0, km: 0, trips: 0, eurPr: 0, eurHo: 0, eurFa: 0 };
    list.forEach(e => {
      const b = billMin(e.minutes), c = catOf(e), m = eurOf(e);
      if (c === "fahrt") { o.fa += e.minutes; o.bfa += b; o.km += Number(e.km) || 0; o.trips += 1; o.eurFa += m; }
      else if (c === "ho") { o.ho += e.minutes; o.bho += b; o.eurHo += m; }
      else { o.pr += e.minutes; o.bpr += b; o.eurPr += m; }
      if (kindOf(e) === "telefon") o.tel += e.minutes;
    });
    o.all = o.pr + o.ho + o.fa; o.ball = o.bpr + o.bho + o.bfa;
    o.eurAll = o.eurPr + o.eurHo + o.eurFa;
    return o;
  }
  function exportSums(list) {
    const o = { pr: 0, ho: 0, bpr: 0, bho: 0, tel: 0, km: 0, trips: 0, eurPr: 0, eurHo: 0, eurKm: 0 };
    list.forEach(e => {
      const b = billMin(e.minutes), c = catOf(e);
      if (c === "fahrt") {
        o.pr += e.minutes; o.bpr += b; o.eurPr += b / 60 * rateOf("praesenz");
        o.km += Number(e.km) || 0; o.trips += 1; o.eurKm += (Number(e.km) || 0) * rateKm();
      } else if (c === "ho") { o.ho += e.minutes; o.bho += b; o.eurHo += b / 60 * rateOf("ho"); }
      else { o.pr += e.minutes; o.bpr += b; o.eurPr += b / 60 * rateOf("praesenz"); }
      if (kindOf(e) === "telefon") o.tel += e.minutes;
    });
    o.all = o.pr + o.ho; o.ball = o.bpr + o.bho;
    o.eurAll = o.eurPr + o.eurHo + o.eurKm;
    return o;
  }

  function render() {
    renderTasks();
    if (timer) {
      setMode(timer.mode, timer.kind || "arbeit");
      $("timer").classList.toggle("running", !timer.pausedAt);
      $("timer").classList.toggle("paused", !!timer.pausedAt);
      $("go").textContent = "Stoppen";
      $("pauseBtn").hidden = false;
      $("pauseBtn").textContent = timer.pausedAt ? "Weiter" : "Pause";
      const s = new Date(timer.startedAt);
      const p = Math.round(pauseMsOf(timer) / 60000);
      $("since").textContent = (timer.pausedAt ? "Pausiert seit " + hm(new Date(timer.pausedAt)) + " Uhr · " : "")
        + ((timer.kind || "arbeit") === "fahrt" ? "Fahrt" : (timer.kind === "telefon" ? "Telefonat, " : "") + MODES[timer.mode]) + " seit " + hm(s) + " Uhr" + (p ? " · " + p + " Min. Pause" : "") + (timer.task ? " · " + timer.task : "");
      if (document.activeElement !== $("task")) $("task").value = timer.task || "";
      $("task").disabled = true;
      tick();
    } else {
      $("timer").classList.remove("running", "paused");
      $("timer").textContent = "0:00:00";
      $("go").textContent = "Starten";
      $("pauseBtn").hidden = true;
      $("since").textContent = "Bereit zum Starten.";
      setMode(mode, kind);
      $("task").disabled = false;
    }

    const r = range();
    $("plabel").textContent = r.label;
    const list = periodEntries();
    const S = sums(list);
    const rounding = settings.round > 0;
    $("tAll").textContent = fmtMin(rounding ? S.ball : S.all);
    $("tPr").textContent = fmtMin(rounding ? S.bpr : S.pr);
    $("tHo").textContent = fmtMin(rounding ? S.bho : S.ho);
    $("tFa").textContent = fmtMin(rounding ? S.bfa : S.fa);
    const rates = hasRates();
    $("eAll").textContent = rates ? eur(S.eurAll) : "";
    $("ePr").textContent = rates && rateOf("praesenz") ? eur(S.eurPr) : "";
    $("eHo").textContent = rates && rateOf("ho") ? eur(S.eurHo) : "";
    $("eFa").textContent = rates && (rateOf("fahrt") || rateKm()) ? eur(S.eurFa) : "";
    $("bP").style.width = S.all ? (S.pr / S.all * 100) + "%" : "0";
    $("bH").style.width = S.all ? (S.ho / S.all * 100) + "%" : "0";
    $("bF").style.width = S.all ? (S.fa / S.all * 100) + "%" : "0";
    const kn = [];
    if (S.tel) kn.push("Davon Telefonate: " + fmtMin(S.tel) + " Std.");
    if (S.km) kn.push("Gefahren: " + S.km.toLocaleString("de-DE") + " km (" + S.trips + " Fahrt" + (S.trips === 1 ? "" : "en") + ")");
    $("knote").textContent = kn.join(" · ");
    $("rnote").hidden = !rounding;
    $("rnote").textContent = rounding ? "Je Eintrag auf " + settings.round + " Min. aufgerundet. Tatsächlich gearbeitet: " + fmtMin(S.all) + " Std." : "";
    const billedCount = list.filter(isBilled).length;
    $("bnote").hidden = !billedCount;
    $("bnote").textContent = billedCount ? billedCount + (billedCount === 1 ? " Fahrt bereits abgerechnet – wird im Stundenzettel (PDF/CSV) nicht berücksichtigt." : " Fahrten bereits abgerechnet – werden im Stundenzettel (PDF/CSV) nicht berücksichtigt.") : "";
    const dups = duplicateIds(list);
    $("dnote").hidden = !dups.size;
    $("dnote").textContent = dups.size ? "Achtung: " + dups.size + (dups.size === 1 ? " Eintrag ist" : " Einträge sind") + " doppelt erfasst (rot markiert). Bitte vor dem Export prüfen." : "";

    const wk = $("week"); wk.textContent = ""; wk.hidden = viewType !== "week";
    if (viewType === "week") {
      const days = [];
      for (let i = 0; i < 7; i++) { const d = new Date(r.s); d.setDate(r.s.getDate() + i); days.push(d); }
      const per = days.map(d => {
        const k = ymd(d); const l = list.filter(e => e.date === k);
        const sm = c => l.filter(e => catOf(e) === c).reduce((a, e) => a + e.minutes, 0);
        return { d, pr: sm("praesenz"), ho: sm("ho"), fa: sm("fahrt") };
      });
      const max = Math.max(480, ...per.map(x => x.pr + x.ho + x.fa));
      per.forEach(x => {
        const w = document.createElement("div"); w.className = "wd";
        const b = document.createElement("b"); b.textContent = (x.pr + x.ho + x.fa) ? fmtMin(x.pr + x.ho + x.fa) : "–";
        const c = document.createElement("div"); c.className = "wcol";
        c.setAttribute("aria-label", x.d.toLocaleDateString("de-DE", { weekday: "long" }) + ": Präsenz " + fmtMin(x.pr) + ", Homeoffice " + fmtMin(x.ho) + ", Fahrt " + fmtMin(x.fa));
        const ip = document.createElement("i"); ip.className = "p"; ip.style.height = (x.pr / max * 100) + "%";
        const ih = document.createElement("i"); ih.className = "h"; ih.style.height = (x.ho / max * 100) + "%";
        const iff = document.createElement("i"); iff.className = "f"; iff.style.height = (x.fa / max * 100) + "%";
        c.append(ip, ih, iff);
        const s = document.createElement("small"); s.textContent = x.d.toLocaleDateString("de-DE", { weekday: "short" });
        w.append(b, c, s); wk.appendChild(w);
      });
    }

    const box = $("days"); box.textContent = "";
    $("pdf").disabled = $("csv").disabled = $("pdfDbx").disabled = !list.length;
    if (!list.length) {
      const p = document.createElement("p"); p.className = "empty";
      p.textContent = (viewType === "week" ? "Keine Einträge in dieser Woche." : "Keine Einträge in diesem Monat.") + " Starte die Uhr oder trage Zeit nach.";
      box.appendChild(p); return;
    }
    const byDay = {};
    list.forEach(e => (byDay[e.date] = byDay[e.date] || []).push(e));
    Object.keys(byDay).sort().reverse().forEach(date => {
      const items = byDay[date];
      const sec = document.createElement("div"); sec.className = "day";
      const dh = document.createElement("div"); dh.className = "dh";
      const b = document.createElement("b");
      b.textContent = new Date(date + "T12:00").toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
      const sum = document.createElement("span");
      sum.textContent = fmtMin(items.reduce((a, e) => a + e.minutes, 0)) + " Std.";
      dh.append(b, sum); sec.appendChild(dh);
      items.forEach(e => sec.appendChild(entryRow(e, rounding, dups.has(e.id))));
      box.appendChild(sec);
    });
  }

  function entryRow(e, rounding, isDup) {
    const row = document.createElement("div"); row.className = "e" + (e.id === editingId ? " editing" : "") + (isBilled(e) ? " billed" : "");
    const tag = document.createElement("span"); tag.className = "tag " + catOf(e); tag.textContent = tagText(e);
    const what = document.createElement("div"); what.className = "what";
    const t1 = document.createElement("div");
    if (kindOf(e) === "telefon") { const k = document.createElement("span"); k.className = "kind"; k.textContent = "Telefonat: "; t1.appendChild(k); }
    t1.appendChild(document.createTextNode(e.task || (kindOf(e) === "fahrt" ? "Fahrt" : kindOf(e) === "telefon" ? "ohne Notiz" : "Ohne Beschreibung")));
    const t2 = document.createElement("small");
    t2.textContent = e.start + " – " + e.end + " Uhr" + (e.pause ? " · " + e.pause + " Min. Pause" : "") + (e.km ? " · " + e.km + " km" : "");
    if (e.auto) { const a = document.createElement("span"); a.className = "auto"; a.textContent = e.manual ? "angepasst" : "automatisch"; t1.appendChild(a); }
    if (isBilled(e)) { const bt = document.createElement("span"); bt.className = "billedTag"; bt.textContent = "bereits abgerechnet"; t1.appendChild(bt); }
    if (isDup) { const dt = document.createElement("span"); dt.className = "dupe"; dt.textContent = "doppelt?"; t1.appendChild(dt); }
    what.append(t1, t2);
    const dur = document.createElement("span"); dur.className = "dur"; dur.textContent = fmtMin(e.minutes);
    if (rounding && billMin(e.minutes) !== e.minutes) {
      const sm = document.createElement("small"); sm.textContent = "abger. " + fmtMin(billMin(e.minutes)); dur.appendChild(sm);
    }
    const acts = document.createElement("div"); acts.className = "acts";
    if (kindOf(e) === "fahrt") {
      const bl = document.createElement("button"); bl.className = "bill" + (isBilled(e) ? " on" : "");
      bl.textContent = isBilled(e) ? "✓ Abgerechnet" : "Abgerechnet?";
      bl.setAttribute("aria-pressed", String(isBilled(e)));
      bl.title = "Fahrtkosten bereits abgerechnet – wird dann im Stundenzettel (PDF/CSV) nicht mehr berücksichtigt";
      bl.addEventListener("click", () => run(() => store.saveEntry(Object.assign({}, e, { billed: !e.billed }))));
      acts.appendChild(bl);
    }
    const ed = document.createElement("button"); ed.textContent = "Bearbeiten";
    ed.addEventListener("click", () => startEdit(e));
    const x = document.createElement("button"); x.className = "del"; x.textContent = "Löschen";
    x.setAttribute("aria-label", "Eintrag " + e.start + " bis " + e.end + " löschen");
    let armT = null;
    x.addEventListener("click", () => {
      if (!x.classList.contains("armed")) {
        x.classList.add("armed"); x.textContent = "Wirklich löschen?";
        armT = setTimeout(() => { x.classList.remove("armed"); x.textContent = "Löschen"; }, 3500);
        return;
      }
      clearTimeout(armT);
      if (editingId === e.id) resetForm();
      run(() => deleteWithAuto(e));
    });
    acts.append(ed, x);
    row.append(tag, what, dur, acts);
    return row;
  }

  /* ---------- Export ---------- */
  function fileBase() { return clientName().replace(/[^A-Za-z0-9ÄÖÜäöüß_-]+/g, "-") + "_Stundenzettel_" + range().key; }
  function flash(msg) { $("xOk").textContent = msg; setTimeout(() => { if ($("xOk").textContent === msg) $("xOk").textContent = ""; }, 5000); }

  $("csv").addEventListener("click", () => {
    $("xErr").textContent = "";
    const list = billableEntries().slice().reverse();
    const q = s => '"' + String(s).replace(/"/g, '""') + '"';
    const money = !!settings.showAmounts;
    const cut = r => money ? r : r.slice(0, 10);
    const rows = [cut(["Datum", "Von", "Bis", "Pause (Min.)", "Dauer (Std.)", "Abgerechnet (Std.)", "Art", "Arbeitsort", "Kilometer", "Tätigkeit", "Betrag (EUR)"]).map(q).join(";")];
    list.forEach(e => {
      const b = billMin(e.minutes);
      rows.push(cut([dDE(e.date), e.start, e.end, e.pause || 0, dec(e.minutes / 60), dec(b / 60),
        KINDS[kindOf(e)], kindOf(e) === "fahrt" ? "" : MODES[e.mode] || e.mode, e.km || "", e.task || "", dec(eurOfExport(e))]).map(q).join(";"));
    });
    const S = exportSums(list);
    rows.push("");
    const sr = (l, a, b, m) => rows.push(cut([q(l), "", "", "", q(dec(a / 60)), q(dec(b / 60)), "", "", "", "", q(dec(m))]).join(";"));
    sr("Summe Präsenz (inkl. Fahrtzeit)", S.pr, S.bpr, S.eurPr);
    sr("Summe Homeoffice", S.ho, S.bho, S.eurHo);
    sr("Gesamt Arbeitszeit", S.all, S.ball, S.eurAll);
    if (S.tel) rows.push([q("Davon Telefonate"), "", "", "", q(dec(S.tel / 60))].join(";"));
    if (S.trips) rows.push([q("Anzahl Fahrten"), "", "", "", "", "", "", "", q(S.trips)].join(";"));
    if (S.km) rows.push([q("Gefahrene Kilometer"), "", "", "", "", "", "", "", q(S.km.toLocaleString("de-DE"))].join(";"));
    if (money && S.km && rateKm()) rows.push([q("Kilometergeld (EUR)"), "", "", "", "", "", "", "", "", "", q(dec(S.eurKm))].join(";"));
    downloadBlob(fileBase() + ".csv", new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  });

  function buildPdf() {
    const r = range();
    const list = billableEntries().slice().reverse();
    const S = exportSums(list);
    const rates = hasRates() && !!settings.showAmounts;
    const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    const L = 15, R = 195;
    let y = 20;
    doc.setFont("helvetica", "bold"); doc.setFontSize(16);
    doc.text("Stundenzettel " + clientName(), L, y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    y += 7;
    const period = viewType === "month" ? r.label : "KW " + r.kw + ", " + dDE(ymd(r.s)) + " - " + dDE(ymd(r.e));
    doc.text("Zeitraum: " + period, L, y);
    if (settings.name) { y += 5; doc.text("Name: " + settings.name, L, y); }
    y += 5; doc.text("Erstellt am " + new Date().toLocaleDateString("de-DE"), L, y);
    if (settings.round > 0) { y += 5; doc.text("Abrechnung je Eintrag auf " + settings.round + " Minuten aufgerundet.", L, y); }

    const cols = rates
      ? [["Datum", L], ["Zeit", 36], ["Pause", 62], ["Ort", 76], ["Tätigkeit", 101], ["Std.", 160], ["Betrag", R]]
      : [["Datum", L], ["Zeit", 36], ["Pause", 62], ["Ort", 76], ["Tätigkeit", 101], ["Std.", R]];
    const taskW = rates ? 54 : 80;
    y += 10;
    const head = () => {
      doc.setFont("helvetica", "bold"); doc.setFontSize(9);
      cols.forEach(([t, x], i) => doc.text(t, x, y, i >= cols.length - (rates ? 2 : 1) ? { align: "right" } : undefined));
      y += 2; doc.setDrawColor(150); doc.line(L, y, R, y); y += 5;
      doc.setFont("helvetica", "normal");
    };
    head();
    list.forEach(e => {
      const b = billMin(e.minutes);
      const label = (kindOf(e) === "telefon" ? "Telefonat: " : "") + (e.task || (kindOf(e) === "fahrt" ? "Fahrt" : kindOf(e) === "telefon" ? "ohne Notiz" : "-")) + (e.km ? " (" + e.km + " km)" : "");
      const lines = doc.splitTextToSize(label, taskW);
      const h = Math.max(1, lines.length) * 4.2 + 1.6;
      if (y + h > 275) { doc.addPage(); y = 20; head(); }
      doc.text(dDE(e.date), L, y);
      doc.text(e.start + " - " + e.end, 36, y);
      doc.text(e.pause ? e.pause + " Min." : "-", 62, y);
      doc.text(kindOf(e) === "fahrt" ? "Fahrt" : (MODES[e.mode] || e.mode), 76, y);
      doc.text(lines, 101, y);
      if (rates) {
        doc.text(dec(b / 60), 160, y, { align: "right" });
        doc.text(dec(eurOfExport(e)) + " EUR", R, y, { align: "right" });
      } else doc.text(dec(b / 60), R, y, { align: "right" });
      y += h;
      doc.setDrawColor(225); doc.line(L, y - 3.2, R, y - 3.2);
    });

    if (y > 245) { doc.addPage(); y = 20; }
    y += 6;
    const sumRow = (label, mins, money, bold) => {
      doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(10);
      doc.text(label, 101, y);
      if (rates) { doc.text(dec(mins / 60) + " Std.", 160, y, { align: "right" }); doc.text(dec(money) + " EUR", R, y, { align: "right" }); }
      else doc.text(dec(mins / 60) + " Std.", R, y, { align: "right" });
      y += 6;
    };
    sumRow("Präsenz (inkl. Fahrtzeit)", S.bpr, S.eurPr);
    sumRow("Homeoffice", S.bho, S.eurHo);
    doc.setDrawColor(150); doc.line(101, y - 4, R, y - 4);
    sumRow("Gesamt Arbeitszeit", S.ball, S.eurAll, true);
    if (S.tel) { doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.text("Davon Telefonate: " + dec(S.tel / 60) + " Std.", 101, y); y += 5; }
    if (S.trips) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
      doc.text(S.trips + " Fahrt" + (S.trips === 1 ? "" : "en") + " · " + S.km.toLocaleString("de-DE") + " km" + (rates && rateKm() ? " · Kilometergeld " + dec(S.eurKm) + " EUR" : ""), 101, y);
      y += 5;
    }
    if (rates) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
      doc.text("Sätze netto: Präsenz/Fahrtzeit " + dec(rateOf("praesenz")) + ", HO " + dec(rateOf("ho")) + " EUR/Std., " + dec(rateKm()) + " EUR/km", 101, y + 1);
      y += 6;
    }
    y = Math.max(y + 20, 255);
    if (y > 280) { doc.addPage(); y = 40; }
    doc.setDrawColor(120);
    doc.line(L, y, L + 70, y); doc.line(R - 70, y, R, y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    doc.text("Datum, Unterschrift Auftragnehmer", L, y + 4);
    doc.text("Datum, Unterschrift " + clientName(), R - 70, y + 4);
    return doc.output("blob");
  }

  function pdfPrecheck() {
    $("xErr").textContent = "";
    if (!window.jspdf) { $("xErr").textContent = "Der PDF-Export konnte nicht geladen werden. Bitte Seite neu laden."; return false; }
    const dups = duplicateIds(periodEntries());
    if (dups.size && !confirmDup()) return false;
    return true;
  }
  // Ohne Browser-Dialog: erster Klick warnt, zweiter Klick innerhalb von 6 Sek. exportiert trotzdem
  let dupArmedUntil = 0;
  function confirmDup() {
    if (Date.now() < dupArmedUntil) { dupArmedUntil = 0; return true; }
    dupArmedUntil = Date.now() + 6000;
    $("xErr").textContent = "Es gibt doppelte Einträge (rot markiert). Bitte prüfen – oder nochmal klicken, um trotzdem zu exportieren.";
    return false;
  }

  $("pdf").addEventListener("click", () => {
    if (!pdfPrecheck()) return;
    downloadBlob(fileBase() + ".pdf", buildPdf());
  });
  $("pdfDbx").addEventListener("click", async () => {
    if (!pdfPrecheck()) return;
    const name = fileBase() + ".pdf";
    try {
      await Dropbox.upload("/Stundenzettel/" + name, buildPdf(), null, true);
      flash("Gespeichert in Dropbox: Apps › Projektzeit › Stundenzettel › " + name);
    } catch (e) {
      $("xErr").textContent = e.offline ? "Keine Verbindung – PDF konnte nicht in Dropbox gespeichert werden." : (e.message || "Speichern in Dropbox fehlgeschlagen.");
    }
  });

  /* ---------- Start ---------- */
  async function boot() {
    state = readLocal();
    applyState(); fillSettings(); resetForm(); render(); renderSyncBox();
    try {
      if (await Dropbox.handleRedirect()) {
        $("syncBox").open = true;
        renderSyncBox();
      }
    } catch (e) { $("dbxErr").textContent = e.message || String(e); $("syncBox").open = true; }
    if (Dropbox.connected()) { syncNow(); }
    else setSync("Nur auf diesem Gerät gespeichert");
    backfill();
    // regelmäßig abgleichen, wenn die App sichtbar ist
    setInterval(() => { if (document.visibilityState === "visible") scheduleSync(0); }, 60000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { render(); scheduleSync(0); } });
    window.addEventListener("online", () => scheduleSync(0));
    // Änderungen aus einem anderen Tab übernehmen
    window.addEventListener("storage", ev => { if (ev.key === LS_STATE) { state = readLocal(); applyState(); fillSettings(); render(); } });
  }

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  boot();
})();
