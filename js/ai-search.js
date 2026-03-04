/* ---------------------------------------------------
   AI SEARCH (OpenAI embeddings + Typesense hybrid search)
   No Pinecone
--------------------------------------------------- */

(function () {
  "use strict";

  // ---------- tiny helpers ----------
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

  function sponsorDot(party) {
    const p = String(party || "").toUpperCase();
    if (p === "R") return "dot dot--r";
    if (p === "D") return "dot dot--d";
    return "dot dot--u";
  }

  // ---------- endpoints ----------
  const COLLECTION = (window.APP_CONFIG && APP_CONFIG.TYPESENSE_INDEX) || "congress_bills";

  // Your app.js defines these:
  // API.TYPESENSE, API.OPENAI
  const TS_SEARCH_URL = `${window.API?.TYPESENSE}/collections/${encodeURIComponent(COLLECTION)}/documents/search`;
  const OA_EMBED_URL = `${window.API?.OPENAI}/embeddings`;

  // ---------- OpenAI: embed query ----------
  async function embedQuery(q) {
    const res = await fetch(OA_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-large",
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
    return vec;
  }

  // ---------- Typesense: recent bills ----------
  async function fetchRecentBills(limit = 12) {
    const params = new URLSearchParams({
      q: "*",
      query_by: "title", // minimal, since q="*"
      per_page: String(limit),
      page: "1",
      sort_by: "update_date:desc",
      include_fields: [
        "id",
        "title",
        "type",
        "number",
        "congress",
        "chamber",
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
      throw new Error(`Typesense recent bills failed HTTP ${res.status}: ${txt}`);
    }

    return res.json();
  }

  // ---------- Typesense: hybrid search (keyword + vector) ----------
  async function hybridSearch({ q, vector, page = 1, perPage = 20, alpha = 0.65 }) {
    // NOTE:
    // vector_query syntax and alpha are defined by Typesense docs. :contentReference[oaicite:4]{index=4}
    const vectorQuery = `embedding:([${vector.join(",")}], k:${Math.max(50, perPage * 3)}, alpha:${alpha})`;

    const params = new URLSearchParams({
      q: q,
      query_by: "title,ai_summary_text,policy_area,subjects,committees,latest_action_text",
      per_page: String(perPage),
      page: String(page),
      sort_by: "_text_match:desc,update_date:desc",
      vector_query: vectorQuery,
      rerank_hybrid_matches: "true",
      drop_tokens_threshold: "0",
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
      throw new Error(`Typesense search failed HTTP ${res.status}: ${txt}`);
    }

    return res.json();
  }

  // ---------- render: recent bills ----------
  function renderRecentBills(json) {
    const $wrap = window.jQuery("#recentBills");
    if (!$wrap.length) return;

    const hits = json?.hits || [];
    if (!hits.length) {
      $wrap.html(`<div class="muted">No bills found yet.</div>`);
      return;
    }

    const cards = hits
      .map((h) => h.document)
      .map((d) => {
        const committee = Array.isArray(d.committees) && d.committees.length ? d.committees[0] : "";
        const updated = epochToDate(d.update_date);
        const partyClass = sponsorDot(d.sponsor_party);
        const billLabel = `${escHtml(String(d.type || "").toUpperCase())} ${escHtml(String(d.number || ""))}`;

        return `
          <a class="bill-card" href="./bill.html?id=${encodeURIComponent(d.id)}">
            <span class="${partyClass}" aria-hidden="true"></span>
            <div class="bill-card__kicker">${billLabel} • ${escHtml(String(d.chamber || ""))}</div>
            <div class="bill-card__title">${escHtml(d.title)}</div>
            <div class="bill-card__meta">
              <span>${escHtml(committee || "Committee TBD")}</span>
              <span>Updated ${escHtml(updated || "")}</span>
            </div>
          </a>
        `;
      })
      .join("");

    $wrap.html(`<div class="bill-rail">${cards}</div>`);
  }

  // ---------- render: search results ----------
  function renderResults(json, q) {
    const $wrap = window.jQuery("#results");
    if (!$wrap.length) return;

    const hits = json?.hits || [];
    const found = json?.found ?? 0;

    if (!hits.length) {
      $wrap.html(`<div class="muted">No results for “${escHtml(q)}”.</div>`);
      return;
    }

    const items = hits
      .map((h) => h.document)
      .map((d) => {
        const billLabel = `${escHtml(String(d.type || "").toUpperCase())} ${escHtml(String(d.number || ""))} • ${escHtml(
          String(d.chamber || "")
        )} • ${escHtml(String(d.congress || ""))}th Congress`;

        const updated = epochToDate(d.update_date);
        const summary = d.ai_summary_text ? escHtml(d.ai_summary_text) : "";

        const committee = Array.isArray(d.committees) && d.committees.length ? d.committees.slice(0, 2).join(", ") : "";
        const policy = d.policy_area ? escHtml(d.policy_area) : "";
        const partyClass = sponsorDot(d.sponsor_party);

        return `
          <div class="result">
            <div class="result__top">
              <span class="${partyClass}" aria-hidden="true"></span>
              <div class="result__kicker">${billLabel}</div>
              <div class="result__date">${escHtml(updated || "")}</div>
            </div>

            <a class="result__title" href="./bill.html?id=${encodeURIComponent(d.id)}">${escHtml(d.title)}</a>

            ${summary ? `<div class="result__summary">${summary}</div>` : ""}

            <div class="result__meta">
              ${policy ? `<span class="pill">${policy}</span>` : ""}
              ${committee ? `<span class="pill">${escHtml(committee)}</span>` : ""}
              ${d.sponsor_party ? `<span class="pill">${escHtml(d.sponsor_party)}-${escHtml(d.sponsor_state || "")}</span>` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    $wrap.html(`
      <div class="results-header">
        <div class="results-header__count">${found.toLocaleString()} results</div>
      </div>
      <div class="results-list">${items}</div>
    `);
  }

  // ---------- main search ----------
  async function runSearch(q) {
    const trimmed = String(q || "").trim();
    if (!trimmed) return;

    const $results = window.jQuery("#results");
    if ($results.length) $results.html(`<div class="muted">Searching…</div>`);

    // Query embedding (we keep it simple for the demo: embed the raw query)
    // If you want, we can port over your “enriched vs raw blending” next.
    const vector = await embedQuery(trimmed);

    // Hybrid search (vector + keyword)
    const json = await hybridSearch({
      q: trimmed,
      vector,
      perPage: (window.APP_CONFIG && APP_CONFIG.RESULTS_PER_PAGE) || 20,
      alpha: 0.65
    });

    renderResults(json, trimmed);
  }

  // ---------- boot ----------
  async function boot() {
    const $ = await waitForjQuery();

    // Load recent bills rail
    try {
      const recent = await fetchRecentBills((window.APP_CONFIG && APP_CONFIG.RECENT_BILLS_LIMIT) || 12);
      renderRecentBills(recent);
    } catch (e) {
      console.warn("Recent bills failed:", e);
    }

    // Bind form
    const $form = $("#mainSearchForm");
    const $input = $("#mainSearchInput");

    if ($form.length && $input.length) {
      $form.on("submit", async function (ev) {
        ev.preventDefault();
        try {
          await runSearch($input.val());
        } catch (e) {
          console.error(e);
          $("#results").html(`<div class="muted">Search failed. Check console for details.</div>`);
        }
      });
    }

    // Optional: auto-run if ?q=
    const qParam = window.utils?.getParam?.("q");
    if (qParam && $input.length) {
      $input.val(qParam);
      try {
        await runSearch(qParam);
      } catch (e) {
        console.error(e);
      }
    }
  }

  // Use your global helper from app.js
  if (window.onReady) window.onReady(boot);
  else document.addEventListener("DOMContentLoaded", boot);
})();
