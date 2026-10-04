/* Salon Ledger — sign-in, device activation, subscription status and cloud sync.
   © 2026 Hostready LLC. All rights reserved.

   Every salon's records live in one Supabase table ("records"), separated by salon_id.
   The database itself decides who may read or write (salon membership, approved device,
   active subscription), so the app only has to show the right screens. */
(function () {
  const $ = id => document.getElementById(id);
  const LS = k => "ssl:" + k;
  const load = k => { try { return JSON.parse(localStorage.getItem(LS(k))); } catch { return null; } };
  const keep = (k, v) => { try { localStorage.setItem(LS(k), JSON.stringify(v)); } catch {} };
  const drop = k => { try { localStorage.removeItem(LS(k)); } catch {} };

  const CFG = window.SALON_CONFIG || {};
  const say = msg => window.toast ? window.toast(msg) : null;

  /* ---------- this device ---------- */
  function deviceKey() {
    let k = load("deviceKey");
    if (!k) { k = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); keep("deviceKey", k); }
    return k;
  }
  function platform() {
    const ua = navigator.userAgent;
    if (window.Capacitor?.isNativePlatform?.()) return /tablet|SM-T|Tab/i.test(ua) ? "Android tablet" : "Android";
    if (/Electron/.test(ua)) return /Mac/.test(ua) ? "Mac app" : "Windows app";
    if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return "iPad";
    if (/iPhone/.test(ua)) return "iPhone";
    if (/Android/.test(ua)) return "Android browser";
    return /Mac/.test(ua) ? "Mac browser" : "Windows browser";
  }

  /* ---------- screens ---------- */
  const GATES = ["gateCode", "gateLogin", "gateReset", "gateBlocked", "gateLoading"];
  function gate(which) {
    GATES.forEach(id => { const el = $(id); if (el) el.hidden = id !== which; });
    $("gate").hidden = !which;
    $("appShell").hidden = !!which;
  }
  const gateMsg = (id, msg, ok) => { const el = $(id); if (!el) return; el.textContent = msg || ""; el.hidden = !msg; el.style.color = ok ? "var(--income)" : "var(--danger)"; };
  function blocked(title, text, opts = {}) {
    $("blTitle").textContent = title;
    $("blText").textContent = text;
    $("blDevice").textContent = opts.device ? `This device: ${opts.device}` : "";
    $("blRetry").hidden = !opts.retry;
    gate("gateBlocked");
  }

  /* ---------- state ---------- */
  let sb = null, user = null, status = load("status") || null, salonId = null;
  let cache = {}, outbox = [], flushing = false, channel = null, devChannel = null, lastError = "";
  const listeners = {};
  const statusListeners = [];

  function useSalon(id) {
    salonId = id;
    cache = {};
    const saved = load("cache:" + id) || {};
    for (const [col, obj] of Object.entries(saved)) cache[col] = new Map(Object.entries(obj));
    outbox = load("outbox:" + id) || [];
  }

  let persistTimer = null;
  function persist() {
    if (!salonId) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const out = {}; for (const [c, m] of Object.entries(cache)) out[c] = Object.fromEntries(m);
      keep("cache:" + salonId, out);
    }, 400);
  }
  function emit(col) { const m = cache[col] || new Map(); (listeners[col] || []).forEach(f => f(m)); }
  function emitAll() { Object.keys(listeners).forEach(emit); persist(); }
  function listen(col, fn) { (listeners[col] ||= []).push(fn); fn(cache[col] || new Map()); }
  function applyOutbox() { for (const w of outbox) { const m = (cache[w.col] ||= new Map()); w.op === "set" ? m.set(w.id, w.data) : m.delete(w.id); } }

  /* ---------- sync status pill ---------- */
  function syncPill() {
    const el = $("syncStatus"); if (!el) return;
    const n = outbox.length;
    let txt, cls;
    if (lastError) { txt = "Not saving"; cls = "bad"; }
    else if (!navigator.onLine) { txt = n ? `Offline · ${n} waiting` : "Offline"; cls = "warn"; }
    else if (n) { txt = `Saving ${n}…`; cls = "warn"; }
    else { txt = "Synced"; cls = "ok"; }
    el.textContent = txt; el.className = "sync " + cls;
    el.title = lastError || (n ? `${n} change(s) will upload when the connection is back` : "All changes are saved to the cloud");
    const note = $("offline"); if (note) { note.hidden = !lastError; note.textContent = lastError; }
  }

  async function flush() {
    if (flushing || !sb || !user || !salonId || !navigator.onLine) { syncPill(); return; }
    flushing = true; syncPill();
    while (outbox.length) {
      const w = outbox[0];
      const q = w.op === "set"
        ? sb.from("records").upsert({ salon_id: salonId, col: w.col, id: w.id, data: w.data, updated_at: new Date().toISOString(), updated_by: user.email }, { onConflict: "salon_id,col,id" })
        : sb.from("records").delete().match({ salon_id: salonId, col: w.col, id: w.id });
      const { error } = await q;
      if (error) {
        const net = /fetch|network|Failed|timeout/i.test(error.message || "");
        if (net) { lastError = ""; break; }
        if (/row-level security|violates/i.test(error.message || "")) {
          // The database refused it: subscription ended, device blocked, or not allowed for this role.
          await refreshStatus();
          lastError = !status?.salon?.writable ? "Your subscription has ended, so new changes cannot be saved. Renew to continue."
            : !status?.device?.ok ? "This device is not activated, so changes cannot be saved."
            : "You don't have permission to change this. Ask the salon owner.";
          outbox.shift(); keep("outbox:" + salonId, outbox);
          await loadAll();
          continue;
        }
        lastError = `Changes are not being saved: ${error.message}`;
        break;
      }
      lastError = "";
      outbox.shift(); keep("outbox:" + salonId, outbox);
    }
    flushing = false; syncPill();
  }

  const STAFF_LOCKED = ["staff", "services", "settings"];
  function queue(op, col, id, data) {
    if (status?.salon && !status.salon.writable) {
      const e = new Error("Your subscription has ended. You can view and export data, but not add or change entries. Renew to continue.");
      e.code = "readonly"; throw e;
    }
    if (status?.role === "staff" && STAFF_LOCKED.includes(col)) {
      const e = new Error("Only the salon owner can change this."); e.code = "readonly"; throw e;
    }
    outbox = outbox.filter((w, i) => (i === 0 && flushing) || !(w.col === col && w.id === id));
    outbox.push({ op, col, id, data });
    keep("outbox:" + salonId, outbox);
    const m = (cache[col] ||= new Map());
    op === "set" ? m.set(id, data) : m.delete(id);
    emit(col); persist(); flush();
  }

  async function loadAll() {
    if (!sb || !salonId || !navigator.onLine) return;
    const fresh = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("records").select("col,id,data").eq("salon_id", salonId).range(from, from + 999);
      if (error) { if (!/fetch|network/i.test(error.message)) { lastError = `Could not load records: ${error.message}`; syncPill(); } return; }
      for (const r of data) (fresh[r.col] ||= new Map()).set(r.id, r.data);
      if (data.length < 1000) break;
    }
    cache = fresh;
    applyOutbox();
    lastError = ""; emitAll(); syncPill();
  }

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("records-" + salonId)
      .on("postgres_changes", { event: "*", schema: "public", table: "records", filter: "salon_id=eq." + salonId }, p => {
        const pending = (col, id) => outbox.some(w => w.col === col && w.id === id);
        if (p.eventType === "DELETE") { const { col, id } = p.old || {}; if (col && !pending(col, id)) { cache[col]?.delete(id); emit(col); persist(); } }
        else { const r = p.new; if (r && !pending(r.col, r.id)) { (cache[r.col] ||= new Map()).set(r.id, r.data); emit(r.col); persist(); } }
      })
      .subscribe(s => { if (s === "SUBSCRIBED") loadAll(); });
    if (devChannel) sb.removeChannel(devChannel);
    devChannel = sb.channel("devices-" + salonId)
      .on("postgres_changes", { event: "*", schema: "public", table: "devices", filter: "salon_id=eq." + salonId }, () => { refreshStatus(); window.LedgerSync._devicesChanged?.(); })
      .subscribe();
  }

  /* ---------- status: subscription + device ---------- */
  function setStatus(st) {
    status = st; keep("status", st);
    statusListeners.forEach(f => { try { f(st); } catch {} });
  }
  async function refreshStatus() {
    if (!sb || !user || !navigator.onLine) return status;
    const { data, error } = await sb.rpc("my_status");
    if (error || !data) return status;
    setStatus(data);
    if (data.member && data.device && !data.device.ok) showDeviceBlocked(data);
    return data;
  }
  function showDeviceBlocked(st) {
    const d = st.device || {};
    const revoked = d.status === "revoked";
    blocked(revoked ? "This device has been removed" : "This device is not activated yet",
      revoked ? "The salon owner removed this device. Ask the owner or Hostready to activate it again."
              : `The temporary access for this device has ended. Ask the salon owner to approve it in Settings → Devices${st.salon && st.salon.devices_approved >= st.salon.device_limit ? ", or contact Hostready to add a device to your plan" : ""}.`,
      { device: d.name || platform(), retry: true });
  }

  async function afterSignIn() {
    gate("gateLoading");
    let st = null;
    if (navigator.onLine) {
      const { data, error } = await sb.rpc("register_device", { p_key: deviceKey(), p_name: load("deviceName") || platform(), p_platform: platform() });
      if (error) { gateMsg("liMsg", "Could not reach the server: " + error.message); showCodeOrLogin(); return; }
      st = data;
    } else {
      st = status && status.member && status.salon ? status : null;
      if (!st) { blocked("You are offline", "Connect to the internet once to finish signing in on this device.", { retry: true }); return; }
    }
    setStatus(st);
    const code = (load("salonCode") || "").toUpperCase();
    if (!st.member) {
      if (st.admin) { startApp(null); return; }
      blocked("No salon linked to this login", "This login is not part of any salon yet. Ask your salon owner or Hostready to add you.", {});
      return;
    }
    if (code && st.salon.code.toUpperCase() !== code && !st.admin) {
      await sb.auth.signOut();
      gateMsg("liMsg", "This login belongs to a different salon. Check the Salon Code.");
      return;
    }
    keep("salonCode", st.salon.code); keep("salonName", st.salon.name);
    if (!st.device || !st.device.ok) { showDeviceBlocked(st); return; }
    startApp(st.salon.id);
  }

  let started = false;
  function startApp(id) {
    gate(null);
    $("whoami") && ($("whoami").textContent = user.email);
    if (id && salonId !== id) useSalon(id);
    if (!started) { started = true; window.startLedger?.(status); }
    else window.onLedgerStatus?.(status);
    if (id) { subscribe(); flush(); }
    syncPill();
  }

  /* ---------- the db interface the app uses ---------- */
  const snapOf = m => ({ docs: [...m].map(([id, d]) => ({ id, data: () => d })) });
  window.LedgerDB = {
    collection: col => ({
      doc: id => ({ set: async d => queue("set", col, id, d), delete: async () => queue("del", col, id) }),
      onSnapshot: next => listen(col, m => next(snapOf(m))),
    }),
    doc: path => { const [col, id] = path.split("/"); return {
      set: async d => queue("set", col, id, d),
      onSnapshot: next => listen(col, m => next({ exists: m.has(id), data: () => m.get(id) })),
    }; },
  };

  let signOutArmed = false;
  window.LedgerSync = {
    user: () => user,
    status: () => status,
    onStatus: fn => statusListeners.push(fn),
    refresh: refreshStatus,
    rpc: (name, args) => sb.rpc(name, args),
    from: table => sb.from(table),
    deviceKey,
    platform,
    pending: () => outbox.length,
    exportAll: () => { const out = {}; for (const [c, m] of Object.entries(cache)) out[c] = Object.fromEntries(m); return out; },
    importAll: (data) => { let n = 0; for (const [col, docs] of Object.entries(data)) for (const [id, d] of Object.entries(docs)) { queue("set", col, id, d); n++; } return n; },
    setDeviceName: name => keep("deviceName", name),
    signOut: async () => {
      if (outbox.length && !signOutArmed) { signOutArmed = true; say(`${outbox.length} changes haven't uploaded yet. Press Sign out again to sign out anyway.`); setTimeout(() => signOutArmed = false, 4000); return; }
      await sb.auth.signOut();
      location.reload();
    },
    changeSalon: () => { drop("salonCode"); drop("salonName"); drop("status"); (sb ? sb.auth.signOut() : Promise.resolve()).finally(() => location.reload()); },
  };

  /* ---------- boot ---------- */
  async function connect() {
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "ssl-auth" } });
    sb.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") { gate("gateReset"); return; }
      const was = user; user = session?.user || null;
      if (user && !was) setTimeout(afterSignIn, 0);
      if (!user && was) { if (channel) { sb.removeChannel(channel); channel = null; } location.reload(); }
    });
    const { data } = await sb.auth.getSession();
    if (!data.session) showCodeOrLogin();
  }
  function showCodeOrLogin() {
    const code = load("salonCode");
    if (!code) { gate("gateCode"); setTimeout(() => $("scCode").focus(), 50); return; }
    $("liSalon").textContent = load("salonName") || code;
    $("liCodeShow").textContent = code;
    gate("gateLogin");
  }

  window.addEventListener("online", () => { flush(); loadAll(); refreshStatus(); });
  window.addEventListener("offline", syncPill);
  setInterval(flush, 30000);
  setInterval(() => { if (user && salonId) { refreshStatus(); sb.rpc("touch_device"); } }, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && user && salonId) refreshStatus(); });

  document.addEventListener("DOMContentLoaded", () => {
    $("codeForm").addEventListener("submit", async e => {
      e.preventDefault();
      const code = $("scCode").value.trim().toUpperCase();
      if (code.length < 4) { gateMsg("scMsg", "Enter the Salon Code you received from Hostready."); return; }
      gateMsg("scMsg", "Checking…", true);
      try {
        const { data, error } = await sb.rpc("check_salon_code", { p_code: code });
        if (error) throw error;
        if (!data?.ok) { gateMsg("scMsg", "That Salon Code was not found. Check it and try again."); return; }
        keep("salonCode", data.code); keep("salonName", data.name);
        gateMsg("scMsg", ""); showCodeOrLogin();
      } catch { gateMsg("scMsg", "Could not reach the server. Check your internet connection."); }
    });
    $("loginForm").addEventListener("submit", async e => {
      e.preventDefault();
      const email = $("liEmail").value.trim(), pass = $("liPass").value;
      const activating = !$("liConfirmRow").hidden;
      if (activating) {
        if (pass.length < 8) { gateMsg("liMsg", "Choose a password of at least 8 characters."); return; }
        if (pass !== $("liPass2").value) { gateMsg("liMsg", "The two passwords don't match."); return; }
        gateMsg("liMsg", "Activating your account…", true);
        const { data, error } = await sb.auth.signUp({ email, password: pass });
        if (error) { gateMsg("liMsg", /NOT_INVITED|Database error/i.test(error.message) ? "This email hasn't been added to the salon yet. Ask your salon owner or Hostready." : /registered|exists/i.test(error.message) ? "This email already has a password. Use Sign in instead." : error.message); return; }
        if (!data.session) gateMsg("liMsg", "Account created. Check your email to confirm it, then sign in.", true);
        return;
      }
      gateMsg("liMsg", "Signing in…", true);
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) gateMsg("liMsg", /invalid/i.test(error.message) ? "Wrong email or password." : error.message);
      else { gateMsg("liMsg", ""); $("liPass").value = ""; }
    });
    $("liActivate").addEventListener("click", () => {
      const on = $("liConfirmRow").hidden;
      $("liConfirmRow").hidden = !on;
      $("liTitle").textContent = on ? "Activate your account" : "Sign in";
      $("liSubmit").textContent = on ? "Create password" : "Sign in";
      $("liActivate").textContent = on ? "I already have a password" : "First time? Activate your account";
      $("liPass").autocomplete = on ? "new-password" : "current-password";
      gateMsg("liMsg", on ? "Use the email your salon owner or Hostready added for you, and choose a password." : "", true);
    });
    $("liForgot").addEventListener("click", async () => {
      const email = $("liEmail").value.trim();
      if (!email) { gateMsg("liMsg", "Type your email first, then press Forgot password."); return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.protocol.startsWith("http") ? location.origin + location.pathname : undefined });
      gateMsg("liMsg", error ? error.message : "Check your email for a link to set a new password.", !error);
    });
    $("liChange").addEventListener("click", () => { drop("salonCode"); drop("salonName"); gate("gateCode"); });
    $("resetForm").addEventListener("submit", async e => {
      e.preventDefault();
      const p = $("rpPass").value;
      if (p.length < 8) { gateMsg("rpMsg", "Use at least 8 characters."); return; }
      const { error } = await sb.auth.updateUser({ password: p });
      if (error) gateMsg("rpMsg", error.message); else { gateMsg("rpMsg", ""); say("Password updated"); afterSignIn(); }
    });
    $("blRetry").addEventListener("click", () => { if (user) afterSignIn(); else location.reload(); });
    $("blSignOut").addEventListener("click", async () => { try { await sb?.auth.signOut(); } finally { location.reload(); } });

    if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) { blocked("App not configured", "This copy of the app has no server settings. Download the latest version from Hostready.", {}); return; }
    gate("gateLoading");
    connect().catch(() => showCodeOrLogin());
    syncPill();
  });
})();
