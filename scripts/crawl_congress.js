/**
 * Congress -> OpenAI (AI summary + embeddings) -> Typesense upsert
 *
 * Notes:
 * - LIMIT_PER_RUN=0 means "all"
 * - INDEX_MODE:
 *    - upsert_new_updated (default)
 *    - upsert_new_updated_fix_tracking:
 *         - export from Typesense -> rebuild state
 *         - detect ALL docs missing embeddings -> backfill those FIRST (ALL)
 *         - then proceed like upsert_new_updated
 *    - reindex_all
 *
 * Schema lock (congress_bills):
 * Required fields (optional:false):
 *  - congress (int32)
 *  - type (string)
 *  - number (int32)
 *  - chamber (string)
 *  - introduced_date (int64)
 *  - update_date (int64)
 *  - title (string)
 *  - ai_summary_text (string)
 *  - embedding (float[] dim=3072)
 */

import fs from "fs";
import path from "path";
import { request } from "undici";
import OpenAI from "openai";

const STATE_PATH = path.join("state", "bills_state.json");

// ---------- logging ----------
function ts() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}
function warn(...args) {
  console.warn(`[${ts()}]`, ...args);
}
function errlog(...args) {
  console.error(`[${ts()}]`, ...args);
}
function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

// ---------- env helpers ----------
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
function envInt(name, defaultVal) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return defaultVal;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : defaultVal;
}
function envStr(name, defaultVal = "") {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return defaultVal;
  return String(v);
}

// ---------- state ----------
function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    return { meta: { last_run_utc: null, max_update_date_seen: null }, bills: {} };
  }
  const raw = fs.readFileSync(STATE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.meta) parsed.meta = { last_run_utc: null, max_update_date_seen: null };
  if (!parsed.bills) parsed.bills = {};
  return parsed;
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

