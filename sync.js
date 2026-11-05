/* Projektzeit – Datenmodell, Zusammenführen und Dropbox-Abgleich.
 *
 * Datenmodell (eine Datei, lokal und in Dropbox gleich aufgebaut):
 *   { v:1, entries:{ <id>: {...eintrag, updatedAt} }, settings, settingsAt, timer, timerAt }
 * Gelöschte Einträge bleiben als { id, deleted:true, updatedAt } stehen, damit das
 * Löschen auch auf dem anderen Gerät ankommt. Pro Eintrag gewinnt die neuere Änderung.
 */
(function (global) {
  "use strict";

  function emptyState() {
    return { v: 1, entries: {}, settings: null, settingsAt: 0, timer: null, timerAt: 0 };
  }

  function normalizeState(s) {
    const out = emptyState();
    if (!s || typeof s !== "object") return out;
    if (s.entries && typeof s.entries === "object") {
      Object.keys(s.entries).forEach(id => {
        const e = s.entries[id];
        if (e && typeof e === "object") out.entries[id] = Object.assign({}, e, { id });
      });
    }
    out.settings = s.settings && typeof s.settings === "object" ? s.settings : null;
    out.settingsAt = Number(s.settingsAt) || 0;
    out.timer = s.timer && typeof s.timer === "object" && s.timer.startedAt ? s.timer : null;
    out.timerAt = Number(s.timerAt) || 0;
    return out;
  }

  // Deterministisch: bei gleichem Zeitstempel entscheidet der Inhalt, damit beide Geräte gleich enden
  function pickNewer(x, y, tx, ty) {
    if (tx !== ty) return tx > ty ? x : y;
    const sx = JSON.stringify(x), sy = JSON.stringify(y);
    return sx >= sy ? x : y;
  }

  function mergeState(a, b) {
    a = normalizeState(a); b = normalizeState(b);
    const out = emptyState();
    const ids = new Set(Object.keys(a.entries).concat(Object.keys(b.entries)));
    ids.forEach(id => {
      const x = a.entries[id], y = b.entries[id];
      out.entries[id] = !x ? y : !y ? x : pickNewer(x, y, Number(x.updatedAt) || 0, Number(y.updatedAt) || 0);
    });
    if (a.settingsAt === b.settingsAt) {
      out.settings = pickNewer(a.settings, b.settings, 0, 0); out.settingsAt = a.settingsAt;
    } else if (a.settingsAt > b.settingsAt) {
      out.settings = a.settings; out.settingsAt = a.settingsAt;
    } else {
      out.settings = b.settings; out.settingsAt = b.settingsAt;
    }
    if (a.timerAt === b.timerAt) {
      out.timer = pickNewer(a.timer, b.timer, 0, 0); out.timerAt = a.timerAt;
    } else if (a.timerAt > b.timerAt) {
      out.timer = a.timer; out.timerAt = a.timerAt;
    } else {
      out.timer = b.timer; out.timerAt = b.timerAt;
    }
    return out;
  }

  function canonical(s) {
    s = normalizeState(s);
    const entries = {};
    Object.keys(s.entries).sort().forEach(id => {
      const e = s.entries[id], c = {};
      Object.keys(e).sort().forEach(k => { c[k] = e[k]; });
      entries[id] = c;
    });
    return JSON.stringify({ entries, settings: s.settings, settingsAt: s.settingsAt, timer: s.timer, timerAt: s.timerAt });
  }

  function sameState(a, b) { return canonical(a) === canonical(b); }

  /* ---------------- Dropbox (OAuth mit PKCE, ohne Geheimschlüssel) ---------------- */
  const LS_TOKENS = "pz_dbx_tokens";
  const LS_KEY = "pz_dbx_key";
  const SS_PKCE = "pz_dbx_pkce";

  function asciiJson(obj) {
    return JSON.stringify(obj).replace(/[\u007f-￿]/g, c => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4));
  }
  function b64url(bytes) {
    let s = ""; bytes.forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function lsGet(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } }
  function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function DropboxError(message, info) { const e = new Error(message); Object.assign(e, info || {}); return e; }

  const Dropbox = {
    appKey() {
      const cfg = global.PZ_CONFIG && global.PZ_CONFIG.dropboxAppKey;
      return (cfg && String(cfg).trim()) || lsGet(LS_KEY, "") || "";
    },
    setAppKey(k) { lsSet(LS_KEY, String(k || "").trim() || null); },
    redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ""); },
    tokens() { return lsGet(LS_TOKENS, null); },
    connected() { const t = this.tokens(); return !!(t && t.refresh); },

    async connect() {
      const key = this.appKey();
      if (!key) throw DropboxError("Kein Dropbox-App-Key hinterlegt.");
      const rnd = new Uint8Array(48); crypto.getRandomValues(rnd);
      const verifier = b64url(rnd);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      sessionStorage.setItem(SS_PKCE, verifier);
      const p = new URLSearchParams({
        client_id: key, response_type: "code", code_challenge: b64url(digest), code_challenge_method: "S256",
        redirect_uri: this.redirectUri(), token_access_type: "offline"
      });
      location.href = "https://www.dropbox.com/oauth2/authorize?" + p.toString();
    },

    // Nach der Rückkehr von Dropbox: Code gegen Tokens tauschen. Gibt true zurück, wenn verbunden wurde.
    async handleRedirect() {
      const params = new URLSearchParams(location.search);
      const code = params.get("code"), err = params.get("error");
      if (!code && !err) return false;
      history.replaceState(null, "", this.redirectUri());
      if (err) throw DropboxError("Dropbox-Anmeldung abgebrochen.");
      const verifier = sessionStorage.getItem(SS_PKCE);
      sessionStorage.removeItem(SS_PKCE);
      if (!verifier) throw DropboxError("Anmeldung abgelaufen – bitte erneut verbinden.");
      const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
        method: "POST",
        body: new URLSearchParams({ code, grant_type: "authorization_code", code_verifier: verifier, client_id: this.appKey(), redirect_uri: this.redirectUri() })
      });
      if (!res.ok) throw DropboxError("Dropbox-Anmeldung fehlgeschlagen (" + res.status + ").");
      const j = await res.json();
      lsSet(LS_TOKENS, { access: j.access_token, exp: Date.now() + (j.expires_in || 14400) * 1000, refresh: j.refresh_token, account: j.account_id || "" });
      return true;
    },

    async accessToken(force) {
      const t = this.tokens();
      if (!t || !t.refresh) throw DropboxError("Nicht mit Dropbox verbunden.", { auth: true });
      if (!force && t.access && t.exp > Date.now() + 60000) return t.access;
      const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: this.appKey() })
      });
      if (res.status === 400 || res.status === 401) {
        lsSet(LS_TOKENS, null);
        throw DropboxError("Dropbox-Zugang abgelaufen – bitte neu verbinden.", { auth: true });
      }
      if (!res.ok) throw DropboxError("Dropbox nicht erreichbar (" + res.status + ").", { offline: true });
      const j = await res.json();
      t.access = j.access_token; t.exp = Date.now() + (j.expires_in || 14400) * 1000;
      lsSet(LS_TOKENS, t);
      return t.access;
    },

    async call(url, init, retried) {
      let res;
      try {
        const token = await this.accessToken(retried);
        init.headers = Object.assign({}, init.headers, { Authorization: "Bearer " + token });
        res = await fetch(url, init);
      } catch (e) {
        if (e.auth) throw e;
        throw DropboxError("Keine Verbindung zu Dropbox.", { offline: true });
      }
      if (res.status === 401 && !retried) return this.call(url, init, true);
      return res;
    },

    // -> { text, rev } oder null, wenn die Datei noch nicht existiert
    async download(path) {
      const res = await this.call("https://content.dropboxapi.com/2/files/download", {
        method: "POST", headers: { "Dropbox-API-Arg": asciiJson({ path }) }
      });
      if (res.status === 409) {
        const t = await res.text();
        if (t.indexOf("not_found") >= 0) return null;
        throw DropboxError("Dropbox-Fehler: " + t);
      }
      if (!res.ok) throw DropboxError("Dropbox-Download fehlgeschlagen (" + res.status + ").");
      const text = await res.text();
      let rev = null;
      try { rev = JSON.parse(res.headers.get("Dropbox-API-Result") || "{}").rev || null; } catch (e) {}
      if (!rev) rev = await this.rev(path);
      return { text, rev };
    },

    async rev(path) {
      const res = await this.call("https://api.dropboxapi.com/2/files/get_metadata", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path })
      });
      if (!res.ok) return null;
      const j = await res.json();
      return j.rev || null;
    },

    // rev = null -> Datei neu anlegen; sonst nur überschreiben, wenn sich nichts geändert hat
    async upload(path, body, rev, overwrite) {
      const mode = overwrite ? "overwrite" : rev ? { ".tag": "update", update: rev } : "add";
      const res = await this.call("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": asciiJson({ path, mode, autorename: false, mute: true }) },
        body
      });
      if (res.status === 409) throw DropboxError("Konflikt beim Speichern.", { conflict: true });
      if (!res.ok) throw DropboxError("Dropbox-Upload fehlgeschlagen (" + res.status + ").");
      return res.json();
    },

    async disconnect() {
      try { await this.call("https://api.dropboxapi.com/2/auth/token/revoke", { method: "POST" }); } catch (e) {}
      lsSet(LS_TOKENS, null);
    }
  };

  global.PZSync = { emptyState, normalizeState, mergeState, sameState, Dropbox };
})(typeof window !== "undefined" ? window : this);
