/**
 * Congress -> OpenAI (AI summary + embeddings) -> Typesense upsert
 *
 * Adds:
 *  1) Soft-fail per bill (after existing internal retries + optional bill-level retries) and continue
 *  2) Failed queue persisted to state/bills_failed.json
 *  3) At start of each run (AFTER optional fix-tracking export/rebuild), retry failed queue first
 *  4) Then run the rest normally
 *
 * Notes:
 * - LIMIT_PER_RUN=0 means "all"
 * - LIMIT_PER_RUN is enforced against SUCCESSFUL upserts (not attempts)
 * - INDEX_MODE:
 *    - upsert_new_updated (default)
 *    - upsert_new_updated_fix_tracking:
 *         - export from Typesense -> rebuild state
 *         - THEN retry failed queue first
 *         - THEN detect ALL docs missing embeddings -> backfill those (ALL)
 *         - then proceed like upsert_new_updated
 *    - reindex_all
 *
 * Bill-level wrapper retries (optional):
 * - BILL_BUILD_ATTEMPTS (default 2)
 * - BILL_BUILD_BASE_DELAY_MS (default 1250)
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
const FAILED_PATH = path.join("state", "bills_failed.json");

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

// ---------- failed queue ----------
function loadFailedQueue() {
  if (!fs.existsSync(FAILED_PATH)) {
    fs.mkdirSync(path.dirname(FAILED_PATH), { recursive: true });
    return { meta: { last_run_utc: null }, failed: {} };
  }
  try {
    const raw = fs.readFileSync(FAILED_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.meta) parsed.meta = { last_run_utc: null };
    if (!parsed.failed) parsed.failed = {};
    return parsed;
  } catch (e) {
    warn(`Failed queue JSON unreadable; reinitializing: ${String(e?.message || e)}`);
    return { meta: { last_run_utc: null, recovered_from_corruption_utc: ts() }, failed: {} };
  }
}
function saveFailedQueue(fq) {
  fs.mkdirSync(path.dirname(FAILED_PATH), { recursive: true });
  fs.writeFileSync(FAILED_PATH, JSON.stringify(fq, null, 2), "utf8");
}
function recordFailure(fq, billId, stage, reason) {
  const now = ts();
  const cur = fq.failed[billId];
  if (!cur) {
    fq.failed[billId] = {
      bill_id: billId,
      stage: stage || "unknown",
      reason: truncate(String(reason || "unknown"), 2000),
      attempts: 1,
      first_failed_utc: now,
      last_failed_utc: now
    };
  } else {
    cur.stage = stage || cur.stage || "unknown";
    cur.reason = truncate(String(reason || cur.reason || "unknown"), 2000);
    cur.attempts = (cur.attempts || 0) + 1;
    cur.last_failed_utc = now;
  }
}
function clearFailure(fq, billId) {
  if (fq.failed && fq.failed[billId]) delete fq.failed[billId];
}
function listRetryableFailedIds(fq, maxAttempts) {
  const entries = Object.values(fq.failed || {});
  return entries
    .filter((x) => (x?.attempts || 0) < maxAttempts)
    .sort((a, b) => {
      // fewer attempts first, then oldest last_failed first
      const da = a.attempts - b.attempts;
      if (da !== 0) return da;
      const ta = new Date(a.last_failed_utc || 0).getTime();
      const tb = new Date(b.last_failed_utc || 0).getTime();
      return ta - tb;
    })
    .map((x) => x.bill_id)
    .filter(Boolean);
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

// ---------- bill-level wrapper retry (NEW) ----------
async function attemptBuildBill(builderFn, { label, attempts, baseDelayMs } = {}) {
  const max = Math.max(1, attempts || 1);
  const base = Math.max(0, baseDelayMs || 0);

  let lastErr = null;

  for (let i = 1; i <= max; i++) {
    try {
      if (i > 1) warn(`Bill build retry ${i}/${max} for ${label || "bill"}...`);
      return await builderFn();
    } catch (e) {
      lastErr = e;
      if (i >= max) break;
      const delay = base ? Math.round(base * Math.pow(2, i - 1)) : 0;
      if (delay) await sleep(delay);
    }
  }

  throw lastErr || new Error("Bill build failed");
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
  if (!docs.length) return { okIds: [], failIds: [], errors: [] };

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

  const okIds = [];
  const failIds = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let r = null;
    try {
      r = JSON.parse(line);
    } catch {
      errors.push("Unparseable import result line.");
      const fallbackId = docs?.[i]?.id;
      if (fallbackId) failIds.push(String(fallbackId));
      continue;
    }

    const respId = r?.id || r?.document || r?.document_id || r?.doc_id || null;
    const mappedId = respId || docs?.[i]?.id || null;

    if (r?.success) {
      if (mappedId) okIds.push(String(mappedId));
    } else {
      if (mappedId) failIds.push(String(mappedId));
      if (r?.error) errors.push(r.error);
      else errors.push("Import failed without error message.");
    }
  }

  log(
    `Typesense import ${fmtMs(dur)} => ${okIds.length} ok, ${failIds.length} failed (batch ${docs.length}) [${collectionName}]`
  );
  if (failIds.length) warn(`Typesense sample errors [${collectionName}]:`, errors.slice(0, 5));

  return { okIds, failIds, errors };
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
      Number.isFinite(d?.update_date) && d.update_date > 0 ? d.update_date : raw ? toEpochSeconds(raw) : 0;

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
  const arr = Array.isArray(subj) ? subj : subj?.items || subj?.subjects || [];
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

// ---------- batch handling (apply state only on successful import) ----------
/**
 * batchItems: [{ doc, stateUpdate }]
 */
