/**
 * scripts/crawl_congress.js
 *
 * Drop-in, single-file crawler for Congress.gov bills → Typesense.
 * - NO chunk collection / NO chunking functionality (removed)
 * - Robust Typesense URL builder (fixes: "Failed to parse URL from ...documents/import?action=upsert")
 * - Defensive env parsing + clearer logs
 * - Upserts in batches via Typesense /documents/import?action=upsert
 *
 * Required env:
 *   CONGRESS_API_KEY=...
 *   TYPESENSE_API_KEY=...
 *   TYPESENSE_COLLECTION=bills_main   (or whatever your main collection name is)
 *
 * Typesense host env (choose ONE approach):
 *   A) TYPESENSE_URL=https://xxxx.a1.typesense.net
 *   B) TYPESENSE_HOST=xxxx.a1.typesense.net   (optionally TYPESENSE_PORT=443 or 8108)
 *
 * Optional env:
 *   CONGRESS=119
 *   LIMIT_PER_RUN=25
 *   CONGRESS_PAGE_SIZE=100
 *   TYPESENSE_BATCH_SIZE=10
 *   INDEX_MODE=upsert_new_updated_fix_tracking
 *
 *   OPENAI_API_KEY=...
 *   AI_SUMMARY_ENABLED=true|false
 *   EMBEDDINGS_ENABLED=true|false
 *   OPENAI_SUMMARY_MODEL=gpt-4o-mini
 *   OPENAI_EMBED_MODEL=text-embedding-3-large
 *
 * Tracking:
 *   Writes .data/congress_crawl_state.json with max_update_date_seen + per-run info.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const STATE_DIR = path.resolve(process.cwd(), ".data");
const STATE_FILE = path.join(STATE_DIR, "congress_crawl_state.json");

function ts() {
  return new Date().toISOString();
}
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}
function warn(...args) {
  console.warn(`[${ts()}]`, ...args);
}
function die(msg) {
  throw new Error(msg);
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");
}

function envBool(name, fallback = false) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(v);
}

function envInt(name, fallback) {
  const v = String(process.env[name] ?? "").trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ----------------------------
   Typesense URL (FIX)
----------------------------- */

function getTypesenseBaseUrl() {
  const direct = process.env.TYPESENSE_URL || process.env.TYPESENSE_HOST;
  if (!direct) die("Missing TYPESENSE_URL or TYPESENSE_HOST env var.");

  let raw = String(direct).trim();

  // Default scheme
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  // Remove trailing slashes
  raw = raw.replace(/\/+$/, "");

  const port = String(process.env.TYPESENSE_PORT || "").trim();
  if (port) {
    // If raw already ends in :digits, don't add another port
    if (!/:\d+$/.test(raw)) raw = `${raw}:${port}`;
  }

  // Validate URL
  const u = new URL(raw);
  return u.toString().replace(/\/+$/, "");
}

function typesenseUrl(p) {
  const base = getTypesenseBaseUrl();
  return new URL(p, base).toString();
}

function typesenseImportUrl(collection, action = "upsert") {
  const u = new URL(`/collections/${encodeURIComponent(collection)}/documents/import`, getTypesenseBaseUrl());
  u.searchParams.set("action", action);
  return u.toString();
}

function typesenseHeaders() {
  const key = String(process.env.TYPESENSE_API_KEY || "").trim();
  if (!key) die("Missing TYPESENSE_API_KEY env var.");
  return {
    "X-TYPESENSE-API-KEY": key,
  };
}

/* ----------------------------
   Fetch helpers
----------------------------- */

