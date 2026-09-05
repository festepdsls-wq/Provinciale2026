// ============================================================
// CONFIGURAZIONE — Dashboard Provinciale dell'Unità 2026
// Modifica solo questo file se cambiano foglio, gid o range.
// ============================================================

const CONFIG = {
  SHEET_ID: "1bhjn4ZsTqYm88yZgKcRqOt7vRWF0hWOejCH4LPIOUw4",
  GID: "1824499508",

  // Range del foglio "riepilogo" — confermati fissi dall'utente, nessuna ulteriore modifica prevista.
  RANGES: {
    coperti2026: "B17:E46",   // DATA | COPERTI | $/PASTO | INCASSO
    coperti2025: "G17:J46",   // DATA | COPERTI | $/PASTO | INCASSO
    piattiNr:    "M5:N26",    // DESCRIZIONE | NR
    piattiEuro:  "P5:Q26",    // DESCRIZIONE | €
    bibiteNr:    "M28:N50",   // DESCRIZIONE | NR
    bibiteEuro:  "P28:Q50",   // DESCRIZIONE | €
  },

  // Ogni quanti secondi ricontrollare i dati
  REFRESH_SECONDS: 45,

  FESTA_NOME: "Festa Provinciale dell'Unità",
  FESTA_ANNO: "2026",

  // Scheda "Scontrini": dettaglio giornaliero piatti/bibite. A differenza dei range
  // sopra, qui NON si usa un range fisso di righe/colonne: la lettura si adatta da
  // sola cercando le intestazioni (vedi parseScontrini). SCONTRINI_RANGE è solo un
  // "riquadro" abbastanza grande da contenere tutta la tabella con margine.
  SCONTRINI_SHEET: "Scontrini",
  SCONTRINI_RANGE: "A1:FZ60",
};

function gvizUrl(range) {
  const base = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq`;
  const params = new URLSearchParams({
    tqx: "out:csv",
    gid: CONFIG.GID,
    range: range,
    _cb: Date.now().toString(), // anti-cache: forza Google a non servire una risposta vecchia
  });
  return `${base}?${params.toString()}`;
}

/** Come gvizUrl, ma per una scheda indicata per nome invece che per gid (usato per "Scontrini"). */
function gvizUrlBySheetName(sheetName, range) {
  const base = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq`;
  const params = new URLSearchParams({
    tqx: "out:csv",
    sheet: sheetName,
    range: range,
    _cb: Date.now().toString(),
  });
  return `${base}?${params.toString()}`;
}
// ============================================================
// DATA LAYER — fetch + parsing
// ============================================================

