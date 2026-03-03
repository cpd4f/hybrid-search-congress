/**
 * Congress -> OpenAI (AI summary + embedding) -> Typesense upsert
 * With real-time, high-signal logs for GitHub Actions.
 *
 * Key features:
 * - REINDEX_ALL=true to ignore state and reprocess everything (within LIMIT_PER_RUN)
 * - Timestamped logs + per-bill progress
 * - Logs OpenAI + Typesense call durations
 * - Prints Typesense per-doc errors when failures occur
 * - Basic retry/backoff for transient HTTP + OpenAI rate limits
 *
 * Required env:
 * - CONGRESS_API_KEY
 * - CONGRESS_API_BASE (e.g. https://api.congress.gov/v3/bill)
 * - TYPESENSE_API_KEY, TYPESENSE_HOST, TYPESENSE_PORT, TYPESENSE_PROTOCOL, TYPESENSE_COLLECTION
 * - OPENAI_API_KEY
 *
 * Optional env:
 * - OPENAI_SUMMARY_MODEL (default: gpt-4o-mini)
 * - OPENAI_EMBED_MODEL (default: text-embedding-3-large)
 * - CONGRESSES="119" (comma-separated)
 * - LIMIT_PER_RUN="25"
 * - REINDEX_ALL="false"
 * - TYPESENSE_BATCH_SIZE="10" (default: 10)
 * - CONGRESS_PAGE_SIZE="100" (default: 100)
 */

import fs from "fs";
import path from "path";
import { request } from "undici";
import OpenAI from "openai";

const STATE_PATH = path.join("state", "bills_state.json");

// ---------- logging ----------
function ts() {
  // ISO with seconds
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
  const r = (s - m * 60).toFixed(0);
  return `${m}m ${r}s`;
}

// ---------- env helpers ----------
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
function envBool(name, defaultVal = false) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return defaultVal;
  return String(v).trim().toLowerCase() === "true";
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

// ---------- URL builders ----------
function buildCongressListUrl(congress, limit, offset) {
  const base = mustEnv("CONGRESS_API_BASE").replace(/\/$/, "");
  const key = mustEnv("CONGRESS_API_KEY");
  return `${base}/${congress}?format=json&sort=updateDate&limit=${limit}&offset=${offset}&api_key=${encodeURIComponent(key)}`;
}
function buildBillDetailUrl(congress, billType, billNumber) {
  const base = mustEnv("CONGRESS_API_BASE").replace(/\/$/, "");
  const key = mustEnv("CONGRESS_API_KEY");
  return `${base}/${congress}/${String(billType).toLowerCase()}/${billNumber}?format=json&api_key=${encodeURIComponent(key)}`;
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

      // Retry for common transient statuses
      const retryable = [429, 500, 502, 503, 504].includes(res.statusCode);
      const preview = text.slice(0, 300).replace(/\s+/g, " ");
      warn(`HTTP ${res.statusCode} ${label} ${fmtMs(dur)} attempt ${attempt}/${retries} :: ${preview}`);

      if (!retryable || attempt >= retries) {
        throw new Error(`HTTP ${res.statusCode} for ${url}\n${text.slice(0, 800)}`);
      }

      const backoff = Math.min(2000 * attempt, 10000);
      await sleep(backoff);
    } catch (e) {
      const dur = Date.now() - start;
      warn(`Fetch error ${label} ${fmtMs(dur)} attempt ${attempt}/${retries}: ${String(e.message || e)}`);
      if (attempt >= retries) throw e;
      const backoff = Math.min(2000 * attempt, 10000);
      await sleep(backoff);
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

// ---------- detail extractors ----------
async function getBestOfficialSummaryText(detailJson) {
  const summariesObj = detailJson?.bill?.summaries || detailJson?.summaries;
  const summariesUrl = summariesObj?.url;
  if (!summariesUrl) return "";

  const data = await fetchJson(summariesUrl, { label: "SUMMARIES", retries: 2 });
  const arr = data?.summaries || data?.results || data;
  if (!Array.isArray(arr) || !arr.length) return "";

  const textHtml = arr[0]?.text || "";
  return stripHtml(textHtml);
}

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

function extractIntroducedDate(detailJson) {
  const d = detailJson?.bill?.introducedDate || detailJson?.introducedDate;
  return d ? toEpochSeconds(d) : 0;
}

function extractCosponsorCount(detailJson) {
  const cs = detailJson?.bill?.cosponsors || detailJson?.cosponsors;
  const count = cs?.count;
  return Number.isFinite(count) ? count : undefined;
}

function buildInputForAI({ title, policy_area, chamber, latest_action_text, sponsor_party, sponsor_state, official_summary }) {
  const parts = [
    `TITLE: ${title || ""}`,
    policy_area ? `POLICY AREA: ${policy_area}` : "",
    chamber ? `ORIGIN CHAMBER: ${chamber}` : "",
    sponsor_party || sponsor_state ? `SPONSOR: [${sponsor_party || "?"}-${sponsor_state || "?"}]` : "",
    latest_action_text ? `LATEST ACTION: ${latest_action_text}` : "",
    official_summary ? `OFFICIAL SUMMARY: ${truncate(official_summary, 2500)}` : ""
  ].filter(Boolean);

  return parts.join("\n");
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

      // Respect Retry-After if present (OpenAI SDK may expose headers on e.response)
      const retryAfterHeader =
        e?.response?.headers?.get?.("retry-after") ||
        e?.response?.headers?.["retry-after"] ||
        null;

      let waitMs = 1500 * attempt;
      if (retryAfterHeader) {
        const sec = parseFloat(retryAfterHeader);
        if (Number.isFinite(sec)) waitMs = Math.max(waitMs, sec * 1000);
      }
      waitMs = Math.min(waitMs, 20000);
      await sleep(waitMs);
    }
  }
}

