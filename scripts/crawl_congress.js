/**
 * scripts/crawl_congress.js
 *
 * Minimal bill crawler/indexer:
 * - NO bill full-text fetching
 * - NO chunking
 * - NO chunk embeddings
 * - NO chunk collection
 *
 * Indexes one Typesense collection with:
 * - core bill metadata
 * - committees + latest official summary (when available)
 * - optional aiSummary
 * - optional bill embedding (based on metadata only)
 *
 * Env required:
 *   CONGRESS_API_KEY
 *   TYPESENSE_HOST            e.g. https://xxxx.a1.typesense.net
 *   TYPESENSE_API_KEY
 *
 * Optional env:
 *   TYPESENSE_COLLECTION=bills
 *   CONGRESS=119
 *   LIMIT_PER_RUN=1000
 *   CONGRESS_PAGE_SIZE=100
 *   TYPESENSE_BATCH_SIZE=10
 *
 * OpenAI (optional):
 *   OPENAI_API_KEY
 *   OPENAI_SUMMARY_MODEL=gpt-4o-mini
 *   OPENAI_EMBED_MODEL=text-embedding-3-large
 *   ENABLE_AI_SUMMARY=true|false
 *   ENABLE_EMBEDDINGS=true|false
 *
 * Index mode:
 *   INDEX_MODE=upsert_new_updated   (default)
 *
 * State file:
 *   .cache/crawl_state.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function nowISO() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${nowISO()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getenv(name, fallback = undefined) {
  const v = process.env[name];
  return (v === undefined || v === "") ? fallback : v;
}

function mustenv(name) {
  const v = getenv(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function safeJsonParse(s, fallback = null) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) return {};
  return safeJsonParse(fs.readFileSync(statePath, "utf8"), {}) || {};
}

function writeState(statePath, state) {
  ensureDir(path.dirname(statePath));
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

// ---------------------------
// Config
// ---------------------------
const CONGRESS_API_KEY = mustenv("CONGRESS_API_KEY");
const TYPESENSE_HOST = mustenv("TYPESENSE_HOST").replace(/\/+$/, "");
const TYPESENSE_API_KEY = mustenv("TYPESENSE_API_KEY");

const TYPESENSE_COLLECTION = getenv("TYPESENSE_COLLECTION", "bills");
const CONGRESS = Number(getenv("CONGRESS", "119"));

const LIMIT_PER_RUN = Number(getenv("LIMIT_PER_RUN", "1000"));
const CONGRESS_PAGE_SIZE = Number(getenv("CONGRESS_PAGE_SIZE", "100"));

const TYPESENSE_BATCH_SIZE = Number(getenv("TYPESENSE_BATCH_SIZE", "10"));
const INDEX_MODE = getenv("INDEX_MODE", "upsert_new_updated");

const ENABLE_AI_SUMMARY = getenv("ENABLE_AI_SUMMARY", "true") === "true";
const ENABLE_EMBEDDINGS = getenv("ENABLE_EMBEDDINGS", "true") === "true";

const OPENAI_API_KEY = getenv("OPENAI_API_KEY", "");
const OPENAI_SUMMARY_MODEL = getenv("OPENAI_SUMMARY_MODEL", "gpt-4o-mini");
const OPENAI_EMBED_MODEL = getenv("OPENAI_EMBED_MODEL", "text-embedding-3-large");

const CACHE_DIR = path.join(__dirname, "..", ".cache");
const STATE_PATH = path.join(CACHE_DIR, "crawl_state.json");

// ---------------------------
// Fetch helpers
// ---------------------------
async function fetchJson(url, { label, retries = 3, backoffMs = 750 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: {
          "Accept": "application/json",
          // A UA header can reduce random upstream weirdness on some services.
          "User-Agent": "hybrid-search-congress-crawler/1.0"
        }
      });

      const ms = Date.now() - t0;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`HTTP ${res.status} ${label || "FETCH"} ${ms}ms :: ${body.slice(0, 400)}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      log(`HTTP 200 ${label || "FETCH"} ${Date.now() - t0}ms ${redact(url)}`);
      return data;
    } catch (e) {
      lastErr = e;
      const ms = Date.now() - t0;
      const status = e?.status;
      const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || !status;

      log(`Fetch error ${label || "FETCH"} ${ms}ms attempt ${attempt}/${retries}: ${e.message}`);

      if (attempt < retries && retryable) {
        await sleep(backoffMs * attempt);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

function redact(url) {
  return url.replace(/api_key=[^&]+/g, "api_key=***");
}

// ---------------------------
// Congress.gov API wrappers
// ---------------------------
function listBillsUrl({ congress, offset, limit }) {
  // Sort by updateDate desc to let us stop early by date when desired.
  return `https://api.congress.gov/v3/bill/${congress}?format=json&sort=updateDate+desc&limit=${limit}&offset=${offset}&api_key=${CONGRESS_API_KEY}`;
}

function billDetailUrl({ congress, billType, billNumber }) {
  return `https://api.congress.gov/v3/bill/${congress}/${billType}/${billNumber}?format=json&api_key=${CONGRESS_API_KEY}`;
}

function billCommitteesUrl({ congress, billType, billNumber }) {
  return `https://api.congress.gov/v3/bill/${congress}/${billType}/${billNumber}/committees?format=json&api_key=${CONGRESS_API_KEY}`;
}

function billSummariesUrl({ congress, billType, billNumber }) {
  return `https://api.congress.gov/v3/bill/${congress}/${billType}/${billNumber}/summaries?format=json&api_key=${CONGRESS_API_KEY}`;
}

// ---------------------------
// OpenAI helpers (optional)
// ---------------------------
async function openaiSummary({ billId, title, officialSummary, subjects }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing but AI summary enabled");
  const prompt = [
    `Write a concise plain-English summary of the bill in 2-4 sentences.`,
    `Avoid hype. Keep it factual and readable.`,
    ``,
    `TITLE: ${title || ""}`,
    officialSummary ? `OFFICIAL SUMMARY: ${officialSummary}` : "",
    subjects?.length ? `SUBJECTS: ${subjects.join(", ")}` : ""
  ].filter(Boolean).join("\n");

  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_SUMMARY_MODEL,
      input: prompt,
      // keep cost controlled
      max_output_tokens: 220
    })
  });

  const ms = Date.now() - t0;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI summary ${billId} fail ${ms}ms :: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const text =
    data?.output?.map(o => o?.content?.map(c => c?.text).filter(Boolean).join("")).join("\n")
    || data?.output_text
    || "";

  log(`OpenAI summary ${billId} ok ${ms}ms`);
  return (text || "").trim();
}

async function openaiEmbed({ billId, text }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing but embeddings enabled");

  // Defensively cap embedding input to avoid accidental huge payloads.
  // (We no longer include bill text, but this prevents regressions.)
  const capped = String(text || "").slice(0, 20000);

  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_EMBED_MODEL,
      input: capped
    })
  });

  const ms = Date.now() - t0;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI embed(bill) ${billId} fail ${ms}ms :: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error(`OpenAI embed(bill) ${billId}: missing embedding`);
  log(`OpenAI embed(bill) ${billId} ok ${ms}ms (dim=${vec.length})`);
  return vec;
}

function buildEmbedText({ title, officialSummary, aiSummary, subjects, committees }) {
  // IMPORTANT: No full bill text here.
  const parts = [];
  if (title) parts.push(`Title: ${title}`);
  if (aiSummary) parts.push(`AI Summary: ${aiSummary}`);
  if (officialSummary) parts.push(`Official Summary: ${officialSummary}`);
  if (subjects?.length) parts.push(`Subjects: ${subjects.join(", ")}`);
  if (committees?.length) parts.push(`Committees: ${committees.join(", ")}`);
  return parts.join("\n");
}

// ---------------------------
// Typesense helpers (no SDK)
// ---------------------------
async function typesenseUpsertBatch(docs) {
  const url = `${TYPESENSE_HOST}/collections/${encodeURIComponent(TYPESENSE_COLLECTION)}/documents/import?action=upsert`;
  const body = docs.map(d => JSON.stringify(d)).join("\n");

  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY,
      "Content-Type": "text/plain"
    },
    body
  });

  const ms = Date.now() - t0;

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Typesense import failed HTTP ${res.status} ${ms}ms\n${txt}`);
  }

  const txt = await res.text();
  // Each line is JSON per doc
  const lines = txt.trim().split("\n").filter(Boolean);
  let ok = 0, failed = 0;
  for (const line of lines) {
    const j = safeJsonParse(line, {});
    if (j?.success) ok++;
    else failed++;
  }

  log(`Typesense import ${ms}ms => ${ok} ok, ${failed} failed (batch ${docs.length})`);
  if (failed > 0) {
    // Don’t crash the whole run; but log.
    // If you prefer hard-fail, change this to throw.
    log(`WARNING: ${failed} docs failed in Typesense import batch (see response lines)`);
  }
}

// ---------------------------
// Data shaping
// ---------------------------
function normalizeBillId(congress, billType, billNumber) {
  return `${congress}-${billType}-${billNumber}`;
}

function pickLatestOfficialSummary(summariesJson) {
  // Congress API "summaries" shape can vary; keep this flexible.
  const arr = summariesJson?.summaries || summariesJson?.billSummaries || summariesJson?.[0]?.summaries || [];
  if (!Array.isArray(arr) || arr.length === 0) return "";
  // Prefer most recent updateDate if present.
  const sorted = [...arr].sort((a, b) => String(b?.updateDate || "").localeCompare(String(a?.updateDate || "")));
  const text = sorted?.[0]?.text || sorted?.[0]?.summaryText || "";
  return String(text || "").trim();
}

function extractCommittees(committeesJson) {
  const arr = committeesJson?.committees || committeesJson?.billCommittees || [];
  if (!Array.isArray(arr)) return [];
  const names = [];
  for (const c of arr) {
    const n = c?.name || c?.committee?.name;
    if (n) names.push(String(n).trim());
  }
  return [...new Set(names)].filter(Boolean);
}

function extractSubjects(detailJson) {
  // Varies by endpoint/shape.
  const subjects = detailJson?.bill?.subjects?.policyArea?.name
    ? [detailJson.bill.subjects.policyArea.name]
    : [];

  const legislative = detailJson?.bill?.subjects?.legislativeSubjects || detailJson?.bill?.subjects?.legislativeSubject || [];
  if (Array.isArray(legislative)) {
    for (const s of legislative) {
      const name = s?.name || s?.legislativeSubjectName;
      if (name) subjects.push(String(name).trim());
    }
  }

  return [...new Set(subjects)].filter(Boolean);
}

function extractCore(detailJson, { congress, billType, billNumber }) {
  const bill = detailJson?.bill || detailJson;

  const title =
    bill?.title
    || bill?.titles?.[0]?.title
    || bill?.titles?.[0]?.titleText
    || "";

  const updateDate =
    bill?.updateDate
    || bill?.latestAction?.actionDate
    || bill?.latestAction?.actionDateTime
    || "";

  const introducedDate = bill?.introducedDate || "";
  const sponsor = bill?.sponsors?.[0]?.fullName || bill?.sponsor?.fullName || "";

  return {
    id: normalizeBillId(congress, billType, billNumber),
    congress,
    bill_type: billType,
    bill_number: String(billNumber),
    title: String(title || "").trim(),
    sponsor: String(sponsor || "").trim(),
    introduced_date: introducedDate ? String(introducedDate) : "",
    api_update_date: updateDate ? String(updateDate).slice(0, 10) : "",
    source: "congress.gov_api",
    indexed_at: nowISO()
  };
}

// ---------------------------
// Main crawl logic
// ---------------------------
async function main() {
  log("=== Crawl start ===");
  log(`Index mode: ${INDEX_MODE}`);
  log(`Congress: ${CONGRESS}`);
  log(`LIMIT_PER_RUN: ${LIMIT_PER_RUN}`);
  log(`OpenAI summary model: ${OPENAI_SUMMARY_MODEL}`);
  log(`OpenAI embed model: ${OPENAI_EMBED_MODEL}`);
  log(`Typesense batch size: ${TYPESENSE_BATCH_SIZE}`);
  log(`Congress page size: ${CONGRESS_PAGE_SIZE}`);
  log(`AI summary enabled: ${ENABLE_AI_SUMMARY}`);
  log(`Embeddings enabled: ${ENABLE_EMBEDDINGS}`);

  if ((ENABLE_AI_SUMMARY || ENABLE_EMBEDDINGS) && !OPENAI_API_KEY) {
    throw new Error("ENABLE_AI_SUMMARY/ENABLE_EMBEDDINGS true but OPENAI_API_KEY is missing");
  }

  const state = readState(STATE_PATH);
  const prevMaxUpdate = state?.max_update_date_seen || "";
  log(`Prev max_update_date_seen: ${prevMaxUpdate || "(none)"}`);

  let processed = 0;
  let offset = 0;
  let keepPaging = true;

  const toImport = [];
  let maxUpdateSeenThisRun = prevMaxUpdate || "";

  while (keepPaging && processed < LIMIT_PER_RUN) {
    const listUrl = listBillsUrl({ congress: CONGRESS, offset, limit: CONGRESS_PAGE_SIZE });
    log(`Fetching list congress=${CONGRESS} offset=${offset} limit=${CONGRESS_PAGE_SIZE}`);
    const listJson = await fetchJson(listUrl, { label: "LIST", retries: 4 });

    const bills = listJson?.bills || listJson?.bill || [];
    if (!Array.isArray(bills) || bills.length === 0) {
      log("No more list results.");
      break;
    }

    for (const b of bills) {
      if (processed >= LIMIT_PER_RUN) break;

      const billType = (b?.type || b?.billType || "").toLowerCase();
      const billNumber = b?.number || b?.billNumber;
      const apiUpdate = (b?.updateDate || b?.latestAction?.actionDate || "").slice(0, 10);

      if (!billType || !billNumber) continue;

      // Optional early stop: if we're doing upsert_new_updated and list is sorted desc,
      // we can stop once apiUpdate is older than prevMaxUpdate.
      if (INDEX_MODE === "upsert_new_updated" && prevMaxUpdate && apiUpdate && apiUpdate < prevMaxUpdate) {
        keepPaging = false;
        break;
      }

      const billId = normalizeBillId(CONGRESS, billType, billNumber);
      processed++;
      log(`--- Processing ${processed}/${LIMIT_PER_RUN}: ${billId} (api_update=${apiUpdate || "n/a"}) ---`);

      try {
        const detailJson = await fetchJson(
          billDetailUrl({ congress: CONGRESS, billType, billNumber }),
          { label: "DETAIL", retries: 4 }
        );

        const committeesJson = await fetchJson(
          billCommitteesUrl({ congress: CONGRESS, billType, billNumber }),
          { label: "COMMITTEES", retries: 4 }
        );

        // Summaries endpoint is optional; some bills may not have summaries.
        let summariesJson = null;
        try {
          summariesJson = await fetchJson(
            billSummariesUrl({ congress: CONGRESS, billType, billNumber }),
            { label: "SUMMARIES", retries: 2 }
          );
        } catch (e) {
          // not fatal
          log(`SUMMARIES not available for ${billId}: ${e.message}`);
        }

        const core = extractCore(detailJson, { congress: CONGRESS, billType, billNumber });
        const committees = extractCommittees(committeesJson);
        const officialSummary = summariesJson ? pickLatestOfficialSummary(summariesJson) : "";
        const subjects = extractSubjects(detailJson);

        // Keep these ALWAYS present (your earlier “missing from some?” issue)
        const ai_summary_model = OPENAI_SUMMARY_MODEL;
        const embed_model = OPENAI_EMBED_MODEL;

        let aiSummary = "";
        if (ENABLE_AI_SUMMARY) {
          aiSummary = await openaiSummary({
            billId,
            title: core.title,
            officialSummary,
            subjects
          });
          log(`AI summary length: ${aiSummary.length} chars`);
        }

        let embedding = undefined;
        if (ENABLE_EMBEDDINGS) {
          const embedText = buildEmbedText({
            title: core.title,
            officialSummary,
            aiSummary,
            subjects,
            committees
          });
          embedding = await openaiEmbed({ billId, text: embedText });
        }

        // IMPORTANT: no bill full text stored.
        const doc = {
          ...core,
          committees,
          subjects,
          official_summary: officialSummary,
          ai_summary: aiSummary,
          ai_summary_model,
          embed_model
        };

        if (embedding) doc.embedding = embedding;

        // Track max update seen
        if (core.api_update_date && core.api_update_date > maxUpdateSeenThisRun) {
          maxUpdateSeenThisRun = core.api_update_date;
        }

        toImport.push(doc);

        // Flush batches
        if (toImport.length >= TYPESENSE_BATCH_SIZE) {
          await typesenseUpsertBatch(toImport.splice(0, toImport.length));
        }

        log(`--- Finished ${processed}/${LIMIT_PER_RUN}: ${billId} ---`);
      } catch (e) {
        log(`ERROR processing ${billId}: ${e.message}`);
        // Continue crawl; don’t crash entire run on one bill.
      }
    }

    offset += CONGRESS_PAGE_SIZE;
  }

  // Final flush
  if (toImport.length) {
    await typesenseUpsertBatch(toImport.splice(0, toImport.length));
  }

  // Persist state
  if (maxUpdateSeenThisRun && maxUpdateSeenThisRun !== prevMaxUpdate) {
    state.max_update_date_seen = maxUpdateSeenThisRun;
    writeState(STATE_PATH, state);
    log(`State updated: max_update_date_seen=${maxUpdateSeenThisRun}`);
  } else {
    log("State unchanged.");
  }

  log("=== Crawl end ===");
}

main().catch((e) => {
  log(`Crawler failed: ${e.message}`);
  process.exit(1);
});