/** Parsing robusto di un CSV a 2-4 colonne restituito da Google Sheets gviz */
function parseCsv(text) {
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

/** "€ 1.234,56" / "1.234,56" / "" -> Number (0 se vuoto/non valido) */
function parseItalianCurrency(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (s === "" || s === "-") return 0;
  const cleaned = s.replace(/[€\s]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

/** "179" / "1.234" -> Number */
function parseItalianInt(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/\./g, "");
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

async function fetchRange(rangeKey) {
  const url = gvizUrl(CONFIG.RANGES[rangeKey]);
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    throw new Error(`Errore di rete leggendo ${rangeKey}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Errore HTTP ${res.status} leggendo ${rangeKey} (range: ${CONFIG.RANGES[rangeKey]})`);
  const text = await res.text();
  if (text.includes("#REF") || text.trim() === "") {
    throw new Error(`Risposta vuota o non valida leggendo ${rangeKey}`);
  }
  return parseCsv(text);
}

/** Come fetchRange, ma legge la scheda "Scontrini" per nome invece che per gid+range fisso. */
async function fetchScontriniRaw() {
  const url = gvizUrlBySheetName(CONFIG.SCONTRINI_SHEET, CONFIG.SCONTRINI_RANGE);
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    throw new Error(`Errore di rete leggendo Scontrini: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Errore HTTP ${res.status} leggendo Scontrini`);
  const text = await res.text();
  if (text.includes("#REF") || text.trim() === "") {
    throw new Error(`Risposta vuota o non valida leggendo Scontrini`);
  }
  return parseCsv(text);
}

/**
 * Analizza un'etichetta data tipo "dom 06/09 P" (pranzo) o "dom 06/9" (cena, default).
 * Restituisce la chiave giorno/mese per il confronto e il turno riconosciuto.
 * Riconosce "P", "P.", "(P)", "PRANZO" a fine testo, maiuscole o minuscole.
 */
function parseDayLabel(label) {
  const m = label.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  let dateKey = null;
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    dateKey = `${dd}/${mm}`;
  }
  const pranzoPattern = /[\s(]*p(ranzo)?\.?[\s)]*$/i;
  const isPranzo = pranzoPattern.test(label.trim());
  const displayLabel = label.replace(pranzoPattern, "").trim();
  return { dateKey, turno: isPranzo ? "pranzo" : "cena", displayLabel };
}

/**
 * Individua da sola dove inizia la tabella "DATA | COPERTI | ..." dentro un blocco
 * più ampio di righe grezze, e restituisce solo le righe dati fino al TOTALE.
 * Così non importa più la riga esatta del foglio: se sposti righe (es. per il TOTALE
 * o per aggiungere un turno), l'app la ritrova comunque da sola.
 */
function extractDataTable(rows, maxRows = 80) {
  let startIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const c0 = (rows[i][0] || "").trim().toUpperCase();
    const c1 = (rows[i][1] || "").trim().toUpperCase();
    if (c0 === "DATA" && c1.startsWith("COPERTI")) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx === -1) return rows; // fallback di sicurezza: intestazione non trovata, usa tutto
  const out = [];
  for (let i = startIdx; i < rows.length && out.length < maxRows; i++) {
    const label = (rows[i][0] || "").trim();
    if (/totale/i.test(label)) break; // fine tabella
    out.push(rows[i]);
  }
  return out;
}

/** Righe DATA|COPERTI|$/PASTO|INCASSO -> array oggetti puliti (mantiene anche le righe vuote, per non rompere l'allineamento posizionale con l'altro anno) */
function mapDailyRows(rows) {
  const mapped = extractDataTable(rows)
    .map((r) => {
      const dataLabel = (r[0] || "").trim();
      const parsed = parseDayLabel(dataLabel);
      return {
        dataLabel,
        displayLabel: parsed.displayLabel,
        dateKey: parsed.dateKey,
        turno: parsed.turno,
        coperti: parseItalianInt(r[1]),
        scontrinoMedio: parseItalianCurrency(r[2]),
        incasso: parseItalianCurrency(r[3]),
      };
    })
    .filter((r) => !/totale/i.test(r.dataLabel));
  return fillMissingDateKeys(mapped);
}

/**
 * Google a volte esporta vuota l'etichetta data di una riga (es. la riga "P" di un
 * turno pranzo), pur mantenendo intatti coperti/incasso. Quando capita, la riga
 * orfana con dati compare sempre subito PRIMA della riga con la data vera dello
 * stesso giorno: le assegniamo quindi la stessa data, per poterla sommare correttamente.
 */
function fillMissingDateKeys(rows) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const hasData = row.coperti > 0 || row.incasso > 0;
    if (!hasData || row.dateKey) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const hasOwnData = rows[j].coperti > 0 || rows[j].incasso > 0;
      if (rows[j].dateKey) {
        row.dateKey = rows[j].dateKey;
        row.displayLabel = rows[j].displayLabel;
        row.turno = "pranzo";
        break;
      }
      if (hasOwnData) break; // non superare un'altra riga con dati propri
    }
  }
  return rows;
}

/**
 * Somma automaticamente le righe che condividono la stessa data di calendario
 * (es. pranzo + cena scritti su due righe separate, con o senza "P"). A differenza
 * di una versione precedente, NON rimuove righe dall'array: la seconda riga dello
 * stesso giorno viene azzerata e "assorbita" nella prima, ma resta al suo posto —
 * così la lunghezza dell'array non cambia mai e l'allineamento posizionale con
 * l'altro anno (fondamentale per il confronto 2026/2025) resta sempre intatto.
 */
