# Hybrid Search Congress

Hybrid Search Congress is a full ingestion + retrieval stack for U.S. congressional bills:

- **Crawler + enricher**: Congress.gov API → OpenAI summaries/embeddings → Typesense upserts.
- **Search UI**: keyword + vector hybrid search, AI answers, faceted filtering.
- **Bill detail UI**: enriched bill metadata + embedding-based related bills.
- **Edge proxies**: Cloudflare Workers for Congress.gov, Typesense, and OpenAI access from browser clients.

---

## 1) End-to-end architecture

### Data pipeline (offline / batch)
1. Crawl bill lists from Congress.gov by congress + offset pagination.
2. Fetch per-bill detail (and committees/summaries/actions when needed).
3. Derive/normalize status fields.
4. Generate:
   - AI summary text (`gpt-4o-mini` default).
   - Embedding vector (`text-embedding-3-large`, 3072 dims).
5. Upsert docs into Typesense collection (`congress_bills` by default).
6. Persist run state + failed queue for resumable indexing.

### Query pipeline (runtime / web app)
1. User enters query + optional filters.
2. Front-end requests query embedding from OpenAI worker.
3. Front-end sends hybrid Typesense `multi_search` request:
   - text query fields + vector query (`alpha` blending).
4. Results are rendered and optionally summarized by OpenAI responses API.
5. Bill details page runs related-bill retrieval using embedding similarity + text fallback.

---

## 2) Crawler + indexing workflow

The crawler entrypoint is:

```bash
npm run crawl
```

Script location: `scripts/crawl_congress.js`.

### Required environment variables

| Variable | Purpose |
|---|---|
| `CONGRESS_API_KEY` | Congress.gov API key |
| `CONGRESS_API_BASE` | Congress API base URL (e.g. `https://api.congress.gov/v3`) |
| `OPENAI_API_KEY` | OpenAI API key |
| `TYPESENSE_API_KEY` | Typesense admin/write key |
| `TYPESENSE_HOST` | Typesense host |
| `TYPESENSE_PORT` | Typesense port |
| `TYPESENSE_PROTOCOL` | `http` or `https` |
| `TYPESENSE_COLLECTION` | Target collection name |

### Optional crawler knobs

| Variable | Default | Notes |
|---|---:|---|
| `INDEX_MODE` | `upsert_new_updated` | See modes below |
| `LIMIT_PER_RUN` | `25` | `0` = no cap (all successful upserts) |
| `CONGRESSES` | `119` | Comma-separated (e.g. `118,119`) |
| `CONGRESS_PAGE_SIZE` | `100` | Congress list page size |
| `TYPESENSE_BATCH_SIZE` | `10` | Batch size for import/update |
| `OPENAI_SUMMARY_MODEL` | `gpt-4o-mini` | Summary/classification model |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-large` | Embedding model |
| `FAILED_MAX_ATTEMPTS` | `5` | Retry cap for failed queue entries |
| `BILL_BUILD_ATTEMPTS` | `2` | Wrapper retries per bill build |
| `BILL_BUILD_BASE_DELAY_MS` | `1250` | Backoff base |

### `INDEX_MODE` options

- `upsert_new_updated` (default):
  - Crawl target congresses.
  - Process new bills and changed `updateDate` bills.

- `upsert_new_updated_fix_tracking`:
  - Export Typesense docs.
  - Rebuild local state from index.
  - Retry failed queue first.
  - Backfill missing embeddings.
  - Continue like `upsert_new_updated`.

- `reindex_all`:
  - Reprocess all crawled bills (ignore prior update tracking).

- `update_status_only`:
  - No summaries/embeddings generation.
  - Only updates status fields.
  - Skips bills not already indexed in Typesense.

### State + failure handling

Crawler persists:

- `state/bills_state.json`: bill update tracking + run metadata.
- `state/bills_failed.json`: per-bill stage/reason/attempts queue.

On each run (normal modes), retryable failures are processed first.

---

## 3) OpenAI usage

### In crawler
- **Responses API** for summary generation and status classification fallback.
- **Embeddings API** for 3072-dim vectors.

### In web app
- Query embedding generation for hybrid search.
- AI answer generation for result summarization (search page).

---

## 4) Typesense schema + upsert expectations

Primary collection is configured by `TYPESENSE_COLLECTION` and front-end default index is `congress_bills`.

The crawler assumes required fields include:

- `congress` (int32)
- `type` (string)
- `number` (int32)
- `chamber` (string)
- `introduced_date` (int64)
- `update_date` (int64)
- `title` (string)
- `ai_summary_text` (string)
- `embedding` (float[]; 3072 dims)

Status-oriented optional fields:

- `status` (bucket label)
- `status_action_type` (raw latest action type)

Index writes use Typesense import with `action=upsert` (or `action=update` for status-only batches).

---

## 5) Congress.gov enrichment calls

Beyond list/detail fetches, the pipeline also uses:

- `/bill/{congress}/{type}/{number}/actions` for latest action type/status.
- Summaries endpoint URLs from bill detail payload for official summaries.
- Committees endpoint URL from bill detail when committee list is absent in the detail payload.

These additional pulls drive richer filters, status quality, and UI metadata.

---

## 6) Cloudflare Workers and browser-side API access

The UI is wired to worker proxies (hardcoded in front-end scripts):

- Typesense proxy worker (search + multi_search)
- OpenAI proxy worker (embeddings + responses)
- Congress proxy worker (committee and bill-related fetches)

Why this matters:
- Keeps browser from handling private vendor API keys directly.
- Centralizes auth/egress policy and optional request shaping.

---

## 7) Website/app features

### Pages
- `index.html`: main search + filters + AI answer + recent bills.
- `feed.html`: committee-specific search view (no AI answer panel).
- `committee.html`: committee landing grouped by chamber + no-bills footer lists.
- `bill.html`: detailed bill view + Q&A + related bills rail.

### Hybrid search behavior
- Query is embedded and sent with text query in Typesense `multi_search`.
- Hybrid blending controlled with `alpha` in vector query.
- Rich filters include policy area, sponsor party, status, and updated range (feed has reduced filter set).

### Related bills (bill page)
- Embeds seed bill context/query.
- Runs vector-centric Typesense retrieval with text fallback if embeddings fail.
- Renders related docs in the bill side rail.

---

## 8) Auto-crawler options (recommended)

The repo provides a manual runner (`npm run crawl`). To automate:

1. Deploy crawler in a scheduled environment (e.g., GitHub Actions cron, Cloudflare scheduled worker invoking a secure endpoint, or any cron-capable runner).
2. Run with `INDEX_MODE=upsert_new_updated` for normal incremental operation.
3. Periodically run `upsert_new_updated_fix_tracking` for state repair + embedding backfill hygiene.
4. Use `LIMIT_PER_RUN=0` for full sweep jobs, or bounded limits for frequent incremental jobs.

---

## 9) Local development quick start

```bash
npm install
npm run crawl
python3 -m http.server 4173
# open http://127.0.0.1:4173
```

> `npm run crawl` requires all indexing env vars listed above.

---

## 10) Repo map

- `scripts/crawl_congress.js` — ingestion/enrichment/indexing pipeline
- `js/ai-search.js` — search page/feed hybrid query + filters + AI answer
- `js/bill.js` — bill details + related-bills retrieval + bill Q&A
- `js/committee.js` — committee landing and per-committee bill previews
- `css/styles.css`, `css/filters.css` — app styling
- `state/` — crawler state + failed queue

