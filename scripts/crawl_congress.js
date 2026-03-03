/**
 * Minimal Congress -> Typesense crawler (NO OpenAI yet)
 *
 * What it does:
 * - Loads state from state/bills_state.json (creates if missing)
 * - Fetches bills list sorted by updateDate desc for congress(es) in env CONGRESSES
 * - Upserts lightweight docs into Typesense (documents/import?action=upsert)
 * - Updates per-bill update_date in state and writes it back
 *
 * Required env:
 * - CONGRESS_API_KEY
 * - CONGRESS_API_BASE (repo variable)
 * - TYPESENSE_API_KEY
 * - TYPESENSE_HOST
 * - TYPESENSE_PORT
 * - TYPESENSE_PROTOCOL
 * - TYPESENSE_COLLECTION
 *
 * Optional env:
 * - CONGRESSES="119" (comma-separated)
 * - LIMIT_PER_RUN="25"
 */

import fs from "fs";
import path from "path";
import { request } from "undici";

const STATE_PATH = path.join("state", "bills_state.json");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

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

function normalizeBillId(congress, type, number) {
  return `${congress}-${String(type || "").toLowerCase()}-${String(number)}`;
}

function toEpochSeconds(dateStr) {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return undefined;
  return Math.floor(d.getTime() / 1000);
}

