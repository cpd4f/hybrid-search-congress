/**
 * scripts/crawl_congress.js
 *
 * Crawl latest bills from Congress.gov API, enrich with committees + summaries,
 * generate AI summary + embeddings, and upsert into Typesense.
 *
 * KEY FEATURES (per your request)
 * - Fixes OpenAI embeddings call to ALWAYS use POST (prevents “Only POST requests are accepted.”)
 * - Fixes Typesense import URL parsing by normalizing TYPESENSE_HOST and using URL()
 * - Adds “fix tracker” behavior:
 *     If index mode includes "fix_tracking" (or FIX_TRACKING=true),
 *     the script will FIRST find ALL Typesense docs missing embeddings and process those ALL,
 *     THEN it will proceed with the normal “new/updated” pass (LIMIT_PER_RUN applies to that pass only).
 *
 * ENV VARS REQUIRED
 * - CONGRESS_API_KEY
 * - TYPESENSE_HOST            e.g. https://abc.a1.typesense.net  (or abc.a1.typesense.net)
 * - TYPESENSE_API_KEY
 * - TYPESENSE_COLLECTION      e.g. bills_119
 * - OPENAI_API_KEY            (if AI summary/embeddings enabled)
 *
 * OPTIONAL
 * - CONGRESS_NUMBER=119
 * - LIMIT_PER_RUN=25
 * - CONGRESS_PAGE_SIZE=100
 * - TYPESENSE_BATCH_SIZE=10
 * - OPENAI_SUMMARY_MODEL=gpt-4o-mini
 * - OPENAI_EMBED_MODEL=text-embedding-3-large
 * - AI_SUMMARY_ENABLED=true|false
 * - EMBEDDINGS_ENABLED=true|false
 * - INDEX_MODE=upsert_new_updated_fix_tracking
 * - FIX_TRACKING=true|false
 * - TRACKER_PATH=./data/congress_tracker.json
 *
 * NOTE:
 * This script assumes your Typesense docs store embedding in `embedding` (float[]),
 * and also stores `hasEmbedding` boolean (we set it on write).
 * If your existing schema doesn’t have hasEmbedding, we fallback to scanning via /documents/export.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const LOG_PREFIX = () => `[${new Date().toISOString()}]`;

function log(...args) {
  console.log(LOG_PREFIX(), ...args);
}
function warn(...args) {
  console.warn(LOG_PREFIX(), ...args);
}
function err(...args) {
  console.error(LOG_PREFIX(), ...args);
}

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required env var: ${name}`);
  return String(v).trim();
}

function getEnv(name, fallback) {
  const v = process.env[name];
  return v == null || String(v).trim() === "" ? fallback : String(v).trim();
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(filePath, fallbackObj) {
  try {
    if (!fs.existsSync(filePath)) return fallbackObj;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    warn(`Failed to read JSON at ${filePath}, using fallback.`, e?.message || e);
    return fallbackObj;
  }
}

function writeJsonSafe(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function normalizeTypesenseHost(host) {
  // Fixes "Failed to parse URL" when host is missing protocol or has trailing slash.
  let h = String(host || "").trim();
  if (!h) throw new Error("TYPESENSE_HOST is empty");
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  h = h.replace(/\/+$/, "");
  return h;
}

async function fetchJson(url, options = {}, label = "") {
  const started = Date.now();
  const res = await fetch(url, options);
  const ms = Date.now() - started;

  const tag = label ? ` ${label}` : "";
  log(`HTTP ${res.status}${tag} ${ms}ms ${redactSecrets(url.toString())}`);

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status}${tag}: ${text.slice(0, 2000)}`
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse JSON${tag}: ${text.slice(0, 2000)}`);
  }
}

function redactSecrets(s) {
  // crude redaction for logs
  return s.replace(/api_key=[^&]+/gi, "api_key=***");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------
   OPENAI (POST-ONLY)
------------------------------ */