async function flushBatch({ batchItems, collectionName, state, failedQueue }) {
  if (!batchItems.length) return { ok: 0, fail: 0 };

  const docs = batchItems.map((x) => x.doc);

  try {
    const r = await typesenseImportUpsert(docs, collectionName);

    const okSet = new Set(r.okIds);
    const failSet = new Set(r.failIds);

    // Apply state updates only for successful docs
    for (const item of batchItems) {
      const id = item?.doc?.id;
      if (!id) continue;
      if (okSet.has(id)) {
        state.bills[id] = item.stateUpdate;
        clearFailure(failedQueue, id);
      } else if (failSet.has(id)) {
        recordFailure(failedQueue, id, "typesense_import", (r.errors || []).join(" | ") || "Typesense import failed");
      } else {
        recordFailure(failedQueue, id, "typesense_import", "Typesense import result missing id mapping");
      }
    }

    batchItems.length = 0;
    return { ok: r.okIds.length, fail: r.failIds.length };
  } catch (e) {
    const msg = String(e?.message || e);
    warn(`Typesense import hard-failed for batch (${batchItems.length}). Marking all as failed and continuing.`);
    for (const item of batchItems) {
      const id = item?.doc?.id;
      if (!id) continue;
      recordFailure(failedQueue, id, "typesense_import_http", msg);
    }
    batchItems.length = 0;
    return { ok: 0, fail: docs.length };
  }
}

