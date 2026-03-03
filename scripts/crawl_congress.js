/**
 * Congress -> OpenAI (AI summary + embeddings) -> Typesense upsert
 * Also: Fetch full bill text -> chunk -> embed -> Typesense upsert to bill_chunks
 *
 * Notes:
 * - LIMIT_PER_RUN=0 means "all"
 * - INDEX_MODE:
 *   - upsert_new_updated (default)
 *   - upsert_new_updated_fix_tracking (rebuild state from Typesense first)
 *   - reindex_all
 *
 * - Congress API list sorting MUST be: sort=updateDate+desc (newest first)
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
function toEpochSeconds(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.floor(d.getTime() / 1000);
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
function truncate(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function pickUpdateDate(item) {
  return item.updateDateIncludingText || item.updateDate || null;
}
function safeLower(s) {
  return String(s || "").toLowerCase();
}

// ---------- URL helpers/builders ----------
function buildCongressListUrl(congress, limit, offset) {
  const base = mustEnv("CONGRESS_API_BASE").replace(/\/$/, "");
  const key = mustEnv("CONGRESS_API_KEY");

  // IMPORTANT: newest first
  // Congress.gov API expects: sort=updateDate+desc or updateDate+asc
  const sort = "updateDate+desc";

  return `${base}/${congress}?format=json&sort=${encodeURIComponent(sort)}&limit=${limit}&offset=${offset}&api_key=${encodeURIComponent(
    key
  )}`;
}
function buildBillDetailUrl(congress, billType, billNumber) {
  const base = mustEnv("CONGRESS_API_BASE").replace(/\/$/, "");
  const key = mustEnv("CONGRESS_API_KEY");
  return `${base}/${congress}/${safeLower(billType)}/${billNumber}?format=json&api_key=${encodeURIComponent(key)}`;
}
function buildBillTextIndexUrl(congress, billType, billNumber) {
  const base = mustEnv("CONGRESS_API_BASE").replace(/\/$/, "");
  const key = mustEnv("CONGRESS_API_KEY");
  return `${base}/${congress}/${safeLower(billType)}/${billNumber}/text?format=json&api_key=${encodeURIComponent(key)}`;
}
function withCongressApiKey(url) {
  const key = mustEnv("CONGRESS_API_KEY");
  const u = new URL(url);
  if (!u.searchParams.has("api_key")) u.searchParams.set("api_key", key);
  if (!u.searchParams.has("format")) u.searchParams.set("format", "json");
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

// ---------- Typesense helpers ----------
function typesenseBase() {
  const host = mustEnv("TYPESENSE_HOST");
  const port = mustEnv("TYPESENSE_PORT");
  const protocol = mustEnv("TYPESENSE_PROTOCOL");
  return `${protocol}://${host}:${port}`;
}
function typesenseHeaders() {
  return { "X-TYPESENSE-API-KEY": mustEnv("TYPESENSE_API_KEY") };
}

// NDJSON import upsert
async function typesenseImportUpsert(docs, collectionName) {
  if (!docs.length) return { success: 0, failed: 0, errors: [] };

  const url = `${typesenseBase()}/collections/${collectionName}/documents/import?action=upsert`;
  const ndjson = docs.map((d) => JSON.stringify(d)).join("\n");

  const start = Date.now();
  const res = await request(url, {
    method: "POST",
    headers: {
      ...typesenseHeaders(),
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

// Export IDs + update fields to rebuild state
async function typesenseExportState(collectionName) {
  const url = `${typesenseBase()}/collections/${collectionName}/documents/export?include_fields=id,update_date_raw,update_date`;
  const start = Date.now();
  const res = await request(url, {
    method: "GET",
    headers: { ...typesenseHeaders() }
  });

  const text = await res.body.text();
  const dur = Date.now() - start;

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Typesense export failed HTTP ${res.statusCode} ${fmtMs(dur)}\n${text.slice(0, 1500)}`);
  }

  const lines = text.split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore bad line
    }
  }
  log(`Typesense export ${fmtMs(dur)} => ${out.length} docs [${collectionName}]`);
  return out;
}

// ---------- OpenAI helpers with retry ----------
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

      const waitMs = Math.min(1500 * attempt, 20000);
      await sleep(waitMs);
    }
  }
}

// ---------- extraction ----------
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
  return d ? toEpochSeconds(d) : 0;
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
    const codes = direct.map((c) => c?.systemCode || c?.code).filter(Boolean).map(String);
    return {
      committees: names.length ? names : undefined,
      committee_codes: codes.length ? codes : undefined,
      committees_url: committeesObj?.url
    };
  }
  return { committees: undefined, committee_codes: undefined, committees_url: committeesObj?.url };
}
async function fetchCommitteesIfNeeded(detailJson) {
  const { committees, committee_codes, committees_url } = extractCommittees(detailJson);
  if (committees || committee_codes) return { committees, committee_codes };

  if (!committees_url) return { committees: undefined, committee_codes: undefined };

  try {
    const url = withCongressApiKey(committees_url);
    const data = await fetchJson(url, { label: "COMMITTEES", retries: 2 });
    const arr = data?.committees || data?.items || data?.results || [];
    if (!Array.isArray(arr)) return { committees: undefined, committee_codes: undefined };

    const names = arr.map((c) => c?.name).filter(Boolean).map(String);
    const codes = arr.map((c) => c?.systemCode || c?.code).filter(Boolean).map(String);

    return { committees: names.length ? names : undefined, committee_codes: codes.length ? codes : undefined };
  } catch (e) {
    warn("Committees fetch failed:", String(e.message || e));
    return { committees: undefined, committee_codes: undefined };
  }
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

// ---------- bill text fetching + chunking ----------
function chooseBestTextLink(textIndexJson) {
  const versions =
    textIndexJson?.textVersions ||
    textIndexJson?.billText ||
    textIndexJson?.versions ||
    textIndexJson?.results ||
    [];
  const arr = Array.isArray(versions) ? versions : [];
  if (!arr.length) return null;

  const candidates = [];
  for (const v of arr) {
    const versionLabel = v?.type || v?.versionName || v?.version || v?.date || "Text";
    const formats = v?.formats || v?.text || v?.items || [];
    const fArr = Array.isArray(formats) ? formats : [];
    for (const f of fArr) {
      const url = f?.url || f?.link || f?.documentUrl;
      const format = (f?.type || f?.format || f?.mimeType || "").toString();
      if (url) candidates.push({ url, format, versionLabel });
    }
    if (v?.url) candidates.push({ url: v.url, format: v?.format || "", versionLabel });
  }

  if (!candidates.length) return null;

  const score = (c) => {
    const s = `${c.format}`.toLowerCase();
    if (s.includes("html")) return 1;
    if (s.includes("formatted")) return 2;
    if (s.includes("xml")) return 3;
    if (s.includes("pdf")) return 9;
    return 5;
  };

  candidates.sort((a, b) => score(a) - score(b));
  return candidates[0];
}

async function fetchBillTextPlain(congress, type, number) {
  const textIndexUrl = buildBillTextIndexUrl(congress, type, number);
  const idx = await fetchJson(textIndexUrl, { label: "TEXT_INDEX", retries: 2 });

  const chosen = chooseBestTextLink(idx);
  if (!chosen) return { text: "", source_url: undefined, version_label: undefined };

  const source_url_signed = withCongressApiKey(chosen.url);
  const raw = await fetchText(source_url_signed, { label: "TEXT", retries: 2 });

  const looksHtml = /<[^>]+>/.test(raw) && /<\/(p|div|span|body|html)>/i.test(raw);
  const text = looksHtml ? stripHtml(raw) : raw.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return { text: text || "", source_url: chosen.url, version_label: chosen.versionLabel || undefined };
}

function chunkText(text, { maxChars = 5500, overlapChars = 600 } = {}) {
  const clean = String(text || "").replace(/\r/g, "").trim();
  if (!clean) return [];

  const parts = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const chunks = [];
  let current = "";

  function pushChunk(s) {
    const c = s.trim();
    if (c) chunks.push(c);
  }

  for (const p of parts) {
    if (!current) {
      current = p;
      continue;
    }
    if (current.length + 2 + p.length <= maxChars) {
      current += "\n\n" + p;
    } else {
      pushChunk(current);

      const tail = current.slice(Math.max(0, current.length - overlapChars));
      current = tail + "\n\n" + p;

      while (current.length > maxChars * 1.3) {
        pushChunk(current.slice(0, maxChars));
        const tail2 = current.slice(Math.max(0, maxChars - overlapChars));
        current = tail2;
      }
    }
  }

  pushChunk(current);
  return chunks;
}

// ---------- index mode ----------
const INDEX_MODE_VALUES = new Set([
  "upsert_new_updated",
  "upsert_new_updated_fix_tracking",
  "reindex_all"
]);

function getIndexMode() {
  const raw = (process.env.INDEX_MODE || "upsert_new_updated").trim();
  if (!INDEX_MODE_VALUES.has(raw)) return "upsert_new_updated";
  return raw;
}

function shouldProcessBill({ mode, prev, apiUpdateRaw, apiUpdateEpoch }) {
  if (mode === "reindex_all") return true;

  if (!prev) return true;

  // Back-compat with older state that stored update_date as raw string
  const prevRaw = prev.update_date_raw ?? prev.update_date ?? null;
  const prevEpoch = prev.update_date_epoch ?? null;

  // If we have raw strings on both sides, prefer that
  if (prevRaw && apiUpdateRaw && String(prevRaw) === String(apiUpdateRaw)) return false;

  // Else compare epoch seconds if available
  if (Number.isFinite(prevEpoch) && Number.isFinite(apiUpdateEpoch) && prevEpoch === apiUpdateEpoch) return false;

  // Otherwise, treat as changed
  return true;
}

// ---------- main ----------
async function main() {
  // Required env
  mustEnv("CONGRESS_API_KEY");
  mustEnv("CONGRESS_API_BASE");

  mustEnv("TYPESENSE_API_KEY");
  mustEnv("TYPESENSE_HOST");
  mustEnv("TYPESENSE_PORT");
  mustEnv("TYPESENSE_PROTOCOL");
  mustEnv("TYPESENSE_COLLECTION");
  mustEnv("TYPESENSE_CHUNKS_COLLECTION");

  mustEnv("OPENAI_API_KEY");

  const openai = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });
  const summaryModel = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";
  const embedModel = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-large";

  const indexMode = getIndexMode();

  const limitPerRunRaw = envInt("LIMIT_PER_RUN", 25);
  const limitPerRun = limitPerRunRaw === 0 ? Number.MAX_SAFE_INTEGER : limitPerRunRaw;

  const pageSize = envInt("CONGRESS_PAGE_SIZE", 100);
  const tsBatchSize = envInt("TYPESENSE_BATCH_SIZE", 10);
  const chunkBatchSize = envInt("CHUNK_BATCH_SIZE", 20);

  const congresses = (process.env.CONGRESSES || "119")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const primaryCollection = mustEnv("TYPESENSE_COLLECTION");
  const chunksCollection = mustEnv("TYPESENSE_CHUNKS_COLLECTION");

  const state = loadState();

  log("=== Crawl start ===");
  log("Index mode:", indexMode);
  log("Congresses:", congresses.join(", "));
  log("LIMIT_PER_RUN:", limitPerRunRaw === 0 ? "all" : limitPerRunRaw);
  log("Prev max_update_date_seen:", state?.meta?.max_update_date_seen || null);
  log("OpenAI summary model:", summaryModel);
  log("OpenAI embed model:", embedModel);
  log("Typesense batch size:", tsBatchSize);
  log("Chunk batch size:", chunkBatchSize);
  log("Congress page size:", pageSize);

  // ---- Mode #2: Fix tracking from Typesense before crawling
  if (indexMode === "upsert_new_updated_fix_tracking") {
    log("Fix-tracking: exporting from Typesense to rebuild state...");
    const exported = await typesenseExportState(primaryCollection);

    // Rebuild bills state
    state.bills = state.bills || {};
    for (const doc of exported) {
      const id = doc?.id;
      if (!id) continue;

      const updateRaw = doc?.update_date_raw || null;
      const updateEpoch = Number.isFinite(doc?.update_date) ? doc.update_date : null;

      state.bills[id] = {
        update_date_raw: updateRaw,
        update_date_epoch: updateEpoch,
        ai_summary_model: state.bills?.[id]?.ai_summary_model,
        embed_model: state.bills?.[id]?.embed_model
      };
    }

    // A reasonable max_update_date_seen for logging: pick latest raw we can parse
    let best = null;
    for (const doc of exported) {
      const raw = doc?.update_date_raw;
      if (!raw) continue;
      if (!best) best = raw;
      else {
        const a = new Date(best).getTime();
        const b = new Date(raw).getTime();
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) best = raw;
      }
    }
    if (best) state.meta.max_update_date_seen = best;

    state.meta.last_run_utc = new Date().toISOString();
    saveState(state);
    log("Fix-tracking: state rebuilt + written to disk.");
  }

  let processed = 0;
  let newestUpdateSeenThisRun = null; // track max (not just first)

  let typesenseOk = 0;
  let typesenseFail = 0;

  let chunksOk = 0;
  let chunksFail = 0;

  const billsBatch = [];
  const chunksBatch = [];

  const startAll = Date.now();

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
        const apiUpdateEpoch = toEpochSeconds(apiUpdateRaw);

        // Track newest seen this run (max)
        if (apiUpdateRaw) {
          if (!newestUpdateSeenThisRun) newestUpdateSeenThisRun = apiUpdateRaw;
          else {
            const a = new Date(newestUpdateSeenThisRun).getTime();
            const b = new Date(apiUpdateRaw).getTime();
            if (Number.isFinite(a) && Number.isFinite(b) && b > a) newestUpdateSeenThisRun = apiUpdateRaw;
          }
        }

        const prev = state.bills[billId];

        const shouldProcess = shouldProcessBill({
          mode: indexMode === "reindex_all" ? "reindex_all" : "upsert_new_updated",
          prev,
          apiUpdateRaw,
          apiUpdateEpoch
        });

        if (!shouldProcess) continue;

        const idxLabel = `${processed + 1}/${limitPerRunRaw === 0 ? "all" : limitPerRunRaw}`;
        log(`--- Processing ${idxLabel}: ${billId} (api_update=${apiUpdateRaw || "n/a"}) ---`);

        // Detail
        const detailUrl = buildBillDetailUrl(item.congress, item.type, item.number);
        const tDetail0 = Date.now();
        const detailJson = await fetchJson(detailUrl, { label: "DETAIL", retries: 3 });
        log(`Detail fetched ${fmtMs(Date.now() - tDetail0)} for ${billId}`);

        const title = item.title || detailJson?.bill?.title || "";
        const short_title = detailJson?.bill?.shortTitle || detailJson?.bill?.short_title || undefined;
        const chamber = item.originChamber || detailJson?.bill?.originChamber || undefined;

        const latest_action_text = item?.latestAction?.text || detailJson?.bill?.latestAction?.text || undefined;
        const latest_action_date = extractLatestActionDate(detailJson, item);

        const update_date_raw = apiUpdateRaw;
        const update_date = apiUpdateEpoch;
        const introduced_date = extractIntroducedDate(detailJson);
        const policy_area = extractPolicyArea(detailJson);
        const subjects = extractSubjects(detailJson);
        const { sponsor_party, sponsor_state } = extractSponsor(detailJson);
        const cosponsor_count = extractCosponsorCount(detailJson);

        const { committees, committee_codes } = await fetchCommitteesIfNeeded(detailJson);

        // Official summary
        let official_summary = "";
        try {
          official_summary = await getBestOfficialSummaryText(detailJson);
          if (official_summary) log(`Official summary chars: ${official_summary.length}`);
        } catch (e) {
          warn(`Official summary fetch failed for ${billId}: ${String(e.message || e)}`);
        }

        // AI summary input
        const aiInput = [
          `TITLE: ${title}`,
          short_title ? `SHORT TITLE: ${short_title}` : "",
          policy_area ? `POLICY AREA: ${policy_area}` : "",
          chamber ? `CHAMBER: ${chamber}` : "",
          sponsor_party || sponsor_state ? `SPONSOR: ${sponsor_party || "?"}-${sponsor_state || "?"}` : "",
          committees?.length ? `COMMITTEES: ${committees.slice(0, 10).join("; ")}` : "",
          latest_action_text ? `LATEST ACTION: ${latest_action_text}` : "",
          official_summary ? `OFFICIAL SUMMARY: ${truncate(official_summary, 2500)}` : ""
        ]
          .filter(Boolean)
          .join("\n");

        // AI summary
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

        const ai_summary_text = (summaryResp.output_text || "").trim() || title;
        log(`AI summary length: ${ai_summary_text.length} chars`);

        // Bill-level embedding
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
        log(`Bill embedding ok (dim=${embedding.length})`);

        const billDoc = {
          id: billId,
          congress: item.congress,
          type: safeLower(item.type),
          number: parseInt(item.number, 10),

          chamber,
          introduced_date,
          update_date,

          title,
          short_title,
          ai_summary_text,

          policy_area,
          subjects,

          sponsor_party,
          sponsor_state,
          cosponsor_count,

          latest_action_text,

          status: undefined,
          committee_stage: undefined,

          committees,
          committee_codes,

          embedding,

          // disk-only extras
          api_url: (item.url || detailUrl) || undefined,
          official_summary: official_summary || undefined,
          update_date_raw: update_date_raw || undefined,
          latest_action_date: latest_action_date || undefined
        };

        billsBatch.push(billDoc);

        // -------- Bill text -> chunks --------
        try {
          const tText0 = Date.now();
          const { text: fullText, source_url, version_label } = await fetchBillTextPlain(item.congress, item.type, item.number);
          log(`Bill text fetched ${fmtMs(Date.now() - tText0)} chars=${fullText.length}`);

          if (fullText && fullText.length > 200) {
            const chunks = chunkText(fullText, { maxChars: 5500, overlapChars: 600 });
            log(`Chunked into ${chunks.length} chunks`);

            for (let ci = 0; ci < chunks.length; ci++) {
              const chunkTextStr = chunks[ci];

              const chEmbResp = await openaiWithRetry(
                () =>
                  openai.embeddings.create({
                    model: embedModel,
                    input: chunkTextStr,
                    encoding_format: "float"
                  }),
                { label: `embed(chunk) ${billId}#${ci}`, retries: 4 }
              );

              const chEmbedding = chEmbResp?.data?.[0]?.embedding;
              if (!Array.isArray(chEmbedding)) throw new Error(`Chunk embedding missing for ${billId}#${ci}`);
              if (chEmbedding.length !== 3072) throw new Error(`Chunk embedding dim mismatch for ${billId}#${ci}`);

              const chunkId = `${billId}#${String(ci).padStart(5, "0")}`;

              chunksBatch.push({
                id: chunkId,
                bill_id: billId,
                congress: item.congress,
                type: safeLower(item.type),
                number: parseInt(item.number, 10),
                chunk_index: ci,
                text: chunkTextStr,
                update_date,
                source_url: source_url || undefined,
                version_label: version_label || undefined,
                embedding: chEmbedding
              });

              if (chunksBatch.length >= chunkBatchSize) {
                const r = await typesenseImportUpsert(chunksBatch, chunksCollection);
                chunksOk += r.success;
                chunksFail += r.failed;
                chunksBatch.length = 0;
              }
            }
          } else {
            warn("No usable bill text returned (too short/empty). Skipping chunks.");
          }
        } catch (e) {
          warn(`Bill text/chunking failed for ${billId}: ${String(e.message || e)}`);
        }

        // Update state for this bill
        state.bills[billId] = {
          update_date_raw: apiUpdateRaw,
          update_date_epoch: apiUpdateEpoch,
          ai_summary_model: summaryModel,
          embed_model: embedModel
        };

        processed++;

        // Flush bills batch
        if (billsBatch.length >= tsBatchSize) {
          const r = await typesenseImportUpsert(billsBatch, primaryCollection);
          typesenseOk += r.success;
          typesenseFail += r.failed;
          billsBatch.length = 0;
        }

        log(`--- Finished ${idxLabel}: ${billId} ---`);
      }

      offset += pageSize;
    }
  }

  // Final flush
  if (billsBatch.length) {
    const r = await typesenseImportUpsert(billsBatch, primaryCollection);
    typesenseOk += r.success;
    typesenseFail += r.failed;
    billsBatch.length = 0;
  }
  if (chunksBatch.length) {
    const r = await typesenseImportUpsert(chunksBatch, chunksCollection);
    chunksOk += r.success;
    chunksFail += r.failed;
    chunksBatch.length = 0;
  }

  // meta
  state.meta.last_run_utc = new Date().toISOString();
  if (newestUpdateSeenThisRun) state.meta.max_update_date_seen = newestUpdateSeenThisRun;

  saveState(state);

  log("=== Crawl complete ===");
  log("Bills processed:", processed);
  log("Typesense bills ok:", typesenseOk, "failed:", typesenseFail);
  log("Typesense chunks ok:", chunksOk, "failed:", chunksFail);
  log("New max_update_date_seen:", state.meta.max_update_date_seen);
  log("Total duration:", fmtMs(Date.now() - startAll));
}

main().catch((e) => {
  errlog("Crawler failed:", String(e?.message || e));
  if (e?.stack) errlog(e.stack);
  process.exit(1);
});