function groupByDate(rows) {
  const out = rows.map((r) => ({ ...r, turni: 1 }));
  const indexByKey = new Map();
  for (let i = 0; i < out.length; i++) {
    const row = out[i];
    if (!row.dateKey) continue;
    if (indexByKey.has(row.dateKey)) {
      const targetIdx = indexByKey.get(row.dateKey);
      out[targetIdx].coperti += row.coperti;
      out[targetIdx].incasso += row.incasso;
      out[targetIdx].turni += 1;
      // tiene l'etichetta senza eventuale "P", più pulita da mostrare
      if (row.turno === "cena") out[targetIdx].displayLabel = row.displayLabel;
      // azzera la riga assorbita, ma la lascia al suo posto nell'array
      row.coperti = 0;
      row.incasso = 0;
    } else {
      indexByKey.set(row.dateKey, i);
    }
  }
  return out;
}

/**
 * Accoppia riga per riga (stesso indice = stesso giorno di calendario, dato che
 * i due range 2026/2025 arrivano dalle stesse righe del foglio) i dati dei due anni.
 */
function buildComparisonRows(rows2026, rows2025) {
  const len = Math.max(rows2026.length, rows2025.length);
  const out = [];
  for (let i = 0; i < len; i++) {
    const r26 = rows2026[i] || { dataLabel: "", coperti: 0, incasso: 0 };
    const r25 = rows2025[i] || { dataLabel: "", coperti: 0, incasso: 0 };
    const label = r26.dataLabel || r25.dataLabel;
    const hasData26 = r26.incasso > 0 || r26.coperti > 0;
    const hasData25 = r25.incasso > 0 || r25.coperti > 0;
    if (!label || (!hasData26 && !hasData25)) continue;
    out.push({
      dataLabel: label,
      displayLabel: r26.displayLabel || r25.displayLabel || label,
      dateKey: r26.dateKey || r25.dateKey,
      turno: r26.turno || r25.turno || "cena",
      turni26: r26.turni || 1,
      inc26: r26.incasso,
      inc25: r25.incasso,
      cop26: r26.coperti,
      cop25: r25.coperti,
      diff: r26.incasso - r25.incasso,
      hasData26,
      idx26: i,
    });
  }
  return out;
}

/** Somma la differenza incasso 2026 vs 2025 solo sui giorni già avvenuti nel 2026 */
function computeCumulativeDiff(cmpRows) {
  const happened = cmpRows.filter((r) => r.hasData26);
  const diff = happened.reduce((s, r) => s + r.diff, 0);
  return { diff, giorni: happened.length };
}