// ---------- single bill processor ----------
async function buildBillDocAndStateUpdate({ openai, summaryModel, embedModel, item, forcedBillId }) {
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

  const congressInt = parseInt(congress, 10);
  const typeStr = safeLower(billType);
  const numberInt = parseInt(billNumber, 10);

  const title = String(item?.title || detailJson?.bill?.title || "").trim() || billId;

  const chamberRaw = item?.originChamber || detailJson?.bill?.originChamber || detailJson?.originChamber || undefined;
  const chamber = normalizeChamber(chamberRaw, billType);

  const introduced_date = extractIntroducedDate(detailJson);

  const updateRaw = pickUpdateDate(item) || pickUpdateDate(detailJson?.bill) || pickUpdateDate(detailJson) || null;
  const update_date = updateRaw ? toEpochSeconds(updateRaw) : introduced_date || 0;

  const short_title = detailJson?.bill?.shortTitle || detailJson?.bill?.short_title || undefined;
  const policy_area = extractPolicyArea(detailJson);
  const subjects = extractSubjects(detailJson);
  const { sponsor_party, sponsor_state } = extractSponsor(detailJson);
  const cosponsor_count = extractCosponsorCount(detailJson);

  const latest_action_text = item?.latestAction?.text || detailJson?.bill?.latestAction?.text || undefined;

  const latest_action_date = extractLatestActionDate(detailJson, item);
  void latest_action_date;

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
  if (embedding.length !== 3072) {
    throw new Error(`Embedding dim mismatch for ${billId}: got ${embedding.length}, expected 3072`);
  }

  const doc = {
    id: billId,
    congress: congressInt,
    type: typeStr,
    number: numberInt,
    chamber,
    introduced_date,
    update_date,
    title,
    short_title,
    ai_summary_text,
    policy_area,
    subjects,
    status: undefined,
    committee_stage: undefined,
    committees,
    sponsor_party,
    sponsor_state,
    cosponsor_count,
    latest_action_text,
    embedding
  };

  for (const k of Object.keys(doc)) {
    if (doc[k] === undefined) delete doc[k];
  }

  const stateUpdate = {
    update_date_raw: updateRaw || null,
    update_date_epoch: update_date || 0,
    ai_summary_model: summaryModel,
    embed_model: embedModel,
    indexed_at_utc: ts()
  };

  return { billId, doc, stateUpdate, apiUpdateRaw: updateRaw || null };
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
  const successTarget = limitPerRunRaw === 0 ? Number.MAX_SAFE_INTEGER : limitPerRunRaw;

  const pageSize = envInt("CONGRESS_PAGE_SIZE", 100);
  const tsBatchSize = envInt("TYPESENSE_BATCH_SIZE", 10);

  const maxFailAttempts = envInt("FAILED_MAX_ATTEMPTS", 5);

  // NEW: bill-level wrapper retries
  const billBuildAttempts = envInt("BILL_BUILD_ATTEMPTS", 2);
  const billBuildBaseDelayMs = envInt("BILL_BUILD_BASE_DELAY_MS", 1250);

  const congresses = (process.env.CONGRESSES || "119")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const primaryCollection = mustEnv("TYPESENSE_COLLECTION");

  const state = loadState();
  const failedQueue = loadFailedQueue();

  const prevMaxUpdate = state?.meta?.max_update_date_seen || null;

  log("=== Crawl start ===");
  log("Index mode:", indexMode);
  log("Congresses:", congresses.join(", "));
  log("LIMIT_PER_RUN (successful upserts):", limitPerRunRaw === 0 ? "all" : limitPerRunRaw);
  log("Prev max_update_date_seen:", prevMaxUpdate);
  log("OpenAI summary model:", summaryModel);
  log("OpenAI embed model:", embedModel);
  log("Typesense batch size:", tsBatchSize);
  log("Congress page size:", pageSize);
  log("Failed queue max attempts:", maxFailAttempts);
  log("Bill build attempts (wrapper):", billBuildAttempts);
  log("Bill build base delay (ms):", billBuildBaseDelayMs);

  let attemptedBills = 0;
  let successfulUpserts = 0;
  let typesenseOk = 0;
  let typesenseFail = 0;

  // FIX: track MAX update date seen this run
  let maxUpdateEpochSeenThisRun = 0;
  let maxUpdateRawSeenThisRun = null;

  const batchItems = [];
  const startAll = Date.now();

  // ---- Fix tracking: export from Typesense to rebuild state (first) ----
  let backfillIds = new Set();
  if (indexMode === "upsert_new_updated_fix_tracking") {
    log("Fix-tracking: exporting from Typesense to rebuild state...");
    const docs = await typesenseExportAll(primaryCollection);
    rebuildStateFromTypesenseDocs(state, docs, { summaryModel, embedModel });

    saveState(state);
    log("Fix-tracking: state rebuilt + written to disk.");

    const missing = findBillsMissingEmbeddings(docs, 3072);
    backfillIds = new Set(missing);

    log(`Fix-tracking: missing embeddings detected: ${missing.length}`);
  }

  // ---- Phase 0: retry failed queue first ----
  const retryIds = listRetryableFailedIds(failedQueue, maxFailAttempts);
  if (retryIds.length) {
    log(`Failed queue: retrying ${retryIds.length} bill(s) first...`);
  } else {
    log("Failed queue: no retryable bills.");
  }

  for (let i = 0; i < retryIds.length && successfulUpserts < successTarget; i++) {
    const billId = retryIds[i];
    log(`=== Failed-queue retry ${i + 1}/${retryIds.length}: ${billId} ===`);

    attemptedBills++;

    try {
      const built = await attemptBuildBill(
        () =>
          buildBillDocAndStateUpdate({
            openai,
            summaryModel,
            embedModel,
            item: null,
            forcedBillId: billId
          }),
        { label: billId, attempts: billBuildAttempts, baseDelayMs: billBuildBaseDelayMs }
      );

      batchItems.push({ doc: built.doc, stateUpdate: built.stateUpdate });

      if (batchItems.length >= tsBatchSize) {
        const r = await flushBatch({
          batchItems,
          collectionName: primaryCollection,
          state,
          failedQueue
        });
        typesenseOk += r.ok;
        typesenseFail += r.fail;
        successfulUpserts += r.ok;

        saveState(state);
        saveFailedQueue(failedQueue);
      }
    } catch (e) {
      const msg = String(e?.message || e);
      warn(`Soft-fail (failed-queue retry) ${billId}: ${msg}`);
      recordFailure(failedQueue, billId, "retry_failed_queue", msg);
      saveFailedQueue(failedQueue);
      continue;
    }
  }

  // ---- Phase 1: backfill missing embeddings (ALL) ----
  if (backfillIds.size && successfulUpserts < successTarget) {
    const arr = Array.from(backfillIds);
    log(`Backfill: processing ${arr.length} bill(s) missing embeddings...`);

    for (let i = 0; i < arr.length && successfulUpserts < successTarget; i++) {
      const billId = arr[i];

      if (failedQueue.failed?.[billId]?.last_failed_utc) continue;

      log(`=== Backfill ${i + 1}/${arr.length}: ${billId} ===`);
      attemptedBills++;

      try {
        const built = await attemptBuildBill(
          () =>
            buildBillDocAndStateUpdate({
              openai,
              summaryModel,
              embedModel,
              item: null,
              forcedBillId: billId
            }),
          { label: billId, attempts: billBuildAttempts, baseDelayMs: billBuildBaseDelayMs }
        );

        batchItems.push({ doc: built.doc, stateUpdate: built.stateUpdate });

        if (batchItems.length >= tsBatchSize) {
          const r = await flushBatch({
            batchItems,
            collectionName: primaryCollection,
            state,
            failedQueue
          });
          typesenseOk += r.ok;
          typesenseFail += r.fail;
          successfulUpserts += r.ok;

          saveState(state);
          saveFailedQueue(failedQueue);
        }
      } catch (e) {
        const msg = String(e?.message || e);
        warn(`Soft-fail (backfill) ${billId}: ${msg}`);
        recordFailure(failedQueue, billId, "backfill_missing_embeddings", msg);
        saveFailedQueue(failedQueue);
        continue;
      }
    }
  }

  // ---- Phase 2: normal crawl (new/updated or reindex_all) ----
  for (const congress of congresses) {
    let offset = 0;

    while (successfulUpserts < successTarget) {
      const listUrl = buildCongressListUrl(congress, pageSize, offset);
      log(`Fetching list congress=${congress} offset=${offset} limit=${pageSize}`);
      const listJson = await fetchJson(listUrl, { label: "LIST", retries: 3 });
      const bills = listJson?.bills || listJson?.results || [];

      if (!Array.isArray(bills) || bills.length === 0) {
        log(`No bills returned for congress ${congress} at offset ${offset}.`);
        break;
      }

      for (const item of bills) {
        if (successfulUpserts >= successTarget) break;

        const billId = normalizeBillId(item.congress, item.type, item.number);

        const apiUpdateRaw = pickUpdateDate(item);
        if (apiUpdateRaw) {
          const ep = toEpochSeconds(apiUpdateRaw);
          if (ep > maxUpdateEpochSeenThisRun) {
            maxUpdateEpochSeenThisRun = ep;
            maxUpdateRawSeenThisRun = apiUpdateRaw;
          }
        }

        if (backfillIds.has(billId)) continue;

        const prev = state.bills[billId];

        // FIX: prev.update_date does not exist in your state format; compare raw if available, else epoch.
        const prevUpdateRaw = prev?.update_date_raw || null;
        const prevUpdateEpoch = Number.isFinite(prev?.update_date_epoch) ? prev.update_date_epoch : 0;

        let shouldProcess = true;
        if (!reindexAll) {
          if (!prev) {
            shouldProcess = true;
          } else if (apiUpdateRaw) {
            shouldProcess = prevUpdateRaw !== apiUpdateRaw;
          } else {
            // If API update raw missing, fall back to "process if we don't have an epoch"
            shouldProcess = prevUpdateEpoch === 0;
          }
        }

        if (!shouldProcess) continue;

        attemptedBills++;

        const idxLabel = `${successfulUpserts + 1}/${limitPerRunRaw === 0 ? "all" : limitPerRunRaw}`;
        log(`--- Processing ${idxLabel}: ${billId} (api_update=${apiUpdateRaw || "n/a"}) ---`);

        try {
          const built = await attemptBuildBill(
            () =>
              buildBillDocAndStateUpdate({
                openai,
                summaryModel,
                embedModel,
                item,
                forcedBillId: null
              }),
            { label: billId, attempts: billBuildAttempts, baseDelayMs: billBuildBaseDelayMs }
          );

          batchItems.push({ doc: built.doc, stateUpdate: built.stateUpdate });

          if (batchItems.length >= tsBatchSize) {
            const r = await flushBatch({
              batchItems,
              collectionName: primaryCollection,
              state,
              failedQueue
            });
            typesenseOk += r.ok;
            typesenseFail += r.fail;
            successfulUpserts += r.ok;

            saveState(state);
            saveFailedQueue(failedQueue);
          }

          log(`--- Finished ${idxLabel}: ${billId} ---`);
        } catch (e) {
          const msg = String(e?.message || e);
          warn(`Soft-fail (normal crawl) ${billId}: ${msg}`);
          recordFailure(failedQueue, billId, "normal_crawl", msg);
          saveFailedQueue(failedQueue);
          continue;
        }
      }

      offset += pageSize;
    }
  }

  // Final flush
  if (batchItems.length) {
    const r = await flushBatch({
      batchItems,
      collectionName: primaryCollection,
      state,
      failedQueue
    });
    typesenseOk += r.ok;
    typesenseFail += r.fail;
    successfulUpserts += r.ok;
  }

  // meta
  state.meta = state.meta || {};
  state.meta.last_run_utc = new Date().toISOString();
  if (maxUpdateRawSeenThisRun) state.meta.max_update_date_seen = maxUpdateRawSeenThisRun;

  failedQueue.meta = failedQueue.meta || {};
  failedQueue.meta.last_run_utc = new Date().toISOString();
  failedQueue.meta.retryable_count = listRetryableFailedIds(failedQueue, maxFailAttempts).length;
  failedQueue.meta.total_failed_tracked = Object.keys(failedQueue.failed || {}).length;

  saveState(state);
  saveFailedQueue(failedQueue);

  log("=== Crawl complete ===");
  log("Bills attempted (including soft-fails):", attemptedBills);
  log("Typesense bills ok:", typesenseOk, "failed:", typesenseFail);
  log("Successful upserts this run:", successfulUpserts);
  log("New max_update_date_seen:", state.meta.max_update_date_seen);
  log("Failed queue totals:", failedQueue.meta.total_failed_tracked, "retryable:", failedQueue.meta.retryable_count);
  log("Total duration:", fmtMs(Date.now() - startAll));
}

main().catch((e) => {
  errlog("Crawler failed:", String(e?.message || e));
  if (e?.stack) errlog(e.stack);
  process.exit(1);
});