async function openaiSummarize({ apiKey, model, text, billId }) {
  // Using Chat Completions format for broad compatibility; always POST.
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You write concise, factual summaries of U.S. bills. Use plain English. Avoid hype. If info is missing, say so."
      },
      {
        role: "user",
        content:
          `Summarize this bill in 2-4 sentences. If there is an official summary present, use it. Otherwise infer from title and available details.\n\n` +
          `BILL_ID: ${billId}\n\n` +
          text
      }
    ],
    temperature: 0.2
  };

  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const ms = Date.now() - started;

  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`OpenAI summary failed (${res.status}): ${raw.slice(0, 2000)}`);
  }

  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content ?? "";
  log(`OpenAI summary ${billId} ok ${ms}ms`);
  return String(out).trim();
}

async function openaiEmbed({ apiKey, model, input, billId }) {
  // THIS is the critical fix: embeddings endpoint must be POST, never GET.
  const url = "https://api.openai.com/v1/embeddings";
  const body = { model, input };

  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const ms = Date.now() - started;

  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`OpenAI embeddings failed (${res.status}): ${raw.slice(0, 2000)}`);
  }

  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length < 10) {
    throw new Error(`OpenAI embeddings returned invalid vector for ${billId}`);
  }

  log(`OpenAI embed(bill) ${billId} ok ${ms}ms (dim=${vec.length})`);
  return vec;
}

/* ------------------------------
   CONGRESS.GOV API
------------------------------ */

async function congressListBills({ apiKey, congress, offset, limit }) {
  const url = new URL(`https://api.congress.gov/v3/bill/${congress}`);
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "updateDate desc");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("api_key", apiKey);

  return fetchJson(url, {}, "LIST");
}

async function congressBillDetail({ apiKey, congress, billType, billNumber }) {
  const url = new URL(`https://api.congress.gov/v3/bill/${congress}/${billType}/${billNumber}`);
  url.searchParams.set("format", "json");
  url.searchParams.set("api_key", apiKey);

  return fetchJson(url, {}, "DETAIL");
}

async function congressBillCommittees({ apiKey, congress, billType, billNumber }) {
  const url = new URL(
    `https://api.congress.gov/v3/bill/${congress}/${billType}/${billNumber}/committees`
  );
  url.searchParams.set("format", "json");
  url.searchParams.set("api_key", apiKey);

  return fetchJson(url, {}, "COMMITTEES");
}

async function congressBillSummaries({ apiKey, congress, billType, billNumber }) {
  const url = new URL(
    `https://api.congress.gov/v3/bill/${congress}/${billType}/${billNumber}/summaries`
  );
  url.searchParams.set("format", "json");
  url.searchParams.set("api_key", apiKey);

  return fetchJson(url, {}, "SUMMARIES");
}

/* ------------------------------
   TYPESENSE
------------------------------ */

function typesenseHeaders(apiKey) {
  return {
    "X-TYPESENSE-API-KEY": apiKey,
    "Content-Type": "application/json"
  };
}