/** Confronto cumulato su incasso, coperti e scontrino medio, solo giorni già trascorsi nel 2026 */
function computeCumulativeComparison(cmpRows) {
  const seen = new Set();
  const happened = cmpRows.filter((r) => {
    if (!r.hasData26) return false;
    const key = `${r.dataLabel}|${r.cop26}|${r.inc26}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const giorni = happened.length;
  const inc26 = happened.reduce((s, r) => s + r.inc26, 0);
  const inc25 = happened.reduce((s, r) => s + r.inc25, 0);
  const cop26 = happened.reduce((s, r) => s + r.cop26, 0);
  const cop25 = happened.reduce((s, r) => s + r.cop25, 0);
  const scontrino26 = cop26 > 0 ? inc26 / cop26 : 0;
  const scontrino25 = cop25 > 0 ? inc25 / cop25 : 0;
  return {
    giorni,
    diffIncasso: inc26 - inc25,
    diffCoperti: cop26 - cop25,
    diffScontrino: scontrino26 - scontrino25,
  };
}

/** Righe DESCRIZIONE|VALORE -> array oggetti, ordinati desc, filtra vuoti/zero */
function mapRankedRows(rows, valueParser) {
  return rows
    .map((r) => ({
      nome: (r[0] || "").trim(),
      valore: valueParser(r[1]),
    }))
    .filter((r) => r.nome && !/totale generale/i.test(r.nome) && r.valore > 0)
    .sort((a, b) => b.valore - a.valore);
}

/**
 * Analizza la scheda "Scontrini": una riga per piatto/bibita, e per ogni giornata
 * un blocco di 6 colonne (NR Cassa1, € Cassa1, NR Cassa2, € Cassa2, TOTALE NR., TOTALE €).
 * Non usa numeri di riga/colonna fissi: cerca da sola le intestazioni, così regge
 * piccole modifiche al foglio (nuove date, righe spostate). Se la struttura non
 * viene riconosciuta lancia un errore, che il chiamante gestisce senza rompere il
 * resto dell'app (il dettaglio giornaliero sparisce, i totali stagione restano).
 */
/** "dd/mm" + spostamento in giorni (anche negativo) -> nuova "dd/mm", calcolato sul calendario reale */
function shiftDateKeyByDays(dateKey, deltaDays) {
  const m = (dateKey || "").match(/^(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const d = new Date(2026, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  d.setDate(d.getDate() + deltaDays);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

/** Trova, tra i giorni con dati disponibili, quello di 7 giorni prima (stesso giorno della
 * settimana). Preferisce lo stesso turno (pranzo/cena) se esiste, altrimenti va bene l'altro. */
function findSameWeekdayLastWeek(currentDay, allDays) {
  const targetKey = shiftDateKeyByDays(currentDay.dateKey, -7);
  if (!targetKey) return null;
  const sameTurno = allDays.find((d) => d.dateKey === targetKey && d.turno === currentDay.turno);
  if (sameTurno) return sameTurno;
  return allDays.find((d) => d.dateKey === targetKey) || null;
}

function parseScontrini(rows) {
  // NOTA: quando si legge un intervallo molto largo, l'export CSV di Google Sheets
  // svuota le intestazioni di testo delle colonne che contengono per lo più numeri
  // più in basso (le "inferisce" come colonna numerica). Per questo NON cerchiamo
  // l'intestazione "TOT € AD OGGI" (colonna che finisce svuotata): individuiamo la
  // riga giusta cercando invece la riga con più celle "gg/mm" dalla colonna G in poi
  // — le etichette data restano sempre testo e non vengono mai svuotate.
  let headerIdx = -1;
  let blockStarts = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const candidates = [];
    for (let c = 6; c < row.length; c++) {
      const cell = (row[c] || "").trim();
      if (/\d{1,2}\s*\/\s*\d{1,2}/.test(cell)) candidates.push({ col: c, label: cell });
    }
    if (candidates.length >= 3) {
      headerIdx = r;
      blockStarts = candidates;
      break;
    }
  }
  if (headerIdx === -1 || !rows[headerIdx + 1]) {
    throw new Error("Riga delle date non trovata nella scheda Scontrini.");
  }
  const head1 = rows[headerIdx];
  const head2 = rows[headerIdx + 1];

  const days = blockStarts.map((b, i) => {
    const nextCol = i + 1 < blockStarts.length ? blockStarts[i + 1].col : head1.length;
    let totNrCol = -1;
    let totEuroCol = -1;
    for (let c = b.col; c < nextCol; c++) {
      const cell = (head2[c] || "").trim().toUpperCase();
      if (cell === "TOTALE NR.") totNrCol = c;
      if (cell.startsWith("TOTALE €") || cell.startsWith("TOTALE EURO")) totEuroCol = c;
    }
    // Fallback posizionale (offset noti nel blocco da 6 colonne) se le etichette non si trovano.
    if (totNrCol === -1) totNrCol = b.col + 4;
    if (totEuroCol === -1) totEuroCol = b.col + 5;
    const parsed = parseDayLabel(b.label);
    return {
      key: b.label,
      dateKey: parsed.dateKey,
      turno: parsed.turno,
      displayLabel: parsed.turno === "pranzo" ? `${parsed.displayLabel} · pranzo` : parsed.displayLabel,
      totNrCol,
      totEuroCol,
    };
  });

  const piattiByDay = new Map();
  const bibiteByDay = new Map();
  days.forEach((d) => {
    piattiByDay.set(d.key, []);
    bibiteByDay.set(d.key, []);
  });

  // Le righe dati iniziano dopo l'intestazione e la riga "NR. COPERTI"; le saltiamo
  // cercando la prima riga con una vera descrizione piatto.
  let i = headerIdx + 2;
  while (i < rows.length) {
    const b = ((rows[i] && rows[i][1]) || "").trim().toUpperCase();
    if (b === "" || b === "NR. COPERTI") { i++; continue; }
    break;
  }

  const maxRow = Math.min(rows.length, headerIdx + 90);
  for (; i < maxRow; i++) {
    const row = rows[i] || [];
    const desc = (row[1] || "").trim();
    const descUpper = desc.toUpperCase();
    if (descUpper === "AGGIUSTAMENTI DI CASSA" || descUpper === "TOTALE RISTORANTE") break;
    if (!desc) continue; // righe vuote di separazione tra categorie
    const portata = (row[2] || "").trim().toUpperCase();
    if (portata === "COPERTO/ASPORTI") continue; // coperto e asporti non sono piatti
    const target = portata === "BIBITE" ? bibiteByDay : piattiByDay;
    days.forEach((d) => {
      const nr = parseItalianInt(row[d.totNrCol]);
      const euro = parseItalianCurrency(row[d.totEuroCol]);
      if (nr > 0 || euro > 0) target.get(d.key).push({ nome: desc, nr, euro });
    });
  }

  // Mostra solo le giornate per cui risulta già venduto qualcosa.
  const activeDays = days.filter(
    (d) => (piattiByDay.get(d.key) || []).length > 0 || (bibiteByDay.get(d.key) || []).length > 0
  );

  return { days: activeDays, piattiByDay, bibiteByDay };
}

/** Non lancia mai: se il dettaglio giornaliero non è leggibile, l'app resta comunque utilizzabile con i soli totali stagione. */
async function loadScontriniDetail() {
  try {
    const raw = await fetchScontriniRaw();
    return parseScontrini(raw);
  } catch (err) {
    console.error("Dettaglio giornaliero piatti/bibite non disponibile:", err);
    return null;
  }
}

async function loadAllData() {
  const [c26, c25, pNr, pEuro, bNr, bEuro, scontrini] = await Promise.all([
    fetchRange("coperti2026"),
    fetchRange("coperti2025"),
    fetchRange("piattiNr"),
    fetchRange("piattiEuro"),
    fetchRange("bibiteNr"),
    fetchRange("bibiteEuro"),
    loadScontriniDetail(),
  ]);

  return {
    coperti2026: groupByDate(mapDailyRows(c26)),
    coperti2025: groupByDate(mapDailyRows(c25)),
    piattiNr: mapRankedRows(pNr, parseItalianInt),
    piattiEuro: mapRankedRows(pEuro, parseItalianCurrency),
    bibiteNr: mapRankedRows(bNr, parseItalianInt),
    bibiteEuro: mapRankedRows(bEuro, parseItalianCurrency),
    scontrini,
    fetchedAt: new Date(),
  };
}

/**
 * Rimuove duplicati esatti (stessa data, stesso incasso, stessi coperti) prima di sommare —
 * protezione nel caso la fonte dati restituisca la stessa riga più di una volta.
 * Non tocca le righe vuote/placeholder (fanno parte del normale allineamento tra anni).
 */
function dedupForTotals(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    if (r.incasso === 0 && r.coperti === 0) return true; // righe vuote sempre ammesse
    const key = `${r.dataLabel}|${r.coperti}|${r.incasso}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function computeTotals(dailyRows) {
  const clean = dedupForTotals(dailyRows);
  const withData = clean.filter((r) => r.incasso > 0 || r.coperti > 0);
  const totIncasso = withData.reduce((s, r) => s + r.incasso, 0);
  const totCoperti = withData.reduce((s, r) => s + r.coperti, 0);
  return {
    incasso: totIncasso,
    coperti: totCoperti,
    scontrinoMedio: totCoperti > 0 ? totIncasso / totCoperti : 0,
    giorniAttivi: withData.length,
  };
}

function fmtEuro(n) {
  return n.toLocaleString("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}
function fmtEuroDec(n) {
  return n.toLocaleString("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
}
function fmtInt(n) {
  return n.toLocaleString("it-IT");
}
// ============================================================
// APP — rendering e interazioni
// ============================================================

let LAST_DATA = null;
let RANK_MODE = { piatti: "nr", bibite: "nr" };
// "ALL" = tutta la stagione (comportamento di sempre); altrimenti la chiave di un
// giorno specifico (vedi parseScontrini) per vedere solo quella giornata.
let DAY_FILTER = { piatti: "ALL", bibite: "ALL" };

// Date con doppio turno (pranzo+cena) note in anticipo — il tag "2 turni" compare
// sempre per queste, indipendentemente da come arrivano i dati dal foglio.
const DOUBLE_TURNO_DATES = ["06/09", "13/09"];

// Modalità diagnostica: apri l'app con ?debug=1 in fondo all'URL per vedere i dati grezzi ricevuti.
const DEBUG_MODE = new URLSearchParams(location.search).get("debug") === "1";
if (DEBUG_MODE) {
  window.addEventListener("DOMContentLoaded", () => {
    const badge = document.createElement("div");
    badge.textContent = "DEBUG ON";
    badge.style.cssText =
      "position:fixed;top:8px;right:8px;background:#0f0;color:#000;font-family:monospace;font-size:11px;font-weight:bold;padding:4px 8px;border-radius:6px;z-index:10000;";
    document.body.appendChild(badge);
  });
}

function switchPanel(name) {
  document.querySelectorAll("section.panel").forEach((p) => p.classList.remove("active"));
  document.getElementById(`panel-${name}`).classList.add("active");
  document.querySelectorAll("nav.tabbar button").forEach((b) => {
    b.classList.toggle("active", b.dataset.panel === name);
  });
}

function renderKpis(daily) {
  const t = computeTotals(daily);
  document.getElementById("kpiIncasso").textContent = fmtEuro(t.incasso);
  document.getElementById("kpiCoperti").textContent = fmtInt(t.coperti);
  document.getElementById("kpiScontrino").textContent = fmtEuroDec(t.scontrinoMedio);
}

function diffBits(diff) {
  if (diff > 0) return { arrow: "▲", cls: "up" };
  if (diff < 0) return { arrow: "▼", cls: "down" };
  return { arrow: "＝", cls: "flat" };
}

function renderComparisonTable() {
  const cmp = buildComparisonRows(LAST_DATA.coperti2026, LAST_DATA.coperti2025);
  const list = document.getElementById("dayList");

  if (cmp.length === 0) {
    list.innerHTML = `<div class="empty-state">Nessun dato ancora registrato.</div>`;
    return;
  }

  // Evidenzia l'ultimo giorno per cui risultano dati 2026 già inseriti (non "oggi":
  // la cassa chiude alle 23:30, quindi il giorno corrente resta a zero fino ad allora
  // ed evidenziarlo non è utile).
  let lastUpdatedIdx = -1;
  cmp.forEach((r, i) => {
    if (r.hasData26) lastUpdatedIdx = i;
  });

  list.innerHTML = cmp
    .map((r, i) => {
      const isLastUpdate = i === lastUpdatedIdx;
      const { arrow, cls } = diffBits(r.diff);
      const turnoTag =
        DOUBLE_TURNO_DATES.includes(r.dateKey) || r.turni26 > 1
          ? '<span class="turno-tag">2 turni</span>'
          : "";
      const scontrino26 = r.cop26 > 0 ? r.inc26 / r.cop26 : 0;
      const scontrino25 = r.cop25 > 0 ? r.inc25 / r.cop25 : 0;
      return `
        <div class="cmp-row ${isLastUpdate ? "is-last-update" : ""}">
          <div class="c-day">${r.displayLabel}${turnoTag}</div>
          <div class="c-num">
            <span class="v26">${fmtEuro(r.inc26)}</span>
            <span class="v25">${fmtEuro(r.inc25)}</span>
          </div>
          <div class="c-num">
            <span class="v26">${fmtInt(r.cop26)}</span>
            <span class="v25">${fmtInt(r.cop25)}</span>
          </div>
          <div class="c-num">
            <span class="v26">${scontrino26 > 0 ? fmtEuroDec(scontrino26) : "—"}</span>
            <span class="v25">${scontrino25 > 0 ? fmtEuroDec(scontrino25) : "—"}</span>
          </div>
          <div class="c-diff ${cls}">${arrow} ${fmtEuro(Math.abs(r.diff))}</div>
        </div>`;
    })
    .join("");
}

function renderTotalDiff() {
  const cmp = buildComparisonRows(LAST_DATA.coperti2026, LAST_DATA.coperti2025);
  const c = computeCumulativeComparison(cmp);
  const noteEl = document.getElementById("kpiNote");

  if (c.giorni === 0) {
    document.getElementById("kpiIncassoDiff").innerHTML = "";
    document.getElementById("kpiCopertiDiff").innerHTML = "";
    document.getElementById("kpiScontrinoDiff").innerHTML = "";
    noteEl.textContent = "";
    return;
  }

  const setDiff = (id, value, fmt) => {
    const { arrow, cls } = diffBits(value);
    document.getElementById(id).innerHTML =
      `<span class="${cls}">${arrow} ${value >= 0 ? "+" : "−"}${fmt(Math.abs(value))}</span>`;
  };

  setDiff("kpiIncassoDiff", c.diffIncasso, fmtEuro);
  setDiff("kpiCopertiDiff", c.diffCoperti, fmtInt);
  setDiff("kpiScontrinoDiff", c.diffScontrino, fmtEuroDec);

  noteEl.textContent = `vs 2025, sugli stessi ${c.giorni} giorni trascorsi`;
}

/**
 * Restituisce l'elenco da mostrare per "piatti" o "bibite": se il filtro giorno è
 * "ALL" (o il dettaglio Scontrini non è disponibile) sono i totali stagione di
 * sempre; altrimenti sono i dati di quel singolo giorno, ricavati da Scontrini.
 */
function getRankSource(category) {
  const mode = RANK_MODE[category];
  const dayKey = DAY_FILTER[category];
  if (dayKey === "ALL" || !LAST_DATA.scontrini) {
    if (category === "piatti") return mode === "nr" ? LAST_DATA.piattiNr : LAST_DATA.piattiEuro;
    return mode === "nr" ? LAST_DATA.bibiteNr : LAST_DATA.bibiteEuro;
  }
  const byDay = category === "piatti" ? LAST_DATA.scontrini.piattiByDay : LAST_DATA.scontrini.bibiteByDay;
  const rows = byDay.get(dayKey) || [];
  return rows
    .map((r) => ({ nome: r.nome, valore: mode === "nr" ? r.nr : r.euro }))
    .filter((r) => r.valore > 0)
    .sort((a, b) => b.valore - a.valore);
}

function renderRankList(category) {
  const containerId = category === "piatti" ? "piattiList" : "bibiteList";
  const legendId = category === "piatti" ? "piattiTrendLegend" : "bibiteTrendLegend";
  const container = document.getElementById(containerId);
  const mode = RANK_MODE[category];
  const data = getRankSource(category);
  const legendEl = document.getElementById(legendId);

  const dayKey = DAY_FILTER[category];
  const days = LAST_DATA.scontrini ? LAST_DATA.scontrini.days : [];
  const currentDay = dayKey !== "ALL" ? days.find((d) => d.key === dayKey) : null;
  const prevDay = currentDay ? findSameWeekdayLastWeek(currentDay, days) : null;

  if (legendEl) {
    legendEl.style.display = currentDay ? "block" : "none";
    if (currentDay) {
      legendEl.innerHTML = prevDay
        ? `<span class="up">▲</span> più venduto/incassato rispetto a <b>${prevDay.displayLabel}</b> (stesso giorno, settimana scorsa) · <span class="down">▼</span> meno · <span class="flat">＝</span> invariato`
        : `Nessun confronto disponibile: non c'è ancora un ${currentDay.displayLabel.split(" ")[0]} della settimana precedente con dati.`;
    }
  }

  if (!data || data.length === 0) {
    container.innerHTML = `<div class="empty-state">Nessun dato disponibile.</div>`;
    return;
  }

  // Mappa nome piatto -> valore della settimana scorsa (stesso giorno), per il confronto
  let prevValueByName = null;
  if (prevDay) {
    const byDay = category === "piatti" ? LAST_DATA.scontrini.piattiByDay : LAST_DATA.scontrini.bibiteByDay;
    const prevRows = byDay.get(prevDay.key) || [];
    prevValueByName = new Map(prevRows.map((r) => [r.nome, mode === "nr" ? r.nr : r.euro]));
  }

  container.innerHTML = data
    .slice(0, 30)
    .map((r, i) => {
      const val = mode === "nr" ? `${fmtInt(r.valore)}×` : fmtEuro(r.valore);
      let trendHtml = "";
      if (prevValueByName) {
        if (prevValueByName.has(r.nome)) {
          const prevVal = prevValueByName.get(r.nome);
          if (r.valore > prevVal) trendHtml = '<span class="trend-arrow up">▲</span>';
          else if (r.valore < prevVal) trendHtml = '<span class="trend-arrow down">▼</span>';
          else trendHtml = '<span class="trend-arrow flat">＝</span>';
        } else {
          trendHtml = '<span class="trend-arrow up">▲</span>'; // non venduto la settimana scorsa: è tutto "nuovo"
        }
      }
      return `
        <div class="rank-item">
          <div class="pos">${i + 1}</div>
          <div class="name">${trendHtml}${r.nome}</div>
          <div class="val">${val}</div>
        </div>`;
    })
    .join("");
}

/** Fila di "pillole" con le giornate, sopra le classifiche Piatti/Bibite. "Tutta la
 * stagione" è sempre la prima ed è quella attiva di default. */
function renderDayChips(category) {
  const wrapId = category === "piatti" ? "piattiDayChips" : "bibiteDayChips";
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const days = LAST_DATA.scontrini ? LAST_DATA.scontrini.days : [];
  if (days.length === 0) {
    wrap.style.display = "none";
    wrap.innerHTML = "";
    return;
  }
  wrap.style.display = "flex";
  const current = DAY_FILTER[category];
  const chips = [{ key: "ALL", label: "Totale" }].concat(
    days.map((d) => ({ key: d.key, label: d.displayLabel }))
  );
  wrap.innerHTML = chips
    .map(
      (c) =>
        `<button class="day-chip${c.key === current ? " active" : ""}" data-day="${encodeURIComponent(c.key)}">${c.label}</button>`
    )
    .join("");
  wrap.querySelectorAll(".day-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      DAY_FILTER[category] = decodeURIComponent(btn.dataset.day);
      renderDayChips(category);
      renderRankList(category);
    });
  });
}

function renderAll() {
  if (!LAST_DATA) return;
  renderKpis(LAST_DATA.coperti2026);
  renderTotalDiff();
  renderComparisonTable();
  renderDayChips("piatti");
  renderDayChips("bibite");
  renderRankList("piatti");
  renderRankList("bibite");

  document.getElementById("lastUpdate").textContent =
    LAST_DATA.fetchedAt.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}

function setStatus(ok, msg) {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  dot.classList.toggle("stale", !ok);
  text.textContent = msg;
}

function showError(msg) {
  const el = document.getElementById("errorBanner");
  el.textContent = msg;
  el.classList.add("show");
}
function hideError() {
  document.getElementById("errorBanner").classList.remove("show");
}

async function refreshData() {
  try {
    setStatus(true, "aggiornamento...");
    const data = await loadAllData();
    LAST_DATA = data;
    renderAll();
    setStatus(true, "in linea");
    hideError();
    if (DEBUG_MODE) showDebugPanel(null);
  } catch (err) {
    console.error(err);
    setStatus(false, "dati non aggiornati");
    showError(
      "Impossibile aggiornare i dati. Controlla la connessione — l'app mostra l'ultimo dato disponibile."
    );
    if (DEBUG_MODE) showDebugPanel(err);
  }
}

// --- Event wiring ---
document.querySelectorAll("nav.tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => switchPanel(btn.dataset.panel));
});

document.querySelectorAll("#panel-piatti .rank-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#panel-piatti .rank-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    RANK_MODE.piatti = btn.dataset.mode;
    renderRankList("piatti");
  });
});

