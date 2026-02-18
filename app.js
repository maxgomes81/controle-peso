// Controle de Peso (PWA) - V3
// Recursos:
// - Múltiplos perfis
// - Cadastro (nome, idade, sexo p/ cálculo, gênero, raça/cor, telefone, endereço)
// - Estimativa de calorias (BMR/TDEE + perder/ganhar)
// - Opções de treino + dias de treino
// - Lembretes via arquivo .ICS (Google Agenda) para notificações confiáveis
// - Migração V2 -> V3 (copia entries antigas p/ perfil padrão)

const DB_NAME = "peso_db";
const DB_VERSION = 2;

const STORE_ENTRIES_OLD = "entries";     // V1/V2: keyPath 'date'
const STORE_SETTINGS_OLD = "settings";   // V1/V2: keyPath 'key'
const STORE_ENTRIES = "entries2";        // V3: keyPath 'key' = profileId|date
const STORE_PROFILES = "profiles";       // V3: keyPath 'id'

const $ = (id) => document.getElementById(id);

const els = {
  // header
  profileSelect: $("profileSelect"),
  manageProfilesBtn: $("manageProfilesBtn"),
  activeProfileLabel: $("activeProfileLabel"),
  installBtn: $("installBtn"),

  // entry
  entryForm: $("entryForm"),
  dateInput: $("dateInput"),
  weightInput: $("weightInput"),
  waistInput: $("waistInput"),
  bfInput: $("bfInput"),
  workoutInput: $("workoutInput"),
  workoutMinInput: $("workoutMinInput"),
  noteInput: $("noteInput"),
  clearBtn: $("clearBtn"),

  // profile form
  profileForm: $("profileForm"),
  nameInput: $("nameInput"),
  ageInput: $("ageInput"),
  sexInput: $("sexInput"),
  genderInput: $("genderInput"),
  raceInput: $("raceInput"),
  phoneInput: $("phoneInput"),
  addressInput: $("addressInput"),
  heightInput: $("heightInput"),
  goalInput: $("goalInput"),
  activityInput: $("activityInput"),
  trainingStyleInput: $("trainingStyleInput"),
  daysBox: $("daysBox"),
  exportCsvBtn: $("exportCsvBtn"),
  exportJsonBtn: $("exportJsonBtn"),
  importBtn: $("importBtn"),
  importFile: $("importFile"),

  // calories
  bmr: $("bmr"),
  tdee: $("tdee"),
  cut: $("cut"),
  cutLite: $("cutLite"),
  bulkLite: $("bulkLite"),
  bulk: $("bulk"),

  // reminders
  weighTime: $("weighTime"),
  trainTime: $("trainTime"),
  icsWeighBtn: $("icsWeighBtn"),
  icsTrainBtn: $("icsTrainBtn"),

  // stats
  lastWeight: $("lastWeight"),
  delta: $("delta"),
  avg7: $("avg7"),
  trend7: $("trend7"),
  bmi: $("bmi"),
  goal: $("goal"),
  toGoal: $("toGoal"),
  waistLast: $("waistLast"),
  bfLast: $("bfLast"),

  chart: $("chart"),
  list: $("list"),
  deleteProfileBtn: $("deleteProfileBtn"),
  deleteAllBtn: $("deleteAllBtn"),

  // modal
  profilesDialog: $("profilesDialog"),
  closeProfilesBtn: $("closeProfilesBtn"),
  newProfileBtn: $("newProfileBtn"),
  renameProfileBtn: $("renameProfileBtn"),
};

let db = null;
let deferredPrompt = null;
let activeProfileId = "default";

const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