async function fetchJson(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // leave null
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

/* ----------------------------
   Congress.gov API
----------------------------- */

function congressKey() {
  const k = String(process.env.CONGRESS_API_KEY || "").trim();
  if (!k) die("Missing CONGRESS_API_KEY env var.");
  return k;
}

function congressListUrl({ congress, offset, limit }) {
  const u = new URL(`https://api.congress.gov/v3/bill/${congress}`);
  u.searchParams.set("format", "json");
  u.searchParams.set("sort", "updateDate desc");
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("offset", String(offset));
  u.searchParams.set("api_key", congressKey());
  return u.toString();
}

function congressDetailUrl({ congress, billType, billNumber }) {
  const u = new URL(`https://api.congress.gov/v3/bill/${congress}/${billType}/${billNumber}`);
  u.searchParams.set("format", "json");
  u.searchParams.set("api_key", congressKey());
  return u.toString();
}

function congressCommitteesUrl({ congress, billType, billNumber }) {
  const u = new URL(`https://api.congress.gov/v3/bill/${congress}/${billType}/${billNumber}/committees`);
  u.searchParams.set("format", "json");
  u.searchParams.set("api_key", congressKey());
  return u.toString();
}

function congressSummariesUrl({ congress, billType, billNumber }) {
  const u = new URL(`https://api.congress.gov/v3/bill/${congress}/${billType}/${billNumber}/summaries`);
  u.searchParams.set("format", "json");
  u.searchParams.set("api_key", congressKey());
  return u.toString();
}

/* ----------------------------
   OpenAI (summary + embeddings)
   NOTE: bill text/chunks NOT used here at all.
----------------------------- */

function openaiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

async function openaiChatSummary({ model, prompt }) {
  const key = openaiKey();
  if (!key) die("AI summary enabled but OPENAI_API_KEY is missing.");

  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You write concise, plain-English bill summaries for a general audience." },
      { role: "user", content: prompt },
    ],
  };

  const t0 = Date.now();
  const res = await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 60000,
    // @ts-ignore
    body: JSON.stringify(body),
    // @ts-ignore
    method: "POST",
  });

  if (!res.ok) {
    const msg = res.text?.slice(0, 500) || `HTTP ${res.status}`;
    throw new Error(`OpenAI chat failed: ${msg}`);
  }

  const out = res.json;
  const content = out?.choices?.[0]?.message?.content?.trim() || "";
  return { content, ms: Date.now() - t0 };
}

async function openaiEmbed({ model, input }) {
  const key = openaiKey();
  if (!key) die("Embeddings enabled but OPENAI_API_KEY is missing.");

  const url = "https://api.openai.com/v1/embeddings";
  const body = { model, input };

  const t0 = Date.now();
  const res = await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 60000,
    // @ts-ignore
    body: JSON.stringify(body),
    // @ts-ignore
    method: "POST",
  });

  if (!res.ok) {
    const msg = res.text?.slice(0, 500) || `HTTP ${res.status}`;
    throw new Error(`OpenAI embeddings failed: ${msg}`);
  }

  const emb = res.json?.data?.[0]?.embedding;
  if (!Array.isArray(emb)) throw new Error("OpenAI embeddings returned no embedding array.");
  return { embedding: emb, dim: emb.length, ms: Date.now() - t0 };
}

/* ----------------------------
   Typesense schema + import
----------------------------- */

function billSchemaForMain(collectionName) {
  return {
    name: collectionName,
    fields: [
      { name: "id", type: "string" },

      // searchable strings
      { name: "title", type: "string", optional: true },
      { name: "shortTitle", type: "string", optional: true },
      { name: "officialTitle", type: "string", optional: true },
      { name: "summary", type: "string", optional: true },      // Congress.gov summaries
      { name: "aiSummary", type: "string", optional: true },    // OpenAI summary

      // structured
      { name: "congress", type: "int32", optional: true },
      { name: "billType", type: "string", optional: true },
      { name: "billNumber", type: "int32", optional: true },
      { name: "billTypeLabel", type: "string", optional: true },
      { name: "introducedDate", type: "string", optional: true },
      { name: "updateDate", type: "string", optional: true },

      { name: "sponsors", type: "string[]", optional: true },
      { name: "committees", type: "string[]", optional: true },
      { name: "latestAction", type: "string", optional: true },
      { name: "latestActionDate", type: "string", optional: true },

      { name: "url", type: "string", optional: true },

      // vector
      { name: "embedding", type: "float[]", optional: true },
    ],
    default_sorting_field: "billNumber",
  };
}

