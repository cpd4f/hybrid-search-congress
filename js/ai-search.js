/* ---------------------------------------------------
   AI SEARCH (Typesense hybrid vector search via Workers)
   - No Pinecone
   - Query embeddings from OpenAI Worker
   - Hybrid search in Typesense via vector_query
--------------------------------------------------- */

(function () {
  "use strict";

  // ---------- CONFIG ----------
  // Your Workers:
  const TYPESENSE_WORKER_BASE = "https://typesense-proxy-worker.colemandavis4.workers.dev";
  const OPENAI_WORKER_BASE = "https://openai-proxy-worker.colemandavis4.workers.dev";

  // Typesense collection name (fallback to APP_CONFIG if present)
  const COLLECTION =
    (window.APP_CONFIG && window.APP_CONFIG.TYPESENSE_INDEX) ||
    "congress_bills";

  // Models
  const EMBED_MODEL =
    (window.APP_CONFIG && window.APP_CONFIG.OPENAI_EMBED_MODEL) ||
    "text-embedding-3-large";

  // Search defaults
  const RECENT_LIMIT =
    (window.APP_CONFIG && window.APP_CONFIG.RECENT_BILLS_LIMIT) ||
    12;

  const RESULTS_PER_PAGE =
    (window.APP_CONFIG && window.APP_CONFIG.RESULTS_PER_PAGE) ||
    20;

  // Hybrid weighting: 0..1 (higher = more semantic)
  const DEFAULT_ALPHA =
    (window.APP_CONFIG && window.APP_CONFIG.HYBRID_ALPHA) ||
    0.65;

  // Embedding dims must match collection schema
  const EXPECTED_EMBED_DIMS = 3072;

  // Endpoints (Worker routes)
  const TS_SEARCH_URL =
    `${TYPESENSE_WORKER_BASE.replace(/\/$/, "")}/collections/${encodeURIComponent(COLLECTION)}/documents/search`;

  // OpenAI worker should expose /embeddings (maps to /v1/embeddings upstream)
  const OA_EMBED_URL =
    `${OPENAI_WORKER_BASE.replace(/\/$/, "")}/embeddings`;


  // ---------- jQuery ready helper ----------
  function waitForjQuery(timeoutMs = 8000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      (function tick() {
        if (window.jQuery) return resolve(window.jQuery);
        if (Date.now() - start > timeoutMs) return reject(new Error("jQuery failed to load"));
        setTimeout(tick, 30);
      })();
    });
  }

  // ---------- utils ----------
  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function epochToDate(epochSeconds) {
    if (!epochSeconds) return "";
    const d = new Date(epochSeconds * 1000);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function sponsorDotClass(party) {
    const p = String(party || "").toUpperCase();
    if (p === "R") return "party-dot party-dot--r";
    if (p === "D") return "party-dot party-dot--d";
    if (p === "I") return "party-dot party-dot--i";
    return "party-dot party-dot--u";
  }

  function firstCommittee(committees) {
    if (!Array.isArray(committees) || !committees.length) return "";
    return String(committees[0] || "");
  }

  function billShortId(doc) {
    const t = String(doc?.type || "").toUpperCase();
    const n = String(doc?.number || "");
    if (!t || !n) return "";
    return `${t} ${n}`;
  }

  function getParam(name) {
    const u = new URL(window.location.href);
    return u.searchParams.get(name);
  }

  // ---------- OpenAI embeddings via worker ----------
  async function embedQuery(q) {
    const res = await fetch(OA_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Matches OpenAI embeddings API body
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: q,
        encoding_format: "float"
      })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Embeddings failed HTTP ${res.status}: ${txt}`);
    }

    const json = await res.json();
    const vec = json?.data?.[0]?.embedding;

    if (!Array.isArray(vec)) throw new Error("Embeddings response missing embedding[]");
    if (vec.length !== EXPECTED_EMBED_DIMS) {
      throw new Error(`Embedding dim mismatch: got ${vec.length}, expected ${EXPECTED_EMBED_DIMS}`);
    }

    return vec;
  }

  // ---------- Typesense recent bills ----------
  async function fetchRecentBills(limit) {
    const params = new URLSearchParams({
      q: "*",
      query_by: "title",
      per_page: String(limit),
      page: "1",
      sort_by: "update_date:desc",
      include_fields: [
        "id",
        "title",
        "type",
        "number",
        "chamber",
        "congress",
        "update_date",
        "latest_action_text",
        "committees",
        "sponsor_party",
        "sponsor_state"
      ].join(","),
      exclude_fields: "embedding"
    });

    const url = `${TS_SEARCH_URL}?${params.toString()}`;
    const res = await fetch(url, { method: "GET" });

    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Recent bills failed HTTP ${res.status}: ${txt}`);
    }

    return res.json();
  }

  // ---------- Typesense hybrid search ----------
  async function hybridSearch({ q, vector, page = 1, perPage = 20, alpha = DEFAULT_ALPHA }) {
    // k: how many semantic candidates to consider (oversample a bit)
    const k = Math.max(60, perPage * 4);

    // Typesense vector_query format: field:([..], k:.., alpha:..)
    // Note: the exact supported parameters depend on your Typesense version/config.
    const vectorQuery = `embedding:([${vector.join(",")}], k:${k}, alpha:${alpha})`;

    const params = new URLSearchParams({
      q: q,
      query_by: "title,ai_summary_text,policy_area,subjects,committees,latest_action_text",
      per_page: String(perPage),
      page: String(page),
      // Keep a predictable sort fallback
      sort_by: "_text_match:desc,update_date:desc",
      vector_query: vectorQuery,
      // Helpful for blended results
      rerank_hybrid_matches: "true",
      include_fields: [
        "id",
        "title",
        "type",
        "number",
        "congress",
        "chamber",
        "update_date",
        "introduced_date",
        "ai_summary_text",
        "policy_area",
        "subjects",
        "committees",
        "sponsor_party",
        "sponsor_state",
        "cosponsor_count",
        "latest_action_text"
      ].join(","),
      exclude_fields: "embedding"
    });

    const url = `${TS_SEARCH_URL}?${params.toString()}`;
    const res = await fetch(url, { method: "GET" });

    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Search failed HTTP ${res.status}: ${txt}`);
    }

    return res.json();
  }

  // ---------- render: recent bills rail ----------
  function renderRecentBills(json) {
    const $mount = window.jQuery("#recentBills");
    if (!$mount.length) return;

    const hits = json?.hits || [];
    if (!hits.length) {
      $mount.html(`<div class="muted">No recent bills found.</div>`);
      return;
    }

    const html = hits
      .map(h => h.document)
      .map(d => {
        const committee = firstCommittee(d.committees);
        const updated = epochToDate(d.update_date);
        const dot = sponsorDotClass(d.sponsor_party);

        return `
          <a class="billcard" href="./bill.html?id=${encodeURIComponent(d.id)}">
            <span class="${dot}" aria-hidden="true"></span>

            <div class="billcard__meta">
              <div class="billcard__id">${escHtml(billShortId(d))}</div>
              <div class="billcard__status">${escHtml(d.chamber || "")}${d.congress ? " • " + escHtml(String(d.congress)) + "th" : ""}</div>
            </div>

            <div class="billcard__title">${escHtml(d.title || "")}</div>

            <div class="billcard__footer">
              <div class="billcard__committee">${escHtml(committee || "Committee TBD")}</div>
              <div class="billcard__date">${updated ? "Updated " + escHtml(updated) : ""}</div>
            </div>
          </a>
        `;
      })
      .join("");

    // Your CSS already expects a flex rail, so just inject cards
    $mount.html(html);
  }

  // ---------- render: results list ----------
  function renderResults(json, q) {
    const $mount = window.jQuery("#results");
    if (!$mount.length) return;

    const found = json?.found ?? 0;
    const hits = json?.hits || [];

    const $count = window.jQuery("#resultsCount");
    if ($count.length) $count.text(found);

    if (!hits.length) {
      $mount.html(`<div class="muted">No results for “${escHtml(q)}”.</div>`);
      return;
    }

    const html = hits
      .map(h => h.document)
      .map(d => {
        const dot = sponsorDotClass(d.sponsor_party);
        const updated = epochToDate(d.update_date);
        const committee = Array.isArray(d.committees) ? d.committees.slice(0, 2).join(", ") : "";
        const policy = d.policy_area ? String(d.policy_area) : "";
        const summary = d.ai_summary_text ? String(d.ai_summary_text) : "";

        return `
          <div class="panel" style="margin-bottom:16px;">
            <div style="display:flex;align-items:center;gap:10px;justify-content:space-between;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="${dot}" aria-hidden="true"></span>
                <div style="font-weight:600;font-size:14px;">
                  ${escHtml(billShortId(d))}${d.chamber ? " • " + escHtml(d.chamber) : ""}${d.congress ? " • " + escHtml(String(d.congress)) + "th Congress" : ""}
                </div>
              </div>
              <div style="font-size:12px;color:var(--color-muted);">
                ${updated ? escHtml(updated) : ""}
              </div>
            </div>

            <div style="margin-top:10px;">
              <a href="./bill.html?id=${encodeURIComponent(d.id)}" style="font-weight:700;font-size:18px;line-height:1.35;display:inline-block;">
                ${escHtml(d.title || "")}
              </a>
            </div>

            ${summary ? `<div style="margin-top:10px;color:var(--color-muted);line-height:1.45;">${escHtml(summary)}</div>` : ""}

            <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;">
              ${policy ? `<span class="chip">${escHtml(policy)}</span>` : ""}
              ${committee ? `<span class="chip">${escHtml(committee)}</span>` : ""}
              ${d.sponsor_party ? `<span class="chip">${escHtml(String(d.sponsor_party))}${d.sponsor_state ? "-" + escHtml(String(d.sponsor_state)) : ""}</span>` : ""}
              ${Number.isFinite(d.cosponsor_count) ? `<span class="chip">${escHtml(String(d.cosponsor_count))} cosponsors</span>` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    $mount.html(html);
  }

  // ---------- search runner ----------
  async function runSearch(q) {
    const query = String(q || "").trim();
    if (!query) return;

    const $results = window.jQuery("#results");
    if ($results.length) $results.html(`<div class="muted">Searching…</div>`);

    const vector = await embedQuery(query);
    const json = await hybridSearch({
      q: query,
      vector,
      perPage: RESULTS_PER_PAGE,
      alpha: DEFAULT_ALPHA
    });

    renderResults(json, query);
  }

  // ---------- boot ----------
  async function boot() {
    const $ = await waitForjQuery();

    // Recent bills rail
    try {
      const recentJson = await fetchRecentBills(RECENT_LIMIT);
      renderRecentBills(recentJson);
    } catch (e) {
      console.warn("Recent bills failed:", e);
      const $mount = $("#recentBills");
      if ($mount.length) $mount.html(`<div class="muted">Could not load recent bills.</div>`);
    }

    // Bind main search
    const $form = $("#mainSearchForm");
    const $input = $("#mainSearchInput");

    if ($form.length && $input.length) {
      $form.on("submit", async function (ev) {
        ev.preventDefault();
        try {
          await runSearch($input.val());
        } catch (e) {
          console.error(e);
          $("#results").html(`<div class="muted">Search failed. Check the console.</div>`);
        }
      });
    }

    // Auto-run if ?q=
    const qParam = getParam("q");
    if (qParam && $input.length) {
      $input.val(qParam);
      try {
        await runSearch(qParam);
      } catch (e) {
        console.error(e);
      }
    }
  }

  if (window.onReady) window.onReady(boot);
  else document.addEventListener("DOMContentLoaded", boot);
})();
