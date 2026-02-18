// Controle de Peso (PWA) - V2
// Upgrades:
// - Medidas opcionais (cintura cm, % gordura)
// - Backup/Import JSON + Export CSV
// - Gráfico com média móvel 7d + linha de meta
// - Tendência semanal (média 7d atual vs semana anterior)

const DB_NAME = "peso_db";
const DB_VERSION = 1;
const STORE_ENTRIES = "entries";
const STORE_SETTINGS = "settings";

const $ = (id) => document.getElementById(id);

const els = {
  entryForm: $("entryForm"),
  dateInput: $("dateInput"),
  weightInput: $("weightInput"),
  waistInput: $("waistInput"),
  bfInput: $("bfInput"),
  noteInput: $("noteInput"),
  clearBtn: $("clearBtn"),
  list: $("list"),

  settingsForm: $("settingsForm"),
  heightInput: $("heightInput"),
  goalInput: $("goalInput"),
  exportCsvBtn: $("exportCsvBtn"),
  exportJsonBtn: $("exportJsonBtn"),
  importBtn: $("importBtn"),
  importFile: $("importFile"),
  deleteAllBtn: $("deleteAllBtn"),

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
  installBtn: $("installBtn"),
};

let db = null;
let deferredPrompt = null;

function fmt1(n) { return n.toFixed(1).replace(".", ","); }
function fmtKg(n) { return n == null || Number.isNaN(n) ? "—" : `${fmt1(n)} kg`; }
function fmtCm(n) { return n == null || Number.isNaN(n) ? "—" : `${fmt1(n)} cm`; }
function fmtPct(n) { return n == null || Number.isNaN(n) ? "—" : `${fmt1(n)} %`; }
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

