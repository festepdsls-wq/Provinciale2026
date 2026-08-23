// ============================================================
// SPESE / COSTI FESTA — pagina separata, protetta da PIN
// ============================================================

const SPESE_CONFIG = {
  SHEET_ID: "1bhjn4ZsTqYm88yZgKcRqOt7vRWF0hWOejCH4LPIOUw4",
  GID: "166174883", // tab FATTURE / RIMBORSI
  PIN: "2709",
  RANGES: {
    totaleSpese: "O3:Q6",
    giaRimborsati: "O8:Q11",
    ancoraDaRimborsare: "O13:Q16",
    categoriaLabel: "W3:W14",
    categoriaValore: "X3:X14",
    fornitoreLabel: "T8:T30",
    fornitoreValore: "U8:U30",
  },
  REFRESH_SECONDS: 60,
};

function speseGvizUrl(range) {
  const base = `https://docs.google.com/spreadsheets/d/${SPESE_CONFIG.SHEET_ID}/gviz/tq`;
  const params = new URLSearchParams({
    tqx: "out:csv",
    gid: SPESE_CONFIG.GID,
    range: range,
    _cb: Date.now().toString(),
  });
  return `${base}?${params.toString()}`;
}

// --- Parsing (copie autonome, per non dipendere da app.js) ---

function speseParseCsv(text) {
  const rows = [];
  let cur = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ""; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        cur.push(field); field = "";
        if (cur.length > 1 || cur[0] !== "") rows.push(cur);
        cur = [];
      } else { field += c; }
    }
  }
  if (field !== "" || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

function speseParseCurrency(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (s === "" || s === "-") return 0;
  const cleaned = s.replace(/[€\s]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function speseFmtEuro(n) {
  return n.toLocaleString("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}

async function speseFetchRange(rangeKey) {
  const url = speseGvizUrl(SPESE_CONFIG.RANGES[rangeKey]);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Errore HTTP ${res.status} leggendo ${rangeKey}`);
  const text = await res.text();
  return speseParseCsv(text);
}

/** Da un blocco di celle (spesso con merge), estrae il primo valore numerico valido trovato */
function firstCurrencyInBlock(rows) {
  for (const row of rows) {
    for (const cell of row) {
      const v = speseParseCurrency(cell);
      if (cell && cell.trim() !== "" && !isNaN(v)) return v;
    }
  }
  return 0;
}

/** Righe singola-colonna etichetta + righe singola-colonna valore -> lista ordinata */
function zipLabelValue(labelRows, valueRows) {
  const out = [];
  const len = Math.max(labelRows.length, valueRows.length);
  for (let i = 0; i < len; i++) {
    const label = (labelRows[i] && labelRows[i][0] ? labelRows[i][0] : "").trim();
    const valueRaw = valueRows[i] && valueRows[i][0] ? valueRows[i][0] : "";
    const value = speseParseCurrency(valueRaw);
    if (!label || value <= 0) continue;
    out.push({ label, value });
  }
  return out.sort((a, b) => b.value - a.value);
}

// --- Rendering ---

function renderRankList(containerId, items) {
  const el = document.getElementById(containerId);
  if (items.length === 0) {
    el.innerHTML = `<div class="empty-state">Nessuna voce disponibile.</div>`;
    return;
  }
  el.innerHTML = items
    .map(
      (it, i) => `
      <div class="rank-item">
        <div class="pos">${i + 1}</div>
        <div class="name">${it.label}</div>
        <div class="val">${speseFmtEuro(it.value)}</div>
      </div>`
    )
    .join("");
}

async function loadSpeseData() {
  const [
    totaleSpeseRows,
    giaRimborsatiRows,
    ancoraDaRimborsareRows,
    categoriaLabelRows,
    categoriaValoreRows,
    fornitoreLabelRows,
    fornitoreValoreRows,
  ] = await Promise.all([
    speseFetchRange("totaleSpese"),
    speseFetchRange("giaRimborsati"),
    speseFetchRange("ancoraDaRimborsare"),
    speseFetchRange("categoriaLabel"),
    speseFetchRange("categoriaValore"),
    speseFetchRange("fornitoreLabel"),
    speseFetchRange("fornitoreValore"),
  ]);

  return {
    totaleSpese: firstCurrencyInBlock(totaleSpeseRows),
    giaRimborsati: firstCurrencyInBlock(giaRimborsatiRows),
    ancoraDaRimborsare: firstCurrencyInBlock(ancoraDaRimborsareRows),
    categorie: zipLabelValue(categoriaLabelRows, categoriaValoreRows),
    fornitori: zipLabelValue(fornitoreLabelRows, fornitoreValoreRows),
  };
}

async function refreshSpese() {
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const errorBanner = document.getElementById("errorBanner");
  try {
    statusText.textContent = "aggiornamento...";
    const data = await loadSpeseData();

    document.getElementById("kpiTotale").textContent = speseFmtEuro(data.totaleSpese);
    document.getElementById("kpiRimborsato").textContent = speseFmtEuro(data.giaRimborsati);
    document.getElementById("kpiDaRimborsare").textContent = speseFmtEuro(data.ancoraDaRimborsare);

    renderRankList("categorieList", data.categorie);
    renderRankList("fornitoriList", data.fornitori);

    statusDot.classList.remove("stale");
    statusText.textContent = "in linea";
    errorBanner.classList.remove("show");
  } catch (err) {
    console.error(err);
    statusDot.classList.add("stale");
    statusText.textContent = "dati non aggiornati";
    errorBanner.textContent =
      "Impossibile aggiornare i dati. Controlla la connessione — la pagina mostra l'ultimo dato disponibile.";
    errorBanner.classList.add("show");
  }
}

// --- PIN gate ---

function unlockSpese() {
  document.getElementById("pinGate").style.display = "none";
  document.getElementById("speseContent").style.display = "block";
  refreshSpese();
  setInterval(refreshSpese, SPESE_CONFIG.REFRESH_SECONDS * 1000);
}

function checkPin() {
  const input = document.getElementById("pinInput");
  const errorEl = document.getElementById("pinError");
  if (input.value.trim() === SPESE_CONFIG.PIN) {
    sessionStorage.setItem("speseUnlocked", "1");
    unlockSpese();
  } else {
    errorEl.textContent = "PIN errato.";
    input.value = "";
    input.focus();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("pinSubmit").addEventListener("click", checkPin);
  document.getElementById("pinInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") checkPin();
  });

  // Se già sbloccata in questa sessione del browser, non richiedere di nuovo il PIN
  if (sessionStorage.getItem("speseUnlocked") === "1") {
    unlockSpese();
  }
});