async function ensureTypesenseCollection(collectionName) {
  const schema = billSchemaForMain(collectionName);
  const getUrl = typesenseUrl(`/collections/${encodeURIComponent(collectionName)}`);

  const g = await fetchJson(getUrl, { headers: typesenseHeaders(), timeoutMs: 30000 });
  if (g.ok) return;

  // Create
  const createUrl = typesenseUrl("/collections");
  const c = await fetchJson(createUrl, {
    headers: { ...typesenseHeaders(), "Content-Type": "application/json" },
    timeoutMs: 30000,
    // @ts-ignore
    method: "POST",
    // @ts-ignore
    body: JSON.stringify(schema),
  });

  if (!c.ok) {
    const msg = c.text?.slice(0, 800) || `HTTP ${c.status}`;
    throw new Error(`Failed to create Typesense collection: ${msg}`);
  }
}

async function typesenseImportDocs({ collection, docs, action = "upsert" }) {
  if (!docs.length) return { success: 0, failed: 0 };

  const url = typesenseImportUrl(collection, action);

  // IMPORTANT debug: so if URL parsing ever breaks again, you’ll see the exact string.
  log("Typesense import URL:", url);

  const payload = docs.map((d) => JSON.stringify(d)).join("\n");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...typesenseHeaders(),
      "Content-Type": "text/plain",
    },
    body: payload,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Typesense import failed HTTP ${res.status}: ${text.slice(0, 1200)}`);
  }

  // Each line is a JSON status per doc
  let success = 0;
  let failed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.success) success += 1;
      else failed += 1;
    } catch {
      // If Typesense returns something unexpected, count as failed
      failed += 1;
    }
  }

  return { success, failed };
}

/* ----------------------------
   Mapping
----------------------------- */

function pickBestSummary(congressSummariesJson) {
  // Congress API summaries endpoint shape can vary; we try common patterns.
  const summaries =
    congressSummariesJson?.summaries ||
    congressSummariesJson?.summary ||
    congressSummariesJson?.billSummaries ||
    [];

  const arr = Array.isArray(summaries) ? summaries : (summaries?.items || summaries?.summaries || []);
  if (!Array.isArray(arr) || !arr.length) return "";

  // Prefer the latest updated summary if available
  const sorted = [...arr].sort((a, b) => {
    const ad = Date.parse(a?.updateDate || a?.updatedAt || a?.date || "") || 0;
    const bd = Date.parse(b?.updateDate || b?.updatedAt || b?.date || "") || 0;
    return bd - ad;
  });

  const s = sorted[0];
  return String(s?.text || s?.summaryText || s?.content || "").trim();
}

function normalizeBillDoc({ billId, congress, billType, billNumber, detailJson, committeesJson, summariesJson }) {
  const b = detailJson?.bill || detailJson?.data?.bill || detailJson?.billDetail || detailJson?.bill;

  // Sponsors list
  const sponsors = [];
  const sponsorObj = b?.sponsor;
  if (sponsorObj?.name) sponsors.push(String(sponsorObj.name));
  const cos = b?.cosponsors;
  const cosArr = Array.isArray(cos) ? cos : (cos?.items || []);
  if (Array.isArray(cosArr)) {
    for (const c of cosArr) {
      if (c?.name) sponsors.push(String(c.name));
    }
  }

  // Committees
  const committees = [];
  const commArr = committeesJson?.committees || committeesJson?.committee || committeesJson?.items || [];
  const commItems = Array.isArray(commArr) ? commArr : (commArr?.items || []);
  if (Array.isArray(commItems)) {
    for (const c of commItems) {
      const name = c?.name || c?.committeeName || c?.committee?.name;
      if (name) committees.push(String(name));
    }
  }

  const summary = pickBestSummary(summariesJson);

  const latestAction = b?.latestAction?.text || b?.latestAction?.actionText || "";
  const latestActionDate = b?.latestAction?.actionDate || b?.latestAction?.date || "";

  const url = b?.url || b?.congressdotgovUrl || b?.websiteUrl || "";

  return {
    id: billId,
    title: b?.title || "",
    shortTitle: b?.shortTitle || "",
    officialTitle: b?.officialTitle || "",
    summary: summary || "",

    congress: Number(congress) || undefined,
    billType: String(billType || ""),
    billNumber: Number(billNumber) || undefined,
    billTypeLabel: b?.type || b?.billType || "",

    introducedDate: b?.introducedDate || "",
    updateDate: b?.updateDate || b?.latestAction?.actionDate || "",

    sponsors: sponsors.length ? sponsors : undefined,
    committees: committees.length ? committees : undefined,

    latestAction: latestAction ? String(latestAction) : undefined,
    latestActionDate: latestActionDate ? String(latestActionDate) : undefined,

    url: url ? String(url) : undefined,
  };
}

function buildAiSummaryPrompt(doc) {
  const parts = [];
  if (doc.title) parts.push(`Title: ${doc.title}`);
  if (doc.shortTitle && doc.shortTitle !== doc.title) parts.push(`Short title: ${doc.shortTitle}`);
  if (doc.officialTitle && doc.officialTitle !== doc.title) parts.push(`Official title: ${doc.officialTitle}`);
  if (doc.summary) parts.push(`Congress.gov summary: ${doc.summary}`);
  if (doc.latestAction) parts.push(`Latest action: ${doc.latestAction}${doc.latestActionDate ? ` (${doc.latestActionDate})` : ""}`);

  return `