document.querySelectorAll("#panel-bibite .rank-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#panel-bibite .rank-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    RANK_MODE.bibite = btn.dataset.mode;
    renderRankList("bibite");
  });
});

// --- Boot ---
refreshData();
setInterval(refreshData, CONFIG.REFRESH_SECONDS * 1000);

// Modalità diagnostica: apri l'app con ?debug=1 in fondo all'URL per vedere i dati grezzi ricevuti.

function showDebugPanel(err) {
  const old = document.getElementById("debugPanel");
  if (old) old.remove();
  const panel = document.createElement("div");
  panel.id = "debugPanel";
  panel.style.cssText =
    "position:fixed;inset:0;background:#000;color:#0f0;font-family:monospace;font-size:11px;padding:12px;overflow:auto;z-index:9999;white-space:pre-wrap;";
  let text = "DEBUG — tocca per chiudere\n\n";
  if (err) {
    text += "ERRORE:\n" + (err.message || String(err)) + "\n\n";
  }
  if (LAST_DATA) {
    text += JSON.stringify(
      {
        coperti2026_righe: LAST_DATA.coperti2026.length,
        coperti2026: LAST_DATA.coperti2026,
        coperti2025_righe: LAST_DATA.coperti2025.length,
      },
      null,
      2
    );
  } else {
    text += "(nessun dato caricato finora)";
  }
  panel.textContent = text;
  panel.addEventListener("click", () => panel.remove());
  document.body.appendChild(panel);
}

// Service worker (solo per lo shell dell'app, i dati sono sempre live)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