async function fetchJson(url) {
  const res = await request(url, { method: "GET" });
  const text = await res.body.text();

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode} for ${url}\n${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse JSON from ${url}\n${text.slice(0, 500)}`);
  }
}

async function typesenseImportUpsert(docs) {
  if (!docs.length) return { success: 0, failed: 0 };

  const host = mustEnv("TYPESENSE_HOST");
  const port = mustEnv("TYPESENSE_PORT");
  const protocol = mustEnv("TYPESENSE_PROTOCOL");
  const apiKey = mustEnv("TYPESENSE_API_KEY");
  const collection = mustEnv("TYPESENSE_COLLECTION");

  const url = `${protocol}://${host}:${port}/collections/${collection}/documents/import?action=upsert`;
  const ndjson = docs.map((d) => JSON.stringify(d)).join("\n");

  const res = await request(url, {
    method: "POST",
    headers: {
      "X-TYPESENSE-API-KEY": apiKey,
      "Content-Type": "text/plain"
    },
    body: ndjson
  });

  const text = await res.body.text();

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Typesense import failed HTTP ${res.statusCode}\n${text.slice(0, 1000)}`);
  }

  const lines = text.split("\n").filter(Boolean);
  let success = 0;
  let failed = 0;

  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.success) success++;
      else failed++;
    } catch {
      failed++;
    }
  }

  return { success, failed };
}

function buildCongressListUrl(congress, limit, offset) {
  const base = mustEnv("CONGRESS_API_BASE").replace(/\/$/, ""); // from repo variable
  const key = mustEnv("CONGRESS_API_KEY");

  // Your base is https://api.congress.gov/v3/bill
  // List endpoint becomes: https://api.congress.gov/v3/bill/{congress}
  // Add sort + paging + format
  return `${base}/${congress}?format=json&sort=updateDate&limit=${limit}&offset=${offset}&api_key=${encodeURIComponent(key)}`;
}

function pickUpdateDate(item) {
  // Prefer includingText if available
  return item.updateDateIncludingText || item.updateDate || null;
}

function buildDocFromListItem(item) {
  const congress = item.congress;
  const type = item.type;
  const number = parseInt(item.number, 10);

  const id = normalizeBillId(congress, type, number);

  const updateDateRaw = pickUpdateDate(item);
  const latestActionDateRaw = item?.latestAction?.actionDate || null;

  return {
    id,
    congress,
    type: String(type || "").toLowerCase(),
    number: Number.isFinite(number) ? number : undefined,

    chamber: item.originChamber || undefined,

    title: item.title || "",
    latest_action_text: item?.latestAction?.text || undefined,

    update_date: toEpochSeconds(updateDateRaw) || 0,
    introduced_date: 0, // will be filled later from detail endpoint
    cosponsor_count: undefined, // later
    sponsor_party: undefined, // later
    sponsor_state: undefined, // later
    status: undefined, // later
    committee_stage: undefined, // later
    committees: undefined, // later
    policy_area: undefined, // later
    subjects: undefined, // later

    // UI / debugging (not in schema, still stored)
    update_date_raw: updateDateRaw,
    latest_action_date: toEpochSeconds(latestActionDateRaw),
    api_url: item.url || undefined
  };
}

async function main() {
  // Required env checks up front (fail fast)
  mustEnv("CONGRESS_API_KEY");
  mustEnv("CONGRESS_API_BASE");
  mustEnv("TYPESENSE_API_KEY");
  mustEnv("TYPESENSE_HOST");
  mustEnv("TYPESENSE_PORT");
  mustEnv("TYPESENSE_PROTOCOL");
  mustEnv("TYPESENSE_COLLECTION");

  const congresses = (process.env.CONGRESSES || "119")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const limitPerRun = parseInt(process.env.LIMIT_PER_RUN || "25", 10);
  const pageSize = 250;

  const state = loadState();
  const prevMaxUpdate = state?.meta?.max_update_date_seen || null;

  console.log("Congresses:", congresses.join(", "));
  console.log("LIMIT_PER_RUN:", limitPerRun);
  console.log("Prev max_update_date_seen:", prevMaxUpdate);

  let docsToUpsert = [];
  let processedCount = 0;

  let newestUpdateSeenThisRun = null;

  for (const congress of congresses) {
    let offset = 0;
    let keepPaging = true;

    while (keepPaging) {
      const url = buildCongressListUrl(congress, pageSize, offset);
      const data = await fetchJson(url);

      // Congress API typically returns: { bills: [...], pagination: {...} }
      const bills = data?.bills || data?.results || [];
      if (!Array.isArray(bills) || bills.length === 0) {
        console.log(`No bills returned for congress ${congress} at offset ${offset}.`);
        break;
      }

      let pageProcessed = 0;
      let allOlderThanPrevMax = true;

      for (const item of bills) {
        if (processedCount >= limitPerRun) {
          keepPaging = false;
          break;
        }

        const billId = normalizeBillId(item.congress, item.type, item.number);
        const apiUpdateRaw = pickUpdateDate(item);

        // Track newest update date string seen (for meta)
        if (!newestUpdateSeenThisRun && apiUpdateRaw) newestUpdateSeenThisRun = apiUpdateRaw;

        // Early-stop helper flag: if any item is >= prevMaxUpdate, then not "all older"
        if (prevMaxUpdate && apiUpdateRaw && apiUpdateRaw >= prevMaxUpdate) {
          allOlderThanPrevMax = false;
        }

        const prev = state.bills[billId];
        const prevUpdate = prev?.update_date || null;

        const shouldProcess = !prev || prevUpdate !== apiUpdateRaw;

        if (!shouldProcess) continue;

        const doc = buildDocFromListItem(item);
        docsToUpsert.push(doc);

        // Update state entry now (we’ll still write after Typesense succeeds)
        state.bills[billId] = {
          update_date: apiUpdateRaw,
          // placeholders for later phases
          inputs_hash: prev?.inputs_hash || null,
          ai_summary_version: prev?.ai_summary_version || "v0"
        };

        processedCount++;
        pageProcessed++;
      }

      // Flush batch to Typesense every ~100 docs (or at end)
      if (docsToUpsert.length >= 100) {
        const result = await typesenseImportUpsert(docsToUpsert);
        console.log(`Typesense import: ${result.success} ok, ${result.failed} failed`);
        docsToUpsert = [];
      }

      // Early stop: once we’re past previously seen update horizon AND nothing to do on this page
      if (prevMaxUpdate && allOlderThanPrevMax && pageProcessed === 0) {
        console.log(`Early stop: reached bills older than prev max_update_date_seen (${prevMaxUpdate}).`);
        break;
      }

      offset += pageSize;

      // If the API provides pagination info, you can stop when no next page exists.
      // But offset paging works fine for now.
      if (!keepPaging) break;
    }
  }

  // Final flush
  if (docsToUpsert.length) {
    const result = await typesenseImportUpsert(docsToUpsert);
    console.log(`Typesense import: ${result.success} ok, ${result.failed} failed`);
  }

  // Update meta
  state.meta.last_run_utc = new Date().toISOString();
  if (newestUpdateSeenThisRun) state.meta.max_update_date_seen = newestUpdateSeenThisRun;

  saveState(state);

  console.log("Done.");
  console.log("Processed:", processedCount);
  console.log("New max_update_date_seen:", state.meta.max_update_date_seen);
}

main().catch((err) => {
  console.error("Crawler failed:", err);
  process.exit(1);
});