Write a concise summary (2-4 sentences) of this U.S. bill in plain English.
Avoid jargon. Do not speculate. If information is missing, keep it generic.

${parts.join("\n")}
`.trim();
}

function buildEmbeddingText(doc) {
  // IMPORTANT: bill text (full text / chunks) is NOT used.
  // Embedding uses title + official/short title + congress summary + ai summary (if present).
  const lines = [];
  if (doc.title) lines.push(doc.title);
  if (doc.shortTitle) lines.push(doc.shortTitle);
  if (doc.officialTitle) lines.push(doc.officialTitle);
  if (doc.summary) lines.push(doc.summary);
  if (doc.aiSummary) lines.push(doc.aiSummary);
  return lines.join("\n\n").trim();
}

/* ----------------------------
   Main
----------------------------- */

async function main() {
  const INDEX_MODE = String(process.env.INDEX_MODE || "upsert_new_updated_fix_tracking").trim();
  const CONGRESS = envInt("CONGRESS", 119);
  const LIMIT_PER_RUN = envInt("LIMIT_PER_RUN", 25);
  const CONGRESS_PAGE_SIZE = envInt("CONGRESS_PAGE_SIZE", 100);
  const TYPESENSE_BATCH_SIZE = envInt("TYPESENSE_BATCH_SIZE", 10);

  const AI_SUMMARY_ENABLED = envBool("AI_SUMMARY_ENABLED", true);
  const EMBEDDINGS_ENABLED = envBool("EMBEDDINGS_ENABLED", true);

  const OPENAI_SUMMARY_MODEL = String(process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini").trim();
  const OPENAI_EMBED_MODEL = String(process.env.OPENAI_EMBED_MODEL || "text-embedding-3-large").trim();

  const TYPESENSE_COLLECTION = String(process.env.TYPESENSE_COLLECTION || "").trim();
  if (!TYPESENSE_COLLECTION) die("Missing TYPESENSE_COLLECTION env var (your main bills collection name).");

  const state = readJsonSafe(STATE_FILE, {
    max_update_date_seen: null,
    last_run: null,
  });

  log("=== Crawl start ===");
  log("Index mode:", INDEX_MODE);
  log("Congress:", CONGRESS);
  log("LIMIT_PER_RUN:", LIMIT_PER_RUN);
  log("OpenAI summary model:", OPENAI_SUMMARY_MODEL);
  log("OpenAI embed model:", OPENAI_EMBED_MODEL);
  log("Typesense batch size:", TYPESENSE_BATCH_SIZE);
  log("Congress page size:", CONGRESS_PAGE_SIZE);
  log("AI summary enabled:", AI_SUMMARY_ENABLED);
  log("Embeddings enabled:", EMBEDDINGS_ENABLED);
  log("Prev max_update_date_seen:", state?.max_update_date_seen ? state.max_update_date_seen : "(none)");

  // Ensure TS base URL parses early (so we fail fast with a clear error)
  const tsBase = getTypesenseBaseUrl();
  log("Typesense base URL:", tsBase);

  await ensureTypesenseCollection(TYPESENSE_COLLECTION);

  // Pull the first page (sorted by updateDate desc) and process first LIMIT_PER_RUN
  const listUrl = congressListUrl({ congress: CONGRESS, offset: 0, limit: CONGRESS_PAGE_SIZE });
  log(`Fetching list congress=${CONGRESS} offset=0 limit=${CONGRESS_PAGE_SIZE}`);

  const listT0 = Date.now();
  const listRes = await fetchJson(listUrl, { timeoutMs: 30000 });
  if (!listRes.ok) {
    throw new Error(`Congress LIST failed HTTP ${listRes.status}: ${(listRes.text || "").slice(0, 800)}`);
  }
  log(`HTTP 200 LIST ${Date.now() - listT0}ms ${listUrl.replace(/api_key=[^&]+/i, "api_key=***")}`);

  const bills = listRes.json?.bills || listRes.json?.results || listRes.json?.data?.bills || [];
  if (!Array.isArray(bills) || bills.length === 0) {
    log("No bills returned from list.");
    return;
  }

  const slice = bills.slice(0, LIMIT_PER_RUN);

  const docsToImport = [];
  let newMaxUpdate = state?.max_update_date_seen ? String(state.max_update_date_seen) : null;

  for (let i = 0; i < slice.length; i++) {
    const item = slice[i];

    const billType = String(item?.type || item?.billType || item?.billTypeAbbreviation || "").toLowerCase();
    const billNumber = Number(item?.number || item?.billNumber || item?.bill?.number);
    const apiUpdate = String(item?.updateDate || item?.latestAction?.actionDate || item?.updateDateIncludingText || "");

    if (!billType || !Number.isFinite(billNumber)) {
      warn(`Skipping list item missing billType/number at index ${i}`);
      continue;
    }

    const billId = `${CONGRESS}-${billType}-${billNumber}`;
    log(`--- Processing ${i + 1}/${slice.length}: ${billId} (api_update=${apiUpdate || "?"}) ---`);

    // Update tracking max
    if (apiUpdate) {
      if (!newMaxUpdate) newMaxUpdate = apiUpdate;
      else {
        // Keep lexicographically greatest if in YYYY-MM-DD or ISO
        if (apiUpdate > newMaxUpdate) newMaxUpdate = apiUpdate;
      }
    }

    // Detail
    const detailUrl = congressDetailUrl({ congress: CONGRESS, billType, billNumber });
    const tD = Date.now();
    const detailRes = await fetchJson(detailUrl, { timeoutMs: 30000 });
    if (!detailRes.ok) {
      warn(`HTTP ${detailRes.status} DETAIL ${detailUrl}`);
      continue;
    }
    log(`HTTP 200 DETAIL ${Date.now() - tD}ms ${detailUrl.replace(/api_key=[^&]+/i, "api_key=***")}`);

    // Committees
    const committeesUrl = congressCommitteesUrl({ congress: CONGRESS, billType, billNumber });
    const tC = Date.now();
    const committeesRes = await fetchJson(committeesUrl, { timeoutMs: 30000 });
    if (committeesRes.ok) {
      log(`HTTP 200 COMMITTEES ${Date.now() - tC}ms ${committeesUrl.replace(/api_key=[^&]+/i, "api_key=***")}`);
    } else {
      warn(`HTTP ${committeesRes.status} COMMITTEES ${committeesUrl}`);
    }

    // Summaries
    const summariesUrl = congressSummariesUrl({ congress: CONGRESS, billType, billNumber });
    const tS = Date.now();
    const summariesRes = await fetchJson(summariesUrl, { timeoutMs: 30000 });
    if (summariesRes.ok) {
      log(`HTTP 200 SUMMARIES ${Date.now() - tS}ms ${summariesUrl.replace(/api_key=[^&]+/i, "api_key=***")}`);
    } else {
      warn(`HTTP ${summariesRes.status} SUMMARIES ${summariesUrl}`);
    }

    // Normalize base doc
    const baseDoc = normalizeBillDoc({
      billId,
      congress: CONGRESS,
      billType,
      billNumber,
      detailJson: detailRes.json,
      committeesJson: committeesRes.ok ? committeesRes.json : null,
      summariesJson: summariesRes.ok ? summariesRes.json : null,
    });

    // AI summary (optional)
    let aiSummary = "";
    if (AI_SUMMARY_ENABLED) {
      try {
        const prompt = buildAiSummaryPrompt(baseDoc);
        const { content, ms } = await openaiChatSummary({ model: OPENAI_SUMMARY_MODEL, prompt });
        aiSummary = content;
        log(`OpenAI summary ${billId} ok ${ms}ms`);
        log(`AI summary length: ${aiSummary.length} chars`);
      } catch (e) {
        warn(`OpenAI summary ${billId} failed: ${e?.message || e}`);
      }
    }

    // Embedding (optional)
    let embedding = null;
    if (EMBEDDINGS_ENABLED) {
      try {
        const embText = buildEmbeddingText({ ...baseDoc, aiSummary });
        if (embText) {
          const { embedding: vec, dim, ms } = await openaiEmbed({ model: OPENAI_EMBED_MODEL, input: embText });
          embedding = vec;
          log(`OpenAI embed(bill) ${billId} ok ${ms}ms (dim=${dim})`);
        } else {
          warn(`OpenAI embed(bill) ${billId} skipped (no text)`);
        }
      } catch (e) {
        warn(`OpenAI embed(bill) ${billId} failed: ${e?.message || e}`);
      }
    }

    const finalDoc = {
      ...baseDoc,
      aiSummary: aiSummary || undefined,
      embedding: embedding || undefined,
    };

    docsToImport.push(finalDoc);

    log(`--- Finished ${i + 1}/${slice.length}: ${billId} ---`);

    // tiny pause to be polite (and reduce chance of API throttle spikes)
    await sleep(30);
  }

  // Import to Typesense in batches
  let importedOk = 0;
  let importedFail = 0;

  for (let i = 0; i < docsToImport.length; i += TYPESENSE_BATCH_SIZE) {
    const batch = docsToImport.slice(i, i + TYPESENSE_BATCH_SIZE);
    const { success, failed } = await typesenseImportDocs({
      collection: TYPESENSE_COLLECTION,
      docs: batch,
      action: "upsert",
    });

    importedOk += success;
    importedFail += failed;

    log(`Typesense import batch ${Math.floor(i / TYPESENSE_BATCH_SIZE) + 1}: success=${success} failed=${failed}`);
  }

  // Save state
  const nextState = {
    ...state,
    max_update_date_seen: newMaxUpdate || state?.max_update_date_seen || null,
    last_run: {
      at: ts(),
      index_mode: INDEX_MODE,
      congress: CONGRESS,
      processed: docsToImport.length,
      typesense_success: importedOk,
      typesense_failed: importedFail,
    },
  };
  writeJsonSafe(STATE_FILE, nextState);

  log("=== Crawl complete ===");
  log("Processed:", docsToImport.length);
  log("Typesense imported success:", importedOk);
  log("Typesense imported failed:", importedFail);
  log("New max_update_date_seen:", nextState.max_update_date_seen || "(none)");
}

main().catch((e) => {
  console.error(`[${ts()}] Crawler failed:`, e?.message || e);
  process.exit(1);
});