// ---------- Typesense upsert ----------
async function typesenseImportUpsert(docs) {
  if (!docs.length) return { success: 0, failed: 0, errors: [] };

  const host = mustEnv("TYPESENSE_HOST");
  const port = mustEnv("TYPESENSE_PORT");
  const protocol = mustEnv("TYPESENSE_PROTOCOL");
  const apiKey = mustEnv("TYPESENSE_API_KEY");
  const collection = mustEnv("TYPESENSE_COLLECTION");

  const url = `${protocol}://${host}:${port}/collections/${collection}/documents/import?action=upsert`;
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

  log(`Typesense import ${fmtMs(dur)} => ${success} ok, ${failed} failed (batch ${docs.length})`);
  if (failed) {
    // show a few errors for quick debugging
    warn("Typesense sample errors:", errors.slice(0, 5));
  }

  return { success, failed, errors };
}

// ---------- main ----------
async function main() {
  // Required env (fail fast)
  mustEnv("CONGRESS_API_KEY");
  mustEnv("CONGRESS_API_BASE");
  mustEnv("TYPESENSE_API_KEY");
  mustEnv("TYPESENSE_HOST");
  mustEnv("TYPESENSE_PORT");
  mustEnv("TYPESENSE_PROTOCOL");
  mustEnv("TYPESENSE_COLLECTION");
  mustEnv("OPENAI_API_KEY");

  const reindexAll = envBool("REINDEX_ALL", false);
  const limitPerRun = envInt("LIMIT_PER_RUN", 25);
  const pageSize = envInt("CONGRESS_PAGE_SIZE", 100);
  const tsBatchSize = envInt("TYPESENSE_BATCH_SIZE", 10);

  const openai = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });
  const summaryModel = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";
  const embedModel = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-large";

  const congresses = (process.env.CONGRESSES || "119")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const state = loadState();
  const prevMaxUpdate = state?.meta?.max_update_date_seen || null;

  log("=== Crawl start ===");
  log("Congresses:", congresses.join(", "));
  log("LIMIT_PER_RUN:", limitPerRun);
  log("REINDEX_ALL:", reindexAll);
  log("Prev max_update_date_seen:", prevMaxUpdate);
  log("OpenAI summary model:", summaryModel);
  log("OpenAI embed model:", embedModel);
  log("Typesense batch size:", tsBatchSize);
  log("Congress page size:", pageSize);

  let processed = 0;
  let newestUpdateSeenThisRun = null;
  let typesenseOk = 0;
  let typesenseFail = 0;

  const docsBatch = [];
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

      // Optional early-exit signal (still safe even with reindexAll)
      if (!reindexAll && prevMaxUpdate) {
        const lastOnPage = bills[bills.length - 1];
        const lastUpdate = pickUpdateDate(lastOnPage);
        // If the page ends before our previously-known horizon, future pages are likely older
        if (lastUpdate && lastUpdate < prevMaxUpdate) {
          log(`Early-stop hint: last update on page (${lastUpdate}) < prev max (${prevMaxUpdate}). We'll finish scanning this page then stop paging further.`);
        }
      }

      for (let i = 0; i < bills.length; i++) {
        if (processed >= limitPerRun) break;

        const item = bills[i];
        const billId = normalizeBillId(item.congress, item.type, item.number);
        const apiUpdateRaw = pickUpdateDate(item);

        if (!newestUpdateSeenThisRun && apiUpdateRaw) newestUpdateSeenThisRun = apiUpdateRaw;

        const prev = state.bills[billId];
        const prevUpdate = prev?.update_date || null;

        const shouldProcess = reindexAll ? true : (!prev || prevUpdate !== apiUpdateRaw);
        if (!shouldProcess) continue;

        const idxLabel = `${processed + 1}/${limitPerRun}`;
        log(`--- Processing ${idxLabel}: ${billId} (api_update=${apiUpdateRaw || "n/a"}) ---`);

        // Detail fetch
        const detailUrl = buildBillDetailUrl(item.congress, item.type, item.number);
        const tDetail0 = Date.now();
        const detailJson = await fetchJson(detailUrl, { label: "DETAIL", retries: 3 });
        log(`Detail fetched ${fmtMs(Date.now() - tDetail0)} for ${billId}`);

        const title = item.title || detailJson?.bill?.title || "";
        const chamber = item.originChamber || detailJson?.bill?.originChamber || undefined;

        const latest_action_text =
          item?.latestAction?.text ||
          detailJson?.bill?.latestAction?.text ||
          undefined;

        const update_date_raw = apiUpdateRaw;
        const update_date = toEpochSeconds(apiUpdateRaw);
        const introduced_date = extractIntroducedDate(detailJson);
        const policy_area = extractPolicyArea(detailJson);
        const { sponsor_party, sponsor_state } = extractSponsor(detailJson);
        const cosponsor_count = extractCosponsorCount(detailJson);

        // Optional official summary
        let official_summary = "";
        try {
          const tSum0 = Date.now();
          official_summary = await getBestOfficialSummaryText(detailJson);
          if (official_summary) {
            log(`Official summary fetched ${fmtMs(Date.now() - tSum0)} (${official_summary.length} chars)`);
          } else {
            log(`Official summary not available`);
          }
        } catch (e) {
          warn(`Official summary fetch failed for ${billId}: ${String(e.message || e)}`);
        }

        // AI summary
        const aiInput = buildInputForAI({
          title,
          policy_area,
          chamber,
          latest_action_text,
          sponsor_party,
          sponsor_state,
          official_summary
        });

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
                        "Focus on what it does. Do not speculate. Do not use bullets. Avoid jargon."
                    }
                  ]
                },
                {
                  role: "user",
                  content: [{ type: "input_text", text: aiInput }]
                }
              ]
            }),
          { label: `summary ${billId}`, retries: 4 }
        );

        const ai_summary_text = (summaryResp.output_text || "").trim() || title;
        log(`AI summary length: ${ai_summary_text.length} chars`);

        // Embedding
        const embedText = [
          title,
          ai_summary_text,
          policy_area ? `Policy area: ${policy_area}` : "",
          latest_action_text ? `Latest action: ${latest_action_text}` : ""
        ]
          .filter(Boolean)
          .join("\n")
          .replace(/\n/g, " ");

        const embResp = await openaiWithRetry(
          () =>
            openai.embeddings.create({
              model: embedModel,
              input: embedText,
              encoding_format: "float"
            }),
          { label: `embed ${billId}`, retries: 4 }
        );

        const embedding = embResp?.data?.[0]?.embedding;
        if (!Array.isArray(embedding)) throw new Error(`Embedding missing/invalid for ${billId}`);
        if (embedding.length !== 3072) {
          throw new Error(`Embedding dim mismatch for ${billId}: got ${embedding.length}, expected 3072`);
        }
        log(`Embedding ok (dim=${embedding.length})`);

        // Build Typesense doc (matches your lean schema)
        const doc = {
          id: billId,
          congress: item.congress,
          type: String(item.type || "").toLowerCase(),
          number: parseInt(item.number, 10),

          chamber,
          title,

          ai_summary_text,
          embedding,

          update_date,
          introduced_date,

          sponsor_party,
          sponsor_state,
          cosponsor_count,

          latest_action_text,

          // extra UI/debug fields (stored even if not in schema)
          update_date_raw,
          api_url: item.url || undefined,
          official_summary: official_summary || undefined
        };

        docsBatch.push(doc);

        // Update state for this bill immediately (we still write once at end)
        state.bills[billId] = {
          update_date: apiUpdateRaw,
          ai_summary_model: summaryModel,
          embed_model: embedModel
        };

        processed++;

        // Flush batch frequently so you can see progress in real time
        if (docsBatch.length >= tsBatchSize) {
          const r = await typesenseImportUpsert(docsBatch);
          typesenseOk += r.success;
          typesenseFail += r.failed;
          docsBatch.length = 0;
        }

        log(`--- Finished ${idxLabel}: ${billId} ---`);
      }

      // Early-stop paging (only when not reindexing)
      if (!reindexAll && prevMaxUpdate) {
        const lastOnPage = bills[bills.length - 1];
        const lastUpdate = pickUpdateDate(lastOnPage);
        if (lastUpdate && lastUpdate < prevMaxUpdate) {
          log(`Paging stop: last update on page (${lastUpdate}) < prev max (${prevMaxUpdate}).`);
          break;
        }
      }

      offset += pageSize;
    }
  }

  // Final flush
  if (docsBatch.length) {
    const r = await typesenseImportUpsert(docsBatch);
    typesenseOk += r.success;
    typesenseFail += r.failed;
    docsBatch.length = 0;
  }

  // meta
  state.meta.last_run_utc = new Date().toISOString();
  if (newestUpdateSeenThisRun) state.meta.max_update_date_seen = newestUpdateSeenThisRun;

  saveState(state);

  log("=== Crawl complete ===");
  log("Processed (attempted):", processed);
  log("Typesense imported ok:", typesenseOk);
  log("Typesense failed:", typesenseFail);
  log("New max_update_date_seen:", state.meta.max_update_date_seen);
  log("Total duration:", fmtMs(Date.now() - startAll));
}

main().catch((e) => {
  errlog("Crawler failed:", String(e?.message || e));
  if (e?.stack) errlog(e.stack);
  process.exit(1);
});