async function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const _db = req.result;
      if (!_db.objectStoreNames.contains(STORE_ENTRIES)) {
        const store = _db.createObjectStore(STORE_ENTRIES, { keyPath: "date" });
        store.createIndex("byDate", "date", { unique: true });
      }
      if (!_db.objectStoreNames.contains(STORE_SETTINGS)) {
        _db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

// --- IndexedDB helpers
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
function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
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

// --- Domain
async function getSettings() {
  const store = tx(STORE_SETTINGS);
  const [height, goal] = await Promise.all([
    idbGet(store, "height_cm"),
    idbGet(store, "goal_kg"),
  ]);
  return {
    height_cm: height?.value ?? null,
    goal_kg: goal?.value ?? null,
  };
}
async function setSetting(key, value) {
  const store = tx(STORE_SETTINGS, "readwrite");
  await idbPut(store, { key, value });
}
async function saveEntry(entry) {
  const store = tx(STORE_ENTRIES, "readwrite");
  await idbPut(store, entry);
}
async function deleteEntry(date) {
  const store = tx(STORE_ENTRIES, "readwrite");
  await idbDelete(store, date);
}
async function clearAll() {
  const e = tx(STORE_ENTRIES, "readwrite");
  const s = tx(STORE_SETTINGS, "readwrite");
  await Promise.all([idbClear(e), idbClear(s)]);
}
async function listEntries() {
  const store = tx(STORE_ENTRIES);
  const all = await idbGetAll(store);
  all.sort((a, b) => (a.date < b.date ? 1 : -1)); // mais recente primeiro
  return all;
}

function escapeHtml(str) {
  return str
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

// --- UI render
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

    div.innerHTML = `
      <div class="left">
        <div class="date">${e.date}</div>
        <div class="note">${note ? escapeHtml(note) : "<span class='muted'>—</span>"}</div>
      </div>
      <div class="right">
        <span class="pill">${fmtKg(e.weight)}</span>
        ${waist}
        ${bf}
        <button class="iconbtn" data-edit="${e.date}" title="Editar">Editar</button>
        <button class="iconbtn" data-del="${e.date}" title="Excluir">Excluir</button>
      </div>
    `;

    els.list.appendChild(div);
  }

  els.list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const date = btn.getAttribute("data-del");
      if (!confirm(`Excluir o registro de ${date}?`)) return;
      await deleteEntry(date);
      await refresh();
    });
  });

  els.list.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const date = btn.getAttribute("data-edit");
      const entries = await listEntries();
      const e = entries.find((x) => x.date === date);
      if (!e) return;

      els.dateInput.value = e.date;
      els.weightInput.value = String(e.weight);
      els.waistInput.value = e.waist_cm ?? "";
      els.bfInput.value = e.bodyfat_pct ?? "";
      els.noteInput.value = e.note ?? "";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function renderStats(entries, settings) {
  if (!entries.length) {
    els.lastWeight.textContent = "—";
    els.delta.textContent = "—";
    els.avg7.textContent = "—";
    els.trend7.textContent = "—";
    els.bmi.textContent = "—";
    els.goal.textContent = settings.goal_kg ? fmtKg(settings.goal_kg) : "—";
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

  const bmi = computeBmi(last.weight, settings.height_cm);
  els.bmi.textContent = bmi ? bmi.toFixed(1).replace(".", ",") : "—";

  els.goal.textContent = settings.goal_kg ? fmtKg(settings.goal_kg) : "—";
  if (settings.goal_kg != null) {
    const diff = last.weight - settings.goal_kg;
    els.toGoal.textContent = fmtDelta(diff, "kg");
  } else {
    els.toGoal.textContent = "—";
  }

  els.waistLast.textContent = Number.isFinite(last.waist_cm) ? fmtCm(last.waist_cm) : "—";
  els.bfLast.textContent = Number.isFinite(last.bodyfat_pct) ? fmtPct(last.bodyfat_pct) : "—";
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

function drawChart(entries, settings) {
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

  const data = entries.slice(0, 60).slice().reverse();
  const weights = data.map((e) => e.weight);
  const ma7 = movingAverage(weights, 7);

  const minW = Math.min(...weights);
  const maxW = Math.max(...weights);

  let min = minW, max = maxW;
  if (settings.goal_kg != null) {
    min = Math.min(min, settings.goal_kg);
    max = Math.max(max, settings.goal_kg);
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

  if (settings.goal_kg != null) {
    const y = yOf(settings.goal_kg);
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
    ctx.fillText(`Meta: ${settings.goal_kg.toFixed(1).replace(".", ",")} kg`, pad, Math.max(pad, y - 6 * devicePixelRatio));
    ctx.globalAlpha = 1;
  }

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

  ctx.fillStyle = "#9ca3af";
  ctx.font = `${12 * devicePixelRatio}px system-ui`;
  ctx.fillText(`${max.toFixed(1).replace(".", ",")} kg`, pad, pad - 2 * devicePixelRatio);
  ctx.fillText(`${min.toFixed(1).replace(".", ",")} kg`, pad, h - 4 * devicePixelRatio);
}

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

async function exportCsv(entries, settings) {
  const lines = [];
  lines.push("data,peso_kg,cintura_cm,bodyfat_pct,observacao");

  const chronological = entries.slice().reverse();
  for (const e of chronological) {
    const note = (e.note ?? "").replaceAll('"', '""');
    const waist = e.waist_cm ?? "";
    const bf = e.bodyfat_pct ?? "";
    lines.push(`${e.date},${String(e.weight)},${waist},${bf},"${note}"`);
  }

  lines.push("");
  lines.push("configuracoes");
  lines.push(`altura_cm,${settings.height_cm ?? ""}`);
  lines.push(`meta_kg,${settings.goal_kg ?? ""}`);

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `controle-peso_${isoToday()}.csv`);
}

async function exportJson(entries, settings) {
  const payload = {
    version: 2,
    exported_at: new Date().toISOString(),
    settings,
    entries: entries.slice().reverse(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  downloadBlob(blob, `controle-peso_backup_${isoToday()}.json`);
}

async function importJsonFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    alert("Arquivo inválido (JSON).");
    return;
  }
  if (!data || !Array.isArray(data.entries) || !data.settings) {
    alert("JSON não está no formato do backup.");
    return;
  }

  await setSetting("height_cm", data.settings.height_cm ?? null);
  await setSetting("goal_kg", data.settings.goal_kg ?? null);

  const store = tx(STORE_ENTRIES, "readwrite");
  for (const e of data.entries) {
    const entry = {
      date: e.date,
      weight: Number(e.weight),
      note: e.note ?? "",
      waist_cm: e.waist_cm != null ? Number(e.waist_cm) : null,
      bodyfat_pct: e.bodyfat_pct != null ? Number(e.bodyfat_pct) : null,
    };
    if (!entry.date || !Number.isFinite(entry.weight)) continue;
    await idbPut(store, entry);
  }

  await refresh();
  alert("Importação concluída.");
}

async function refresh() {
  const entries = await listEntries();
  const settings = await getSettings();

  els.heightInput.value = settings.height_cm ?? "";
  els.goalInput.value = settings.goal_kg ?? "";

  renderList(entries);
  renderStats(entries, settings);
  drawChart(entries, settings);
}

// --- Events
els.entryForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();

  const date = els.dateInput.value;
  const weight = parseNumber(els.weightInput.value);
  const waist = parseNumber(els.waistInput.value);
  const bf = parseNumber(els.bfInput.value);
  const note = els.noteInput.value ?? "";

  if (!date) return alert("Informe a data.");
  if (!Number.isFinite(weight) || weight <= 0) return alert("Informe um peso válido (kg).");
  if (waist != null && (!Number.isFinite(waist) || waist < 30 || waist > 200)) return alert("Cintura inválida (cm).");
  if (bf != null && (!Number.isFinite(bf) || bf < 1 || bf > 80)) return alert("% gordura inválida.");

  await saveEntry({
    date,
    weight,
    note,
    waist_cm: waist,
    bodyfat_pct: bf,
  });

  els.noteInput.value = "";
  await refresh();
});