// ---------- formatting
function fmt1(n) { return n.toFixed(1).replace(".", ","); }
function fmtKg(n) { return n == null || Number.isNaN(n) ? "—" : `${fmt1(n)} kg`; }
function fmtCm(n) { return n == null || Number.isNaN(n) ? "—" : `${fmt1(n)} cm`; }
function fmtPct(n) { return n == null || Number.isNaN(n) ? "—" : `${fmt1(n)} %`; }
function fmtKcal(n) { return n == null || Number.isNaN(n) ? "—" : `${Math.round(n)} kcal`; }
function fmtDelta(n, unit = "kg") {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  const v = fmt1(n);
  return unit === "kg" ? `${sign}${v} kg` : unit === "cm" ? `${sign}${v} cm` : `${sign}${v} %`;
}
function parseNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v !== "string") return Number(v);
  return Number(v.replace(",", "."));
}
function isoToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function dateToICS(d) {
  // d: Date object -> YYYYMMDD
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
function escapeICS(text) {
  return String(text ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\n", "\\n");
}
function uid() {
  return `${crypto.getRandomValues(new Uint32Array(1))[0]}-${Date.now()}@controle-peso`;
}

// ---------- IndexedDB open + migration
async function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const _db = req.result;
      const tx = req.transaction;

      // create stores if not exist
      if (!_db.objectStoreNames.contains(STORE_PROFILES)) {
        _db.createObjectStore(STORE_PROFILES, { keyPath: "id" });
      }
      if (!_db.objectStoreNames.contains(STORE_ENTRIES)) {
        const s = _db.createObjectStore(STORE_ENTRIES, { keyPath: "key" });
        s.createIndex("byProfile", "profileId", { unique: false });
        s.createIndex("byProfileDate", ["profileId", "date"], { unique: true });
      }

      // ensure default profile exists (we'll upsert later)
      const profiles = tx.objectStore(STORE_PROFILES);
      profiles.put(defaultProfile());

      // migrate old entries -> entries2 if needed
      if (_db.objectStoreNames.contains(STORE_ENTRIES_OLD)) {
        const old = tx.objectStore(STORE_ENTRIES_OLD);
        const newer = tx.objectStore(STORE_ENTRIES);
        old.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const v = cursor.value;
          const date = v.date;
          const key = `default|${date}`;
          newer.put({
            key,
            profileId: "default",
            date,
            weight: Number(v.weight),
            note: v.note ?? "",
            waist_cm: v.waist_cm != null ? Number(v.waist_cm) : null,
            bodyfat_pct: v.bodyfat_pct != null ? Number(v.bodyfat_pct) : null,
            workout: v.workout ?? null,
            workout_min: v.workout_min ?? null,
          });
          cursor.continue();
        };
      }

      // migrate old settings height/goal into default profile (if exists)
      if (_db.objectStoreNames.contains(STORE_SETTINGS_OLD)) {
        const settings = tx.objectStore(STORE_SETTINGS_OLD);
        const profiles2 = tx.objectStore(STORE_PROFILES);

        const pReq = profiles2.get("default");
        pReq.onsuccess = () => {
          const p = pReq.result ?? defaultProfile();
          const hReq = settings.get("height_cm");
          const gReq = settings.get("goal_kg");

          hReq.onsuccess = () => {
            if (hReq.result) p.height_cm = hReq.result.value ?? p.height_cm;
            profiles2.put(p);
          };
          gReq.onsuccess = () => {
            if (gReq.result) p.goal_kg = gReq.result.value ?? p.goal_kg;
            profiles2.put(p);
          };
        };
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = store.put(value);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
function idbGetAll(store, indexName = null, query = null) {
  return new Promise((resolve, reject) => {
    const req = indexName ? store.index(indexName).getAll(query) : store.getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}
function idbClear(store) {
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// ---------- profiles
function defaultProfile() {
  return {
    id: "default",
    name: "Meu Perfil",
    age: null,
    sex: "",
    gender: "",
    race: "",
    phone: "",
    address: "",
    height_cm: null,
    goal_kg: null,
    activity: 1.55,
    training_style: "",
    training_days: [false, true, false, true, false, true, false], // seg/qua/sex
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

async function listProfiles() {
  const store = tx(STORE_PROFILES);
  const all = await idbGetAll(store);
  all.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return all;
}

async function getProfile(id) {
  const store = tx(STORE_PROFILES);
  return await idbGet(store, id);
}

async function saveProfile(p) {
  p.updated_at = Date.now();
  const store = tx(STORE_PROFILES, "readwrite");
  await idbPut(store, p);
}

async function deleteProfile(id) {
  // delete profile + all entries for that profile
  const entriesStore = tx(STORE_ENTRIES, "readwrite");
  const profilesStore = tx(STORE_PROFILES, "readwrite");

  // delete entries by cursor on index
  await new Promise((resolve, reject) => {
    const idx = entriesStore.index("byProfile");
    const req = idx.openCursor(IDBKeyRange.only(id));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return resolve(true);
      entriesStore.delete(cursor.primaryKey);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  await idbDelete(profilesStore, id);
}

// ---------- entries
function entryKey(profileId, date) {
  return `${profileId}|${date}`;
}

async function saveEntry(entry) {
  const store = tx(STORE_ENTRIES, "readwrite");
  await idbPut(store, entry);
}

async function deleteEntry(key) {
  const store = tx(STORE_ENTRIES, "readwrite");
  await idbDelete(store, key);
}

async function listEntries(profileId) {
  const store = tx(STORE_ENTRIES);
  const all = await idbGetAll(store, "byProfile", profileId);
  all.sort((a, b) => (a.date < b.date ? 1 : -1)); // mais recente primeiro
  return all;
}

async function clearAll() {
  await Promise.all([idbClear(tx(STORE_ENTRIES, "readwrite")), idbClear(tx(STORE_PROFILES, "readwrite"))]);
  // recriar default
  await saveProfile(defaultProfile());
}

// ---------- UI helpers
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function computeAvg(entries, n) {
  const slice = entries.slice(0, n);
  if (!slice.length) return null;
  const sum = slice.reduce((acc, e) => acc + e.weight, 0);
  return sum / slice.length;
}

function computeBmi(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const h = heightCm / 100;
  if (h <= 0) return null;
  return weightKg / (h * h);
}

function computeTrend7(entries) {
  if (entries.length < 14) return null;
  const a = entries.slice(0, 7).reduce((s, e) => s + e.weight, 0) / 7;
  const b = entries.slice(7, 14).reduce((s, e) => s + e.weight, 0) / 7;
  return a - b;
}

function movingAverage(values, window) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    const sum = slice.reduce((s, v) => s + v, 0);
    out[i] = sum / slice.length;
  }
  return out;
}

// ---------- calories
function estimateBMR({ sex, age, height_cm, weight_kg }) {
  if (!age || !height_cm || !weight_kg) return null;
  // Mifflin-St Jeor:
  // Men: 10w + 6.25h - 5a + 5
  // Women: 10w + 6.25h - 5a - 161
  // If X/unknown: use midpoint constant (-78)
  const base = 10 * weight_kg + 6.25 * height_cm - 5 * age;
  const c = sex === "M" ? 5 : sex === "F" ? -161 : -78;
  return base + c;
}

function estimateTDEE(bmr, activity) {
  if (!bmr || !activity) return null;
  return bmr * activity;
}

// 7700 kcal ~ 1kg (aprox). 0.5kg/sem => 550 kcal/dia
const DELTA_05 = 7700 * 0.5 / 7;
const DELTA_025 = 7700 * 0.25 / 7;

function renderCalories(profile, entries) {
  const last = entries[0] ?? null;
  const w = last?.weight ?? null;

  const bmr = estimateBMR({ sex: profile.sex, age: profile.age, height_cm: profile.height_cm, weight_kg: w });
  const tdee = estimateTDEE(bmr, Number(profile.activity ?? 1.55));

  els.bmr.textContent = fmtKcal(bmr);
  els.tdee.textContent = fmtKcal(tdee);
  els.cut.textContent = tdee ? fmtKcal(Math.max(1200, tdee - DELTA_05)) : "—";
  els.cutLite.textContent = tdee ? fmtKcal(Math.max(1200, tdee - DELTA_025)) : "—";
  els.bulkLite.textContent = tdee ? fmtKcal(tdee + DELTA_025) : "—";
  els.bulk.textContent = tdee ? fmtKcal(tdee + DELTA_05) : "—";
}

// ---------- render list
function renderList(entries) {
  els.list.innerHTML = "";
  if (!entries.length) {
    els.list.innerHTML = `<div class="muted">Sem registros ainda. Adicione o primeiro peso acima.</div>`;
    return;
  }

  for (const e of entries) {
    const div = document.createElement("div");
    div.className = "item";

    const note = e.note?.trim() ? e.note.trim() : "";
    const waist = Number.isFinite(e.waist_cm) ? `<span class="pill mini">Cintura: ${fmt1(e.waist_cm)} cm</span>` : "";
    const bf = Number.isFinite(e.bodyfat_pct) ? `<span class="pill mini">%G: ${fmt1(e.bodyfat_pct)}%</span>` : "";
    const wo = e.workout ? `<span class="pill mini">Treino: ${escapeHtml(e.workout)}${e.workout_min ? ` (${e.workout_min}m)` : ""}</span>` : "";

    div.innerHTML = `
      <div class="left">
        <div class="date">${e.date}</div>
        <div class="note">${note ? escapeHtml(note) : "<span class='muted'>—</span>"}</div>
      </div>
      <div class="right">
        <span class="pill">${fmtKg(e.weight)}</span>
        ${waist}
        ${bf}
        ${wo}
        <button class="iconbtn" data-edit="${e.key}" title="Editar">Editar</button>
        <button class="iconbtn" data-del="${e.key}" title="Excluir">Excluir</button>
      </div>
    `;

    els.list.appendChild(div);
  }

  els.list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.getAttribute("data-del");
      if (!confirm("Excluir este registro?")) return;
      await deleteEntry(key);
      await refresh(true);
    });
  });

  els.list.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.getAttribute("data-edit");
      const entries = await listEntries(activeProfileId);
      const e = entries.find((x) => x.key === key);
      if (!e) return;

      els.dateInput.value = e.date;
      els.weightInput.value = String(e.weight);
      els.waistInput.value = e.waist_cm ?? "";
      els.bfInput.value = e.bodyfat_pct ?? "";
      els.workoutInput.value = e.workout ?? "";
      els.workoutMinInput.value = e.workout_min ?? "";
      els.noteInput.value = e.note ?? "";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function renderStats(entries, profile) {
  if (!entries.length) {
    els.lastWeight.textContent = "—";
    els.delta.textContent = "—";
    els.avg7.textContent = "—";
    els.trend7.textContent = "—";
    els.bmi.textContent = "—";
    els.goal.textContent = profile.goal_kg ? fmtKg(profile.goal_kg) : "—";
    els.toGoal.textContent = "—";
    els.waistLast.textContent = "—";
    els.bfLast.textContent = "—";
    return;
  }

  const last = entries[0];
  const prev = entries[1] ?? null;

  els.lastWeight.textContent = fmtKg(last.weight);
  els.delta.textContent = prev ? fmtDelta(last.weight - prev.weight, "kg") : "—";

  const avg7 = computeAvg(entries, 7);
  els.avg7.textContent = avg7 ? fmtKg(avg7) : "—";

  const trend = computeTrend7(entries);
  els.trend7.textContent = trend == null ? "—" : fmtDelta(trend, "kg");

  const bmi = computeBmi(last.weight, profile.height_cm);
  els.bmi.textContent = bmi ? bmi.toFixed(1).replace(".", ",") : "—";

  els.goal.textContent = profile.goal_kg ? fmtKg(profile.goal_kg) : "—";
  if (profile.goal_kg != null) {
    const diff = last.weight - profile.goal_kg;
    els.toGoal.textContent = fmtDelta(diff, "kg");
  } else {
    els.toGoal.textContent = "—";
  }

  els.waistLast.textContent = Number.isFinite(last.waist_cm) ? fmtCm(last.waist_cm) : "—";
  els.bfLast.textContent = Number.isFinite(last.bodyfat_pct) ? fmtPct(last.bodyfat_pct) : "—";
}

function drawChart(entries, profile) {
  const canvas = els.chart;
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = 180 * devicePixelRatio;

  ctx.clearRect(0, 0, w, h);

  if (!entries.length) {
    ctx.globalAlpha = 0.7;
    ctx.font = `${14 * devicePixelRatio}px system-ui`;
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText("Sem dados para gráfico.", 12 * devicePixelRatio, 28 * devicePixelRatio);
    ctx.globalAlpha = 1;
    return;
  }

  const data = entries.slice(0, 90).slice().reverse();
  const weights = data.map((e) => e.weight);
  const ma7 = movingAverage(weights, 7);

  const minW = Math.min(...weights);
  const maxW = Math.max(...weights);

  let min = minW, max = maxW;
  if (profile.goal_kg != null) {
    min = Math.min(min, profile.goal_kg);
    max = Math.max(max, profile.goal_kg);
  }

  const pad = 14 * devicePixelRatio;
  const plotW = w - pad * 2;
  const plotH = h - pad * 2;

  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 1 * devicePixelRatio;
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();
  ctx.globalAlpha = 1;

  const range = Math.max(0.1, max - min);
  const xStep = data.length > 1 ? plotW / (data.length - 1) : plotW;
  const yOf = (val) => pad + (max - val) / range * plotH;

  if (profile.goal_kg != null) {
    const y = yOf(profile.goal_kg);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.setLineDash([6 * devicePixelRatio, 6 * devicePixelRatio]);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#fbbf24";
    ctx.font = `${12 * devicePixelRatio}px system-ui`;
    ctx.fillText(`Meta: ${profile.goal_kg.toFixed(1).replace(".", ",")} kg`, pad, Math.max(pad, y - 6 * devicePixelRatio));
    ctx.globalAlpha = 1;
  }

  // peso
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 2.2 * devicePixelRatio;
  ctx.beginPath();
  data.forEach((e, i) => {
    const x = pad + xStep * i;
    const y = yOf(e.weight);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#e5e7eb";
  data.forEach((e, i) => {
    const x = pad + xStep * i;
    const y = yOf(e.weight);
    ctx.beginPath();
    ctx.arc(x, y, 3.0 * devicePixelRatio, 0, Math.PI * 2);
    ctx.fill();
  });

  // média móvel
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "#22c55e";
  ctx.lineWidth = 2.0 * devicePixelRatio;
  ctx.beginPath();
  ma7.forEach((v, i) => {
    if (v == null) return;
    const x = pad + xStep * i;
    const y = yOf(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.globalAlpha = 1;

  // labels min/max
  ctx.fillStyle = "#9ca3af";
  ctx.font = `${12 * devicePixelRatio}px system-ui`;
  ctx.fillText(`${max.toFixed(1).replace(".", ",")} kg`, pad, pad - 2 * devicePixelRatio);
  ctx.fillText(`${min.toFixed(1).replace(".", ",")} kg`, pad, h - 4 * devicePixelRatio);
}

// ---------- CSV/JSON backup
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportCsv(profile, entries) {
  const lines = [];
  lines.push("perfil,data,peso_kg,cintura_cm,bodyfat_pct,treino,treino_min,observacao");

  const chronological = entries.slice().reverse();
  for (const e of chronological) {
    const note = (e.note ?? "").replaceAll('"', '""');
    const waist = e.waist_cm ?? "";
    const bf = e.bodyfat_pct ?? "";
    const wo = e.workout ?? "";
    const wom = e.workout_min ?? "";
    lines.push(`${escapeCSV(profile.name)},${e.date},${String(e.weight)},${waist},${bf},${escapeCSV(wo)},${wom},"${note}"`);
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `controle-peso_${profile.id}_${isoToday()}.csv`);
}
function escapeCSV(s) {
  const t = String(s ?? "");
  if (t.includes(",") || t.includes('"') || t.includes("\n")) return `"${t.replaceAll('"', '""')}"`;
  return t;
}

async function exportJsonAll() {
  const profiles = await listProfiles();
  const entriesStore = tx(STORE_ENTRIES);
  const entries = await idbGetAll(entriesStore);

  const payload = {
    version: 3,
    exported_at: new Date().toISOString(),
    profiles,
    entries,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  downloadBlob(blob, `controle-peso_backup_${isoToday()}.json`);
}

async function importJsonFile(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch {
    alert("Arquivo inválido (JSON)."); return;
  }
  if (!data || !Array.isArray(data.profiles) || !Array.isArray(data.entries)) {
    alert("JSON não está no formato do backup."); return;
  }
  // wipe and restore
  await clearAll();

  // restore profiles
  const ps = tx(STORE_PROFILES, "readwrite");
  for (const p of data.profiles) {
    if (!p?.id) continue;
    await idbPut(ps, normalizeProfile(p));
  }

  // restore entries
  const es = tx(STORE_ENTRIES, "readwrite");
  for (const e of data.entries) {
    if (!e?.profileId || !e?.date || !Number.isFinite(Number(e.weight))) continue;
    const key = e.key ?? entryKey(e.profileId, e.date);
    await idbPut(es, {
      key,
      profileId: e.profileId,
      date: e.date,
      weight: Number(e.weight),
      note: e.note ?? "",
      waist_cm: e.waist_cm != null ? Number(e.waist_cm) : null,
      bodyfat_pct: e.bodyfat_pct != null ? Number(e.bodyfat_pct) : null,
      workout: e.workout ?? null,
      workout_min: e.workout_min != null ? Number(e.workout_min) : null,
    });
  }

  // ensure active profile exists
  const profiles = await listProfiles();
  activeProfileId = profiles[0]?.id ?? "default";

  await refresh(true);
  alert("Importação concluída.");
}

function normalizeProfile(p) {
  const d = defaultProfile();
  return {
    ...d,
    ...p,
    id: String(p.id),
    name: String(p.name ?? d.name).slice(0, 40),
    age: p.age != null ? Number(p.age) : null,
    sex: p.sex ?? "",
    activity: Number(p.activity ?? d.activity),
    training_days: Array.isArray(p.training_days) ? p.training_days.map(Boolean).slice(0,7) : d.training_days,
  };
}

// ---------- reminder (.ics)
function buildICS({ title, description, dtStartDate, timeHHMM, rrule, byday = null }) {
  const [hh, mm] = String(timeHHMM || "07:00").split(":").map((x) => Number(x));
  const dt = new Date(dtStartDate.getFullYear(), dtStartDate.getMonth(), dtStartDate.getDate(), hh || 7, mm || 0, 0);

  const dtStart = `${dateToICS(dt)}T${String(dt.getHours()).padStart(2,"0")}${String(dt.getMinutes()).padStart(2,"0")}00`;
  const stamp = `${dateToICS(new Date())}T000000`;

  let rule = rrule;
  if (byday && byday.length) rule = `${rrule};BYDAY=${byday.join(",")}`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Controle de Peso//PT-BR//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid()}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dtStart}`,
    `SUMMARY:${escapeICS(title)}`,
    `DESCRIPTION:${escapeICS(description)}`,
    `RRULE:${rule}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT10M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeICS(title)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

function downloadICS(text, filename) {
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  downloadBlob(blob, filename);
}

// ---------- profiles UI
function renderDaysCheckboxes(days) {
  els.daysBox.innerHTML = "";
  const cur = Array.isArray(days) ? days : defaultProfile().training_days;
  for (let i = 0; i < 7; i++) {
    const div = document.createElement("label");
    div.className = "day";
    div.innerHTML = `<span>${DAY_NAMES[i]}</span><input type="checkbox" data-day="${i}" ${cur[i] ? "checked" : ""} />`;
    els.daysBox.appendChild(div);
  }
}

function getDaysFromUI() {
  const arr = new Array(7).fill(false);
  els.daysBox.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    const i = Number(cb.getAttribute("data-day"));
    arr[i] = cb.checked;
  });
  return arr;
}

async function renderProfileSelect() {
  const profiles = await listProfiles();
  els.profileSelect.innerHTML = "";
  for (const p of profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name ?? p.id;
    els.profileSelect.appendChild(opt);
  }
  if (!profiles.find((p) => p.id === activeProfileId) && profiles.length) {
    activeProfileId = profiles[0].id;
  }
  els.profileSelect.value = activeProfileId;
}

async function loadProfileIntoForm(profile) {
  els.nameInput.value = profile.name ?? "";
  els.ageInput.value = profile.age ?? "";
  els.sexInput.value = profile.sex ?? "";
  els.genderInput.value = profile.gender ?? "";
  els.raceInput.value = profile.race ?? "";
  els.phoneInput.value = profile.phone ?? "";
  els.addressInput.value = profile.address ?? "";
  els.heightInput.value = profile.height_cm ?? "";
  els.goalInput.value = profile.goal_kg ?? "";
  els.activityInput.value = String(profile.activity ?? 1.55);
  els.trainingStyleInput.value = profile.training_style ?? "";
  renderDaysCheckboxes(profile.training_days);
  els.activeProfileLabel.textContent = `Perfil: ${profile.name ?? profile.id}`;
}

// ---------- main refresh
async function refresh(keepScroll = false) {
  const y = window.scrollY;

  await renderProfileSelect();
  const profile = await getProfile(activeProfileId) ?? defaultProfile();
  await loadProfileIntoForm(profile);

  const entries = await listEntries(activeProfileId);
  renderList(entries);
  renderStats(entries, profile);
  drawChart(entries, profile);
  renderCalories(profile, entries);

  if (keepScroll) window.scrollTo({ top: y });
}

// ---------- events
els.profileSelect.addEventListener("change", async () => {
  activeProfileId = els.profileSelect.value;
  await refresh(true);
});

els.manageProfilesBtn.addEventListener("click", () => els.profilesDialog.showModal());
els.closeProfilesBtn.addEventListener("click", () => els.profilesDialog.close());

els.newProfileBtn.addEventListener("click", async () => {
  const name = prompt("Nome do novo perfil:");
  if (!name) return;
  const id = `p_${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`;
  const p = defaultProfile();
  p.id = id;
  p.name = name.slice(0, 40);
  p.created_at = Date.now();
  await saveProfile(p);
  activeProfileId = id;
  els.profilesDialog.close();
  await refresh(true);
});

els.renameProfileBtn.addEventListener("click", async () => {
  const p = await getProfile(activeProfileId);
  if (!p) return;
  const name = prompt("Novo nome do perfil:", p.name ?? "");
  if (!name) return;
  p.name = name.slice(0, 40);
  await saveProfile(p);
  els.profilesDialog.close();
  await refresh(true);
});

els.profileForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const p = (await getProfile(activeProfileId)) ?? defaultProfile();

  const name = els.nameInput.value.trim();
  if (!name) return alert("Informe o nome.");

  const age = parseNumber(els.ageInput.value);
  if (age != null && (!Number.isFinite(age) || age < 10 || age > 120)) return alert("Idade inválida.");

  const height = parseNumber(els.heightInput.value);
  if (height != null && (!Number.isFinite(height) || height < 80 || height > 250)) return alert("Altura inválida (cm).");

  const goal = parseNumber(els.goalInput.value);
  if (goal != null && (!Number.isFinite(goal) || goal < 20 || goal > 400)) return alert("Meta inválida (kg).");

  p.name = name;
  p.age = age;
  p.sex = els.sexInput.value;
  p.gender = els.genderInput.value;
  p.race = els.raceInput.value;
  p.phone = els.phoneInput.value.trim();
  p.address = els.addressInput.value.trim();
  p.height_cm = height;
  p.goal_kg = goal;
  p.activity = Number(els.activityInput.value || 1.55);
  p.training_style = els.trainingStyleInput.value;
  p.training_days = getDaysFromUI();

  await saveProfile(p);
  await refresh(true);
  alert("Cadastro do perfil salvo.");
});

els.entryForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();

  const date = els.dateInput.value;
  const weight = parseNumber(els.weightInput.value);
  const waist = parseNumber(els.waistInput.value);
  const bf = parseNumber(els.bfInput.value);
  const workout = els.workoutInput.value || null;
  const workoutMin = parseNumber(els.workoutMinInput.value);
  const note = els.noteInput.value ?? "";

  if (!date) return alert("Informe a data.");
  if (!Number.isFinite(weight) || weight <= 0) return alert("Informe um peso válido (kg).");
  if (waist != null && (!Number.isFinite(waist) || waist < 30 || waist > 200)) return alert("Cintura inválida (cm).");
  if (bf != null && (!Number.isFinite(bf) || bf < 1 || bf > 80)) return alert("% gordura inválida.");
  if (workoutMin != null && (!Number.isFinite(workoutMin) || workoutMin < 0 || workoutMin > 600)) return alert("Duração inválida.");

  const key = entryKey(activeProfileId, date);

  await saveEntry({
    key,
    profileId: activeProfileId,
    date,
    weight,
    note,
    waist_cm: waist,
    bodyfat_pct: bf,
    workout,
    workout_min: workoutMin,
  });

  els.noteInput.value = "";
  await refresh(true);
});

els.clearBtn.addEventListener("click", () => {
  els.dateInput.value = isoToday();
  els.weightInput.value = "";
  els.waistInput.value = "";
  els.bfInput.value = "";
  els.workoutInput.value = "";
  els.workoutMinInput.value = "";
  els.noteInput.value = "";
});

els.exportCsvBtn.addEventListener("click", async () => {
  const profile = await getProfile(activeProfileId) ?? defaultProfile();
  const entries = await listEntries(activeProfileId);
  await exportCsv(profile, entries);
});

els.exportJsonBtn.addEventListener("click", async () => {
  await exportJsonAll();
});

els.importBtn.addEventListener("click", () => els.importFile.click());
els.importFile.addEventListener("change", async () => {
  const file = els.importFile.files?.[0];
  els.importFile.value = "";
  if (!file) return;
  if (!confirm("Importar JSON vai substituir seus dados atuais. Continuar?")) return;
  await importJsonFile(file);
});

els.deleteProfileBtn.addEventListener("click", async () => {
  if (activeProfileId === "default") {
    if (!confirm("Apagar o perfil padrão vai remover seus dados desse perfil. Continuar?")) return;
  } else {
    if (!confirm("Apagar este perfil e todos os registros dele?")) return;
  }
  await deleteProfile(activeProfileId);
  const profiles = await listProfiles();
  activeProfileId = profiles[0]?.id ?? "default";
  await refresh(true);
});

els.deleteAllBtn.addEventListener("click", async () => {
  if (!confirm("Tem certeza? Isso apaga TODOS os perfis e registros.")) return;
  await clearAll();
  activeProfileId = "default";
  await refresh(true);
});

// reminders
els.icsWeighBtn.addEventListener("click", async () => {
  const profile = await getProfile(activeProfileId) ?? defaultProfile();
  const text = buildICS({
    title: `Pesagem - ${profile.name}`,
    description: "Lembrete diário de pesagem.",
    dtStartDate: new Date(),
    timeHHMM: els.weighTime.value || "07:00",
    rrule: "FREQ=DAILY",
  });
  downloadICS(text, `lembrete_pesagem_${profile.id}.ics`);
  alert("Arquivo .ICS gerado. Abra-o no celular e importe no Google Agenda (com notificação).");
});

els.icsTrainBtn.addEventListener("click", async () => {
  const profile = await getProfile(activeProfileId) ?? defaultProfile();
  const days = profile.training_days ?? defaultProfile().training_days;
  const map = ["SU","MO","TU","WE","TH","FR","SA"];
  const byday = [];
  for (let i=0;i<7;i++) if (days[i]) byday.push(map[i]);
  if (!byday.length) return alert("Selecione pelo menos 1 dia de treino no cadastro do perfil.");
  const style = profile.training_style ? ` (${profile.training_style})` : "";
  const text = buildICS({
    title: `Treino - ${profile.name}${style}`,
    description: "Lembrete semanal de treino.",
    dtStartDate: new Date(),
    timeHHMM: els.trainTime.value || "18:00",
    rrule: "FREQ=WEEKLY",
    byday,
  });
  downloadICS(text, `lembrete_treino_${profile.id}.ics`);
  alert("Arquivo .ICS gerado. Abra-o no celular e importe no Google Agenda (com notificação).");
});

// ---------- PWA install prompt + SW
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("sw.js");
    } catch (e) {
      console.warn("SW falhou:", e);
    }
  });
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  els.installBtn.classList.remove("hidden");
});

els.installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  els.installBtn.classList.add("hidden");
});

// ---------- init
(async function init() {
  db = await openDb();

  // build day checkboxes for UI first time
  renderDaysCheckboxes(defaultProfile().training_days);

  els.dateInput.value = isoToday();
  await refresh(true);
})();