async function typesenseImport({ host, apiKey, collection, docs, action = "upsert" }) {
  // Use URL() to guarantee correct parsing and avoid the “Failed to parse URL” crash.
  const url = new URL(`${normalizeTypesenseHost(host)}/collections/${collection}/documents/import`);
  url.searchParams.set("action", action);

  const body = docs.map((d) => JSON.stringify(d)).join("\n");

  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-TYPESENSE-API-KEY": apiKey,
      "Content-Type": "text/plain"
    },
    body
  });
  const ms = Date.now() - started;

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Typesense import failed (${res.status}) ${ms}ms: ${text.slice(0, 2000)}`);
  }

  // The response is newline JSON objects; we’ll do minimal sanity check.
  const lines = text.trim().split("\n").filter(Boolean);
  const failures = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj?.success === false) failures.push(obj);
    } catch {
      // ignore parse failures, but log them
    }
  }
  log(`Typesense import ok ${ms}ms docs=${docs.length} failures=${failures.length}`);
  if (failures.length) {
    warn("Typesense import failures sample:", failures.slice(0, 3));
  }
}

async function typesenseSearchMissingEmbeddingsFast({ host, apiKey, collection }) {
  // Fast path: requires schema field `hasEmbedding` boolean
  const url = new URL(`${normalizeTypesenseHost(host)}/collections/${collection}/documents/search`);
  url.searchParams.set("q", "*");
  // NOTE: query_by must reference a searchable string field. Adjust if needed.
  // If your schema has `bill_id` set as a string field with index=true, use it.
  url.searchParams.set("query_by", "bill_id");
  url.searchParams.set("filter_by", "hasEmbedding:false");
  url.searchParams.set("per_page", "250");
  url.searchParams.set("page", "1");

  const out = [];
  let page = 1;

  while (true) {
    url.searchParams.set("page", String(page));
    const data = await fetchJson(url, { headers: typesenseHeaders(apiKey) }, "TS_SEARCH");
    const hits = data?.hits || [];
    for (const h of hits) {
      const doc = h?.document;
      if (doc?.bill_id) out.push(String(doc.bill_id));
    }
    const found = Number(data?.found ?? 0);
    const perPage = Number(data?.request_params?.per_page ?? 250);
    const have = out.length;
    if (have >= found) break;
    if (hits.length < perPage) break;
    page += 1;
    // small delay to be kind
    await sleep(50);
  }

  return out;
}

async function typesenseExportScanMissingEmbeddings({ host, apiKey, collection }) {
  // Fallback: stream export + scan locally for missing embedding or hasEmbedding=false
  const url = new URL(`${normalizeTypesenseHost(host)}/collections/${collection}/documents/export`);
  // No filter here because we don’t know schema; we’ll scan all.
  const started = Date.now();
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-TYPESENSE-API-KEY": apiKey }
  });
  const ms = Date.now() - started;

  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`Typesense export failed (${res.status}) ${ms}ms: ${raw.slice(0, 2000)}`);
  }

  const text = await res.text();
  const lines = text.split("\n").filter(Boolean);

  const missing = [];
  for (const line of lines) {
    try {
      const doc = JSON.parse(line);
      const hasEmbeddingField =
        Array.isArray(doc?.embedding) && doc.embedding.length > 10;
      const hasEmbeddingFlag =
        doc?.hasEmbedding === true;

      if (!hasEmbeddingField || !hasEmbeddingFlag) {
        if (doc?.bill_id) missing.push(String(doc.bill_id));
      }
    } catch {
      // ignore
    }
  }

  log(`Typesense export scan complete ${ms}ms lines=${lines.length} missing=${missing.length}`);
  return missing;
}

async function getMissingEmbeddingBillIds({ host, apiKey, collection }) {
  // Try fast filter first; if schema doesn’t support it, fallback to export scan.
  try {
    const ids = await typesenseSearchMissingEmbeddingsFast({ host, apiKey, collection });
    log(`Missing embeddings (fast filter): ${ids.length}`);
    return ids;
  } catch (e) {
    warn(`Fast missing-embedding query failed; falling back to export scan. Reason: ${e?.message || e}`);
    const ids = await typesenseExportScanMissingEmbeddings({ host, apiKey, collection });
    log(`Missing embeddings (export scan): ${ids.length}`);
    return ids;
  }
}

/* ------------------------------
   BILL NORMALIZATION
------------------------------ */

function buildBillId(congress, billType, billNumber) {
  return `${congress}-${billType}-${billNumber}`;
}

function pickBestCongressSummary(summariesJson) {
  // Congress.gov summaries response often has `summaries` array with `text` and `actionDate` / `updateDate`.
  const arr =
    summariesJson?.summaries ||
    summariesJson?.billSummaries ||
    summariesJson?.summaries?.summaries ||
    [];

  if (!Array.isArray(arr) || arr.length === 0) return "";

  // Prefer latest by updateDate if present
  const sorted = [...arr].sort((a, b) => {
    const da = Date.parse(a?.updateDate || a?.actionDate || a?.date || "") || 0;
    const db = Date.parse(b?.updateDate || b?.actionDate || b?.date || "") || 0;
    return db - da;
  });

  const text = sorted[0]?.text || sorted[0]?.summaryText || "";
  return String(text || "").replace(/\s+/g, " ").trim();
}

function extractCommittees(committeesJson) {
  const arr =
    committeesJson?.committees ||
    committeesJson?.billCommittees ||
    committeesJson?.committees?.committees ||
    [];

  if (!Array.isArray(arr)) return [];

  const names = [];
  for (const c of arr) {
    const n = c?.name || c?.committeeName;
    if (n) names.push(String(n).trim());
  }
  return Array.from(new Set(names));
}

function safeDateString(d) {
  if (!d) return "";
  const t = Date.parse(d);
  if (Number.isNaN(t)) return "";
  return new Date(t).toISOString();
}

function buildEmbeddingText({ title, congressSummary, committees }) {
  const parts = [];
  if (title) parts.push(`Title: ${title}`);
  if (committees?.length) parts.push(`Committees: ${committees.join("; ")}`);
  if (congressSummary) parts.push(`Official summary: ${congressSummary}`);
  return parts.join("\n\n").trim();
}

/* ------------------------------
   MAIN
------------------------------ */

async function main() {
  const CONGRESS_API_KEY = mustGetEnv("CONGRESS_API_KEY");
  const TYPESENSE_HOST = normalizeTypesenseHost(mustGetEnv("TYPESENSE_HOST"));
  const TYPESENSE_API_KEY = mustGetEnv("TYPESENSE_API_KEY");
  const TYPESENSE_COLLECTION = mustGetEnv("TYPESENSE_COLLECTION");

  const CONGRESS_NUMBER = Number(getEnv("CONGRESS_NUMBER", "119"));
  const LIMIT_PER_RUN = Number(getEnv("LIMIT_PER_RUN", "25"));
  const CONGRESS_PAGE_SIZE = Number(getEnv("CONGRESS_PAGE_SIZE", "100"));
  const TYPESENSE_BATCH_SIZE = Number(getEnv("TYPESENSE_BATCH_SIZE", "10"));

  const OPENAI_API_KEY = getEnv("OPENAI_API_KEY", "");
  const OPENAI_SUMMARY_MODEL = getEnv("OPENAI_SUMMARY_MODEL", "gpt-4o-mini");
  const OPENAI_EMBED_MODEL = getEnv("OPENAI_EMBED_MODEL", "text-embedding-3-large");

  const AI_SUMMARY_ENABLED = toBool(getEnv("AI_SUMMARY_ENABLED", "true"), true);
  const EMBEDDINGS_ENABLED = toBool(getEnv("EMBEDDINGS_ENABLED", "true"), true);

  const INDEX_MODE = getEnv("INDEX_MODE", "upsert_new_updated_fix_tracking");

  const FIX_TRACKING =
    toBool(getEnv("FIX_TRACKING", ""), false) ||
    INDEX_MODE.toLowerCase().includes("fix_tracking");

  const TRACKER_PATH = getEnv("TRACKER_PATH", "./data/congress_tracker.json");

  log("=== Crawl start ===");
  log("Index mode:", INDEX_MODE);
  log("Congress:", CONGRESS_NUMBER);
  log("LIMIT_PER_RUN:", LIMIT_PER_RUN);
  log("OpenAI summary model:", OPENAI_SUMMARY_MODEL);
  log("OpenAI embed model:", OPENAI_EMBED_MODEL);
  log("Typesense batch size:", TYPESENSE_BATCH_SIZE);
  log("Congress page size:", CONGRESS_PAGE_SIZE);
  log("AI summary enabled:", AI_SUMMARY_ENABLED);
  log("Embeddings enabled:", EMBEDDINGS_ENABLED);
  log("Fix tracking enabled:", FIX_TRACKING);

  const tracker = readJsonSafe(TRACKER_PATH, {
    max_update_date_seen: null,
    last_run_at: null
  });

  log("Prev max_update_date_seen:", tracker.max_update_date_seen || "(none)");

  if ((AI_SUMMARY_ENABLED || EMBEDDINGS_ENABLED) && !OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when AI_SUMMARY_ENABLED or EMBEDDINGS_ENABLED is true.");
  }

  // --------- PHASE 1: Fix missing embeddings (process ALL) ----------
  const alreadyQueued = new Set();
  const workQueue = []; // items: { bill_id, billType, billNumber }

  if (FIX_TRACKING && EMBEDDINGS_ENABLED) {
    log("Fix-tracking phase: querying Typesense for missing embeddings…");
    const missingIds = await getMissingEmbeddingBillIds({
      host: TYPESENSE_HOST,
      apiKey: TYPESENSE_API_KEY,
      collection: TYPESENSE_COLLECTION
    });

    for (const billId of missingIds) {
      alreadyQueued.add(billId);

      // billId format must be `${congress}-${billType}-${billNumber}`
      const m = /^(\d+)-([a-z]+)-(\d+)$/i.exec(billId);
      if (!m) continue;
      const congress = Number(m[1]);
      const billType = String(m[2]).toLowerCase();
      const billNumber = String(m[3]);

      if (congress !== CONGRESS_NUMBER) continue; // only fix current congress in this run
      workQueue.push({ bill_id: billId, billType, billNumber, reason: "missing_embedding" });
    }

    log(`Fix-tracking queue: ${workQueue.length} bills (will process ALL).`);
  }

  // --------- PHASE 2: Normal “new/updated” run (LIMIT_PER_RUN) ----------
  // We always pull newest updateDate and process until LIMIT_PER_RUN,
  // skipping any already in workQueue.
  const normalQueue = [];
  let offset = 0;

  // Determine threshold date (max_update_date_seen) for “new/updated”
  const prevMax = tracker.max_update_date_seen ? Date.parse(tracker.max_update_date_seen) : null;

  while (normalQueue.length < LIMIT_PER_RUN) {
    log(`Fetching list congress=${CONGRESS_NUMBER} offset=${offset} limit=${CONGRESS_PAGE_SIZE}`);
    const list = await congressListBills({
      apiKey: CONGRESS_API_KEY,
      congress: CONGRESS_NUMBER,
      offset,
      limit: CONGRESS_PAGE_SIZE
    });

    const bills = list?.bills || list?.results || [];
    if (!Array.isArray(bills) || bills.length === 0) break;

    for (const b of bills) {
      const billType = String(b?.type || b?.billType || "").toLowerCase();
      const billNumber = String(b?.number || b?.billNumber || "");
      if (!billType || !billNumber) continue;

      const billId = buildBillId(CONGRESS_NUMBER, billType, billNumber);
      if (alreadyQueued.has(billId)) continue; // already in fix queue

      const apiUpdate = b?.updateDate || b?.latestAction?.actionDate || b?.updateDateIncludingText || "";
      const apiUpdateMs = Date.parse(apiUpdate);
      // If we have prevMax and this item is older/equal, we can stop early (list is desc)
      if (prevMax && apiUpdateMs && apiUpdateMs <= prevMax) {
        // stop scanning entirely
        offset = Infinity;
        break;
      }

      normalQueue.push({ bill_id: billId, billType, billNumber, reason: "new_or_updated", apiUpdate });
      if (normalQueue.length >= LIMIT_PER_RUN) break;
    }

    if (offset === Infinity) break;

    offset += CONGRESS_PAGE_SIZE;
    // if we exhausted list
    if (bills.length < CONGRESS_PAGE_SIZE) break;
  }

  // Combine queues: fix ALL first, then normal
  const fullQueue = [...workQueue, ...normalQueue];

  // Track new max update date from the normal list pass (not from fix items)
  let maxSeenThisRun = tracker.max_update_date_seen ? Date.parse(tracker.max_update_date_seen) : 0;
  for (const it of normalQueue) {
    const ms = Date.parse(it.apiUpdate || "");
    if (ms && ms > maxSeenThisRun) maxSeenThisRun = ms;
  }

  if (fullQueue.length === 0) {
    log("No work items found. Exiting.");
    tracker.last_run_at = new Date().toISOString();
    writeJsonSafe(TRACKER_PATH, tracker);
    return;
  }

  // --------- PROCESS LOOP ----------
  const docsToUpsert = [];
  let processed = 0;

  for (let i = 0; i < fullQueue.length; i++) {
    const item = fullQueue[i];
    processed += 1;

    log(`--- Processing ${processed}/${fullQueue.length}: ${item.bill_id} (${item.reason}${item.apiUpdate ? ` api_update=${item.apiUpdate}` : ""}) ---`);

    const billType = item.billType;
    const billNumber = item.billNumber;

    // Pull details
    const detail = await congressBillDetail({
      apiKey: CONGRESS_API_KEY,
      congress: CONGRESS_NUMBER,
      billType,
      billNumber
    });

    const committeesJson = await congressBillCommittees({
      apiKey: CONGRESS_API_KEY,
      congress: CONGRESS_NUMBER,
      billType,
      billNumber
    });

    const summariesJson = await congressBillSummaries({
      apiKey: CONGRESS_API_KEY,
      congress: CONGRESS_NUMBER,
      billType,
      billNumber
    });

    const bill = detail?.bill || detail?.results?.[0] || detail?.billDetail || {};
    const title =
      bill?.title ||
      bill?.shortTitle ||
      bill?.officialTitle ||
      "";

    const congressSummary = pickBestCongressSummary(summariesJson);
    const committees = extractCommittees(committeesJson);

    // AI summary
    let aiSummary = "";
    if (AI_SUMMARY_ENABLED) {
      try {
        const sourceText = [
          title ? `TITLE: ${title}` : "",
          congressSummary ? `CONGRESS SUMMARY: ${congressSummary}` : "",
          committees.length ? `COMMITTEES: ${committees.join("; ")}` : ""
        ]
          .filter(Boolean)
          .join("\n\n");

        aiSummary = await openaiSummarize({
          apiKey: OPENAI_API_KEY,
          model: OPENAI_SUMMARY_MODEL,
          text: sourceText,
          billId: item.bill_id
        });

        log(`AI summary length: ${aiSummary.length} chars`);
      } catch (e) {
        warn(`OpenAI summary ${item.bill_id} failed:`, e?.message || e);
      }
    }

    // Embedding
    let embedding = null;
    let hasEmbedding = false;
    if (EMBEDDINGS_ENABLED) {
      try {
        const embText = buildEmbeddingText({
          title,
          congressSummary,
          committees
        });

        // If embText empty, still embed something stable (bill id + title)
        const input = embText || `Bill ${item.bill_id}: ${title || "No title available"}`;

        embedding = await openaiEmbed({
          apiKey: OPENAI_API_KEY,
          model: OPENAI_EMBED_MODEL,
          input,
          billId: item.bill_id
        });

        hasEmbedding = true;
      } catch (e) {
        warn(`OpenAI embed(bill) ${item.bill_id} failed:`, e?.message || e);
        embedding = null;
        hasEmbedding = false;
      }
    }

    // Normalize date fields
    const updateDate =
      safeDateString(bill?.updateDate) ||
      safeDateString(bill?.updateDateIncludingText) ||
      safeDateString(item.apiUpdate) ||
      "";

    const introducedDate =
      safeDateString(bill?.introducedDate) ||
      "";

    // Build Typesense doc
    const doc = {
      // Primary id for Typesense
      id: item.bill_id,

      // Search fields
      bill_id: item.bill_id,
      congress: CONGRESS_NUMBER,
      bill_type: billType,
      bill_number: Number(billNumber),

      title: String(title || "").trim(),
      congress_summary: congressSummary,
      committees,

      ai_summary: aiSummary,

      update_date: updateDate,
      introduced_date: introducedDate,

      // Vector + tracking
      embedding: embedding,          // float[]
      hasEmbedding: hasEmbedding,    // boolean

      // meta
      source: "congress.gov",
      indexed_at: new Date().toISOString()
    };

    docsToUpsert.push(doc);

    // Batch upsert
    if (docsToUpsert.length >= TYPESENSE_BATCH_SIZE) {
      await typesenseImport({
        host: TYPESENSE_HOST,
        apiKey: TYPESENSE_API_KEY,
        collection: TYPESENSE_COLLECTION,
        docs: docsToUpsert.splice(0, docsToUpsert.length),
        action: "upsert"
      });
    }

    log(`--- Finished ${processed}/${fullQueue.length}: ${item.bill_id} ---`);
  }

  // Flush remaining
  if (docsToUpsert.length) {
    await typesenseImport({
      host: TYPESENSE_HOST,
      apiKey: TYPESENSE_API_KEY,
      collection: TYPESENSE_COLLECTION,
      docs: docsToUpsert,
      action: "upsert"
    });
  }

  // Update tracker:
  // - If we did normalQueue and found newer updateDate, advance max_update_date_seen
  if (maxSeenThisRun && maxSeenThisRun > 0) {
    tracker.max_update_date_seen = new Date(maxSeenThisRun).toISOString();
  }
  tracker.last_run_at = new Date().toISOString();

  writeJsonSafe(TRACKER_PATH, tracker);

  log("=== Crawl complete ===");
  log("New max_update_date_seen:", tracker.max_update_date_seen || "(none)");
}

main().catch((e) => {
  err("Crawler failed:", e?.message || e);
  process.exit(1);
});