els.clearBtn.addEventListener("click", () => {
  els.dateInput.value = isoToday();
  els.weightInput.value = "";
  els.waistInput.value = "";
  els.bfInput.value = "";
  els.noteInput.value = "";
});

els.settingsForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const height = parseNumber(els.heightInput.value);
  const goal = parseNumber(els.goalInput.value);

  if (height != null && (!Number.isFinite(height) || height < 80 || height > 250)) {
    return alert("Altura inválida (cm).");
  }
  if (goal != null && (!Number.isFinite(goal) || goal < 20 || goal > 400)) {
    return alert("Meta inválida (kg).");
  }

  await setSetting("height_cm", height);
  await setSetting("goal_kg", goal);
  await refresh();
  alert("Configurações salvas.");
});

els.exportCsvBtn.addEventListener("click", async () => {
  const entries = await listEntries();
  const settings = await getSettings();
  await exportCsv(entries, settings);
});

els.exportJsonBtn.addEventListener("click", async () => {
  const entries = await listEntries();
  const settings = await getSettings();
  await exportJson(entries, settings);
});

els.importBtn.addEventListener("click", () => {
  els.importFile.click();
});

els.importFile.addEventListener("change", async () => {
  const file = els.importFile.files?.[0];
  els.importFile.value = "";
  if (!file) return;
  if (!confirm("Importar JSON vai sobrescrever registros com a mesma data. Continuar?")) return;
  await importJsonFile(file);
});

els.deleteAllBtn.addEventListener("click", async () => {
  if (!confirm("Tem certeza? Isso apaga TODOS os registros e configurações.")) return;
  await clearAll();
  await refresh();
});

// --- PWA: service worker + install prompt
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

(async function init() {
  db = await openDb();
  els.dateInput.value = isoToday();
  await refresh();
})();