// ---------- utils ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function normalizeBillId(congress, type, number) {
  return `${congress}-${String(type || "").toLowerCase()}-${String(number)}`;
}
function parseBillId(billId) {
  const parts = String(billId || "").split("-");
  if (parts.length < 3) return null;
  const congress = parts[0];
  const number = parts[parts.length - 1];
  const type = parts.slice(1, parts.length - 1).join("-");
  if (!congress || !type || !number) return null;
  return { congress, type, number };
}
function safeLower(s) {
  return String(s || "").toLowerCase();
}
function toEpochSeconds(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.floor(d.getTime() / 1000);
}
function truncate(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function pickUpdateDate(obj) {
  return obj?.updateDateIncludingText || obj?.updateDate || null;
}

// ---------- chamber fallback (schema-required) ----------
function deriveChamberFromType(type) {
  const t = safeLower(type);
  if (t.startsWith("h")) return "House";
  if (t.startsWith("s")) return "Senate";
  return "Unknown";
}
function normalizeChamber(v, fallbackType) {
  const s = String(v || "").trim();
  return s ? s : deriveChamberFromType(fallbackType);
}

// ---------- URL builders ----------
function buildCongressListUrl(congress, limit, offset) {
  const base = mustEnv("CONGRESS_API_BASE").replace(/\/$/, "");
  const key = mustEnv("CONGRESS_API_KEY");
  return `${base}/${congress}?format=json&sort=updateDate+desc&limit=${limit}&offset=${offset}&api_key=${encodeURIComponent(
    key
  )}`;
}
function buildBillDetailUrl(congress, billType, billNumber) {
  const base = mustEnv("CONGRESS_API_BASE").replace(/\/$/, "");
  const key = mustEnv("CONGRESS_API_KEY");
  return `${base}/${congress}/${safeLower(billType)}/${billNumber}?format=json&api_key=${encodeURIComponent(key)}`;
}
function withCongressApiKey(url) {
  const key = mustEnv("CONGRESS_API_KEY");
  const u = new URL(url);
  if (!u.searchParams.has("api_key")) u.searchParams.set("api_key", key);
  if (u.hostname.includes("api.congress.gov")) {
    if (!u.searchParams.has("format")) u.searchParams.set("format", "json");
  }
  return u.toString();
}

// ---------- robust fetchers ----------
async function fetchText(url, { label = "GET", retries = 3 } = {}) {
  let attempt = 0;
  while (true) {
    attempt++;
    const start = Date.now();
    try {
      const res = await request(url, { method: "GET" });
      const text = await res.body.text();
      const dur = Date.now() - start;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        log(`HTTP ${res.statusCode} ${label} ${fmtMs(dur)} ${url}`);
        return text;
      }

      const retryable = [429, 500, 502, 503, 504].includes(res.statusCode);
      warn(`HTTP ${res.statusCode} ${label} ${fmtMs(dur)} attempt ${attempt}/${retries} :: ${text.slice(0, 200)}`);

      if (!retryable || attempt >= retries) {
        throw new Error(`HTTP ${res.statusCode} for ${url}\n${text.slice(0, 800)}`);
      }
      await sleep(Math.min(2000 * attempt, 10000));
    } catch (e) {
      const dur = Date.now() - start;
      warn(`Fetch error ${label} ${fmtMs(dur)} attempt ${attempt}/${retries}: ${String(e.message || e)}`);
      if (attempt >= retries) throw e;
      await sleep(Math.min(2000 * attempt, 10000));
    }
  }
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse JSON from ${url}\n${text.slice(0, 500)}`);
  }
}

// ---------- Typesense upsert (NDJSON import) ----------
async function typesenseImportUpsert(docs, collectionName) {
  if (!docs.length) return { success: 0, failed: 0, errors: [] };

  const host = mustEnv("TYPESENSE_HOST");
  const port = mustEnv("TYPESENSE_PORT");
  const protocol = mustEnv("TYPESENSE_PROTOCOL");
  const apiKey = mustEnv("TYPESENSE_API_KEY");

  const url = `${protocol}://${host}:${port}/collections/${collectionName}/documents/import?action=upsert`;
  const ndjson = docs.map((d) => JSON.stringify(d)).join("\n");

  const start = Date.now();
  const res = await request(url, {
    method: "POST",
    headers: {
      "X-TYPESENSE-API-KEY": apiKey,
      "Content-Type": "text/plain"
    },
    body: ndjson
  });

  const text = await res.body.text();
  const dur = Date.now() - start;

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Typesense import failed HTTP ${res.statusCode} ${fmtMs(dur)}\n${text.slice(0, 1500)}`);
  }

  const lines = text.split("\n").filter(Boolean);
  let success = 0;
  let failed = 0;
  const errors = [];

  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.success) success++;
      else {
        failed++;
        if (r.error) errors.push(r.error);
      }
    } catch {
      failed++;
      errors.push("Unparseable import result line.");
    }
  }

  log(`Typesense import ${fmtMs(dur)} => ${success} ok, ${failed} failed (batch ${docs.length}) [${collectionName}]`);
  if (failed) warn(`Typesense sample errors [${collectionName}]:`, errors.slice(0, 5));
  return { success, failed, errors };
}

// ---------- Typesense export ----------
async function typesenseExportAll(collectionName) {
  const host = mustEnv("TYPESENSE_HOST");
  const port = mustEnv("TYPESENSE_PORT");
  const protocol = mustEnv("TYPESENSE_PROTOCOL");
  const apiKey = mustEnv("TYPESENSE_API_KEY");

  const url = `${protocol}://${host}:${port}/collections/${collectionName}/documents/export`;

  const start = Date.now();
  const res = await request(url, {
    method: "GET",
    headers: { "X-TYPESENSE-API-KEY": apiKey }
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await res.body.text();
    throw new Error(`Typesense export failed HTTP ${res.statusCode}\n${text.slice(0, 1200)}`);
  }

  const text = await res.body.text();
  const lines = text.split("\n").filter(Boolean);
  log(`Typesense export ${fmtMs(Date.now() - start)} => ${lines.length} docs [${collectionName}]`);

  const docs = [];
  for (const line of lines) {
    try {
      docs.push(JSON.parse(line));
    } catch {
      // ignore
    }
  }
  return docs;
}

// ---------- rebuild state ----------
function rebuildStateFromTypesenseDocs(state, docs, { summaryModel, embedModel } = {}) {
  const nowIso = ts();
  const bills = {};

  for (const d of docs) {
    const id = d?.id;
    if (!id) continue;

    const raw = d?.update_date_raw || null;
    const epoch =
      Number.isFinite(d?.update_date) && d.update_date > 0
        ? d.update_date
        : (raw ? toEpochSeconds(raw) : 0);

    // We can still track even if epoch=0, but require something present
    if (!raw && !epoch) continue;

    bills[id] = {
      update_date_raw: raw || null,
      update_date_epoch: epoch || 0,
      ai_summary_model: summaryModel || undefined,
      embed_model: embedModel || undefined,
      indexed_at_utc: nowIso
    };
  }

  state.bills = bills;
  state.meta = state.meta || {};
  state.meta.last_fix_tracking_utc = nowIso;
  state.meta.last_fix_tracking_source_count = docs.length;

  return state;
}

// ---------- missing embeddings detection (export scan) ----------
function findBillsMissingEmbeddings(docs, expectedDim = 3072) {
  const missing = [];
  for (const d of docs) {
    const id = d?.id;
    if (!id) continue;
    const emb = d?.embedding;
    const ok = Array.isArray(emb) && emb.length === expectedDim;
    if (!ok) missing.push(String(id));
  }
  return missing;
}

// ---------- OpenAI retry ----------
async function openaiWithRetry(fn, { label, retries = 4 } = {}) {
  let attempt = 0;
  while (true) {
    attempt++;
    const start = Date.now();
    try {
      const result = await fn();
      const dur = Date.now() - start;
      log(`OpenAI ${label} ok ${fmtMs(dur)} (attempt ${attempt}/${retries})`);
      return result;
    } catch (e) {
      const dur = Date.now() - start;
      const msg = String(e?.message || e);
      const status = e?.status || e?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || /rate limit/i.test(msg);
      warn(`OpenAI ${label} fail ${fmtMs(dur)} (attempt ${attempt}/${retries}) :: ${msg}`);
      if (!retryable || attempt >= retries) throw e;
      await sleep(Math.min(1500 * attempt, 20000));
    }
  }
}

// ---------- extraction helpers ----------
function extractSponsor(detailJson) {
  const sponsors = detailJson?.bill?.sponsors || detailJson?.sponsors || [];
  const first = Array.isArray(sponsors) && sponsors.length ? sponsors[0] : null;
  if (!first) return {};
  return {
    sponsor_party: first.party || undefined,
    sponsor_state: first.state || undefined
  };
}
function extractPolicyArea(detailJson) {
  const pa = detailJson?.bill?.policyArea?.name || detailJson?.policyArea?.name;
  return pa ? String(pa) : undefined;
}
function extractSubjects(detailJson) {
  const subj = detailJson?.bill?.subjects?.billSubjects || detailJson?.bill?.subjects || detailJson?.subjects;
  if (!subj) return undefined;
  const arr = Array.isArray(subj) ? subj : (subj?.items || subj?.subjects || []);
  if (!Array.isArray(arr)) return undefined;
  const names = arr.map((x) => x?.name).filter(Boolean).map(String);
  return names.length ? names : undefined;
}
function extractCosponsorCount(detailJson) {
  const cs = detailJson?.bill?.cosponsors || detailJson?.cosponsors;
  const count = cs?.count;
  return Number.isFinite(count) ? count : undefined;
}
function extractIntroducedDate(detailJson) {
  const d = detailJson?.bill?.introducedDate || detailJson?.introducedDate;
  return d ? toEpochSeconds(d) : 0; // schema requires int64; 0 is allowed
}
function extractLatestActionDate(detailJson, listItem) {
  const d =
    listItem?.latestAction?.actionDate ||
    detailJson?.bill?.latestAction?.actionDate ||
    detailJson?.latestAction?.actionDate;
  return d ? toEpochSeconds(d) : undefined;
}
function extractCommittees(detailJson) {
  const committeesObj = detailJson?.bill?.committees || detailJson?.committees;
  const direct = committeesObj?.items || committeesObj?.committees || committeesObj;
  if (Array.isArray(direct)) {
    const names = direct.map((c) => c?.name).filter(Boolean).map(String);
    return { committees: names.length ? names : undefined, committees_url: committeesObj?.url };
  }
  return { committees: undefined, committees_url: committeesObj?.url };
}
async function fetchCommitteesIfNeeded(detailJson) {
  const { committees, committees_url } = extractCommittees(detailJson);
  if (committees) return { committees };

  if (!committees_url) return { committees: undefined };

  try {
    const url = withCongressApiKey(committees_url);
    const data = await fetchJson(url, { label: "COMMITTEES", retries: 2 });
    const arr = data?.committees || data?.items || data?.results || [];
    if (!Array.isArray(arr)) return { committees: undefined };
    const names = arr.map((c) => c?.name).filter(Boolean).map(String);
    return { committees: names.length ? names : undefined };
  } catch (e) {
    warn("Committees fetch failed:", String(e.message || e));
    return { committees: undefined };
  }
}

function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
async function getBestOfficialSummaryText(detailJson) {
  const summariesObj = detailJson?.bill?.summaries || detailJson?.summaries;
  const summariesUrl = summariesObj?.url;
  if (!summariesUrl) return "";
  const signed = withCongressApiKey(summariesUrl);
  const data = await fetchJson(signed, { label: "SUMMARIES", retries: 2 });
  const arr = data?.summaries || data?.results || [];
  if (!Array.isArray(arr) || !arr.length) return "";
  const textHtml = arr[0]?.text || "";
  return stripHtml(textHtml);
}

// ---------- single bill processor (schema-locked) ----------
async function processOneBill({
  openai,
  summaryModel,
  embedModel,
  item,
  forcedBillId,
  primaryCollection,
  state,
  batch,
  batchSize
}) {
  const billId = forcedBillId || normalizeBillId(item.congress, item.type, item.number);

  let congress = item?.congress;
  let billType = item?.type;
  let billNumber = item?.number;

  if (!congress || !billType || !billNumber) {
    const parsed = parseBillId(billId);
    if (!parsed) throw new Error(`Cannot parse billId: ${billId}`);
    congress = parsed.congress;
    billType = parsed.type;
    billNumber = parsed.number;
  }

  const detailUrl = buildBillDetailUrl(congress, billType, billNumber);
  const detailJson = await fetchJson(detailUrl, { label: "DETAIL", retries: 3 });

  // Required fields (schema)
  const congressInt = parseInt(congress, 10);
  const typeStr = safeLower(billType);
  const numberInt = parseInt(billNumber, 10);

  // title required
  const title = String(item?.title || detailJson?.bill?.title || "").trim() || billId;

  // chamber required
  const chamberRaw =
    item?.originChamber ||
    detailJson?.bill?.originChamber ||
    detailJson?.originChamber ||
    undefined;
  const chamber = normalizeChamber(chamberRaw, billType);

  const introduced_date = extractIntroducedDate(detailJson); // required int64

  // update_date required int64
  const updateRaw =
    pickUpdateDate(item) ||
    pickUpdateDate(detailJson?.bill) ||
    pickUpdateDate(detailJson) ||
    null;

  // If still missing, at least keep it sortable-ish: fall back to introduced_date
  const update_date = updateRaw ? toEpochSeconds(updateRaw) : (introduced_date || 0);

  // Optional extras
  const short_title = detailJson?.bill?.shortTitle || detailJson?.bill?.short_title || undefined;
  const policy_area = extractPolicyArea(detailJson);
  const subjects = extractSubjects(detailJson);
  const { sponsor_party, sponsor_state } = extractSponsor(detailJson);
  const cosponsor_count = extractCosponsorCount(detailJson);

  const latest_action_text =
    item?.latestAction?.text ||
    detailJson?.bill?.latestAction?.text ||
    undefined;

  const latest_action_date = extractLatestActionDate(detailJson, item);

  const { committees } = await fetchCommitteesIfNeeded(detailJson);

  let official_summary = "";
  try {
    official_summary = await getBestOfficialSummaryText(detailJson);
  } catch (e) {
    warn(`Official summary fetch failed for ${billId}: ${String(e.message || e)}`);
  }

  const aiInput = [
    `TITLE: ${title}`,
    short_title ? `SHORT TITLE: ${short_title}` : "",
    policy_area ? `POLICY AREA: ${policy_area}` : "",
    `CHAMBER: ${chamber}`,
    sponsor_party || sponsor_state ? `SPONSOR: ${sponsor_party || "?"}-${sponsor_state || "?"}` : "",
    committees?.length ? `COMMITTEES: ${committees.slice(0, 10).join("; ")}` : "",
    latest_action_text ? `LATEST ACTION: ${latest_action_text}` : "",
    official_summary ? `OFFICIAL SUMMARY: ${truncate(official_summary, 2500)}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  // ai_summary_text required
  const summaryResp = await openaiWithRetry(
    () =>
      openai.responses.create({
        model: summaryModel,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "Write a clear, plain-English summary of this U.S. Congress bill in 2–3 sentences. " +
                  "Focus on what it does. Do not speculate. No bullets."
              }
            ]
          },
          { role: "user", content: [{ type: "input_text", text: aiInput }] }
        ]
      }),
    { label: `summary ${billId}`, retries: 4 }
  );

  const ai_summary_text = String((summaryResp.output_text || "").trim() || title).trim() || billId;

  // embedding required (dim 3072)
  const embedText = [
    title,
    short_title || "",
    ai_summary_text,
    policy_area ? `Policy area: ${policy_area}` : "",
    latest_action_text ? `Latest action: ${latest_action_text}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const embResp = await openaiWithRetry(
    () =>
      openai.embeddings.create({
        model: embedModel,
        input: embedText,
        encoding_format: "float"
      }),
    { label: `embed(bill) ${billId}`, retries: 4 }
  );

  const embedding = embResp?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error(`Embedding missing/invalid for ${billId}`);
  if (embedding.length !== 3072) throw new Error(`Embedding dim mismatch for ${billId}: got ${embedding.length}, expected 3072`);

  // Build doc: ONLY include schema fields (and no undefined required fields)
  const doc = {
    id: billId,
    congress: congressInt,
    type: typeStr,
    number: numberInt,
    chamber,
    introduced_date,
    update_date,
    title,
    short_title,       // optional
    ai_summary_text,
    policy_area,       // optional
    subjects,          // optional
    status: undefined, // optional (omit)
    committee_stage: undefined, // optional (omit)
    committees,        // optional
    sponsor_party,     // optional
    sponsor_state,     // optional
    cosponsor_count,   // optional
    latest_action_text,// optional
    embedding
  };

  // Strip undefined optional keys so JSON.stringify doesn’t include them at all
  for (const k of Object.keys(doc)) {
    if (doc[k] === undefined) delete doc[k];
  }

  batch.push(doc);

  // Update state
  state.bills[billId] = {
    update_date_raw: updateRaw || null,
    update_date_epoch: update_date || 0,
    ai_summary_model: summaryModel,
    embed_model: embedModel,
    indexed_at_utc: ts()
  };

  // Flush
  if (batch.length >= batchSize) {
    const r = await typesenseImportUpsert(batch, primaryCollection);
    batch.length = 0;
    return { ok: r.success, fail: r.failed };
  }
  return { ok: 0, fail: 0 };
}

// ---------- main ----------
async function main() {
  mustEnv("CONGRESS_API_KEY");
  mustEnv("CONGRESS_API_BASE");

  mustEnv("TYPESENSE_API_KEY");
  mustEnv("TYPESENSE_HOST");
  mustEnv("TYPESENSE_PORT");
  mustEnv("TYPESENSE_PROTOCOL");
  mustEnv("TYPESENSE_COLLECTION");

  mustEnv("OPENAI_API_KEY");

  const openai = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });
  const summaryModel = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";
  const embedModel = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-large";

  const indexMode = envStr("INDEX_MODE", "upsert_new_updated").trim();
  const reindexAll = indexMode === "reindex_all";

  const limitPerRunRaw = envInt("LIMIT_PER_RUN", 25);
  const limitPerRun = limitPerRunRaw === 0 ? Number.MAX_SAFE_INTEGER : limitPerRunRaw;

  const pageSize = envInt("CONGRESS_PAGE_SIZE", 100);
  const tsBatchSize = envInt("TYPESENSE_BATCH_SIZE", 10);

  const congresses = (process.env.CONGRESSES || "119")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const primaryCollection = mustEnv("TYPESENSE_COLLECTION");

  const state = loadState();
  const prevMaxUpdate = state?.meta?.max_update_date_seen || null;

  log("=== Crawl start ===");
  log("Index mode:", indexMode);
  log("Congresses:", congresses.join(", "));
  log("LIMIT_PER_RUN:", limitPerRunRaw === 0 ? "all" : limitPerRunRaw);
  log("Prev max_update_date_seen:", prevMaxUpdate);
  log("OpenAI summary model:", summaryModel);
  log("OpenAI embed model:", embedModel);
  log("Typesense batch size:", tsBatchSize);
  log("Congress page size:", pageSize);

  let processed = 0;
  let newestUpdateSeenThisRun = null;
  let typesenseOk = 0;
  let typesenseFail = 0;

  const batch = [];
  const startAll = Date.now();

  // ---- Fix tracking + backfill missing embeddings first (ALL) ----
  let backfillIds = new Set();
  if (indexMode === "upsert_new_updated_fix_tracking") {
    log("Fix-tracking: exporting from Typesense to rebuild state...");
    const docs = await typesenseExportAll(primaryCollection);
    rebuildStateFromTypesenseDocs(state, docs, { summaryModel, embedModel });

    const missing = findBillsMissingEmbeddings(docs, 3072);
    backfillIds = new Set(missing);

    saveState(state);

    log("Fix-tracking: state rebuilt + written to disk.");
    log(`Fix-tracking: missing embeddings detected: ${missing.length}`);
    if (missing.length) log("Fix-tracking: backfilling ALL missing embeddings first...");
  }

  // Phase 1: backfill
  if (backfillIds.size) {
    const arr = Array.from(backfillIds);
    for (let i = 0; i < arr.length; i++) {
      const billId = arr[i];
      log(`=== Backfill ${i + 1}/${arr.length}: ${billId} ===`);
      const r = await processOneBill({
        openai,
        summaryModel,
        embedModel,
        item: null,
        forcedBillId: billId,
        primaryCollection,
        state,
        batch,
        batchSize: tsBatchSize
      });
      typesenseOk += r.ok;
      typesenseFail += r.fail;
      processed++;
    }
  }

  // Phase 2: normal crawl (new/updated or reindex_all)
  for (const congress of congresses) {
    let offset = 0;

    while (processed < limitPerRun) {
      const listUrl = buildCongressListUrl(congress, pageSize, offset);
      log(`Fetching list congress=${congress} offset=${offset} limit=${pageSize}`);
      const listJson = await fetchJson(listUrl, { label: "LIST", retries: 3 });
      const bills = listJson?.bills || listJson?.results || [];

      if (!Array.isArray(bills) || bills.length === 0) {
        log(`No bills returned for congress ${congress} at offset ${offset}.`);
        break;
      }

      for (const item of bills) {
        if (processed >= limitPerRun) break;

        const billId = normalizeBillId(item.congress, item.type, item.number);
        const apiUpdateRaw = pickUpdateDate(item);
        if (!newestUpdateSeenThisRun && apiUpdateRaw) newestUpdateSeenThisRun = apiUpdateRaw;

        // If it was already backfilled this run, skip
        if (backfillIds.has(billId)) continue;

        const prev = state.bills[billId];
        const prevUpdateRaw = prev?.update_date_raw || prev?.update_date || null;
        const shouldProcess = reindexAll ? true : (!prev || prevUpdateRaw !== apiUpdateRaw);
        if (!shouldProcess) continue;

        const idxLabel = `${processed + 1}/${limitPerRunRaw === 0 ? "all" : limitPerRunRaw}`;
        log(`--- Processing ${idxLabel}: ${billId} (api_update=${apiUpdateRaw || "n/a"}) ---`);

        const r = await processOneBill({
          openai,
          summaryModel,
          embedModel,
          item,
          forcedBillId: null,
          primaryCollection,
          state,
          batch,
          batchSize: tsBatchSize
        });

        typesenseOk += r.ok;
        typesenseFail += r.fail;

        processed++;
        log(`--- Finished ${idxLabel}: ${billId} ---`);
      }

      offset += pageSize;
    }
  }

  // Final flush
  if (batch.length) {
    const r = await typesenseImportUpsert(batch, primaryCollection);
    typesenseOk += r.success;
    typesenseFail += r.failed;
    batch.length = 0;
  }

  // meta
  state.meta = state.meta || {};
  state.meta.last_run_utc = new Date().toISOString();
  if (newestUpdateSeenThisRun) state.meta.max_update_date_seen = newestUpdateSeenThisRun;

  saveState(state);

  log("=== Crawl complete ===");
  log("Bills processed:", processed);
  log("Typesense bills ok:", typesenseOk, "failed:", typesenseFail);
  log("New max_update_date_seen:", state.meta.max_update_date_seen);
  log("Total duration:", fmtMs(Date.now() - startAll));
}

main().catch((e) => {
  errlog("Crawler failed:", String(e?.message || e));
  if (e?.stack) errlog(e.stack);
  process.exit(1);
});
