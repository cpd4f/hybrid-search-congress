/* ---------------------------------------------------
   AI SEARCH (Typesense hybrid vector search via Workers)
   - Recent bills: GET /collections/:collection/documents/search (small query)
   - Facet preload: GET /collections/:collection/documents/search (per_page=0 + facet_by)
   - Search: POST /multi_search (vector payload in body + filter_by)
   - OpenAI:
       - embeddings: POST /embeddings
       - answer: POST /responses
   - Retains AI Answer panel + follow-up + refresh summary
   - Adds Filters:
       Chamber, Committee, Policy area, Sponsor party (AP style labels),
       Status, Updated range
--------------------------------------------------- */

(function () {
  "use strict";

  // Workers (retain your working hardcoded values)
  const TYPESENSE_WORKER_BASE = "https://typesense-proxy-worker.colemandavis4.workers.dev";
  const OPENAI_WORKER_BASE = "https://openai-proxy-worker.colemandavis4.workers.dev";

  // Collection
  const COLLECTION =
    (window.APP_CONFIG && window.APP_CONFIG.TYPESENSE_INDEX) ||
    "congress_bills";

  // Models / tuning
  const EMBED_MODEL =
    (window.APP_CONFIG && window.APP_CONFIG.OPENAI_EMBED_MODEL) ||
    "text-embedding-3-large";

  const ANSWER_MODEL =
    (window.APP_CONFIG && window.APP_CONFIG.OPENAI_ANSWER_MODEL) ||
    "gpt-4o-mini";

  const EXPECTED_EMBED_DIMS = 3072;

  const RECENT_LIMIT =
    (window.APP_CONFIG && window.APP_CONFIG.RECENT_BILLS_LIMIT) ||
    12;

  const RESULTS_PER_PAGE =
    (window.APP_CONFIG && window.APP_CONFIG.RESULTS_PER_PAGE) ||
    20;

  const DEFAULT_ALPHA =
    (window.APP_CONFIG && window.APP_CONFIG.HYBRID_ALPHA) ||
    0.65;

  const ANSWER_SOURCES_LIMIT =
    (window.APP_CONFIG && window.APP_CONFIG.ANSWER_SOURCES_LIMIT) ||
    8;

  // Filter facet caps
  const MAX_FACET_VALUES = 250; // committees can be long
  const MAX_COMMITTEES = 250;
  const MAX_POLICY = 120;
  const MAX_STATUS = 80;

  // Endpoints (retain your working routes)
  const TS_DOCS_SEARCH =
    `${TYPESENSE_WORKER_BASE.replace(/\/$/, "")}/collections/${encodeURIComponent(COLLECTION)}/documents/search`;

  const TS_MULTI_SEARCH =
    `${TYPESENSE_WORKER_BASE.replace(/\/$/, "")}/multi_search`;

  const OA_EMBED_URL =
    `${OPENAI_WORKER_BASE.replace(/\/$/, "")}/embeddings`;

  const OA_RESPONSES_URL =
    `${OPENAI_WORKER_BASE.replace(/\/$/, "")}/responses`;

  /* ---------------- helpers ---------------- */

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

  // For Typesense filter_by string values: always quote + escape
  function escFilterVal(v) {
    const s = String(v ?? "");
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  function epochToDate(epochSeconds) {
    if (!epochSeconds) return "";
    const d = new Date(epochSeconds * 1000);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function epochSecondsDaysAgo(days) {
    const ms = Date.now() - days * 24 * 60 * 60 * 1000;
    return Math.floor(ms / 1000);
  }

  function sponsorDotClass(party) {
    const p = String(party || "").toUpperCase();
    if (p === "R") return "party-dot party-dot--r";
    if (p === "D") return "party-dot party-dot--d";
    if (p === "I") return "party-dot party-dot--i";
    return "party-dot party-dot--u";
  }

  function sponsorPartyLabel(party) {
    const p = String(party || "").toUpperCase();
    if (p === "R") return "Republican";
    if (p === "D") return "Democratic";
    if (p === "I") return "Independent";
    return party ? String(party) : "Unknown";
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

  function showResultsSection() {
    const section = document.getElementById("resultsSection");
    if (section && section.hasAttribute("hidden")) section.removeAttribute("hidden");
  }

  function setResultsCount(n) {
    const el = document.getElementById("resultsCount");
    if (el) el.textContent = String(n ?? 0);
  }

  function pickTopDocsForAnswer(hits, limit) {
    const docs = (hits || []).map(h => h.document).filter(Boolean);
    return docs.slice(0, Math.max(1, limit || 1));
  }

  function buildSourcesBundle(docs) {
    // Keep this compact (token-efficient)
    return docs.map((d, idx) => {
      const committees = Array.isArray(d.committees) ? d.committees.slice(0, 3) : [];
      const subjects = Array.isArray(d.subjects) ? d.subjects.slice(0, 8) : [];
      return {
        rank: idx + 1,
        id: d.id,
        bill: billShortId(d),
        title: d.title || "",
        chamber: d.chamber || "",
        congress: d.congress || "",
        updated: d.update_date ? epochToDate(d.update_date) : "",
        latest_action: d.latest_action_text || "",
        policy_area: d.policy_area || "",
        committees,
        subjects,
        ai_summary: d.ai_summary_text || ""
      };
    });
  }

  function parseTextToHtml(text) {
    // Safe-ish rendering: escape then do minimal formatting.
    const raw = String(text || "");
    const escaped = escHtml(raw);

    // Convert simple bullet lines to <ul>
    const lines = escaped.split(/\r?\n/);
    const out = [];
    let inList = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const isBullet = trimmed.startsWith("- ") || trimmed.startsWith("• ");

      if (isBullet) {
        if (!inList) {
          out.push("<ul style=\"margin:10px 0 0 18px; padding:0;\">");
          inList = true;
        }
        out.push(`<li style="margin:6px 0; color: var(--color-text);">${trimmed.replace(/^(- |• )/, "")}</li>`);
      } else {
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
        if (trimmed.length) {
          out.push(`<p style="margin:10px 0; color: var(--color-text); line-height:1.5;">${line}</p>`);
        }
      }
    }

    if (inList) out.push("</ul>");
    return out.join("");
  }

  function titleCaseFromToken(s) {
    const t = String(s || "").replace(/_/g, " ").trim();
    if (!t) return "";
    return t.split(/\s+/).map(w => w.slice(0, 1).toUpperCase() + w.slice(1)).join(" ");
  }

  /* ---------------- Filter State ---------------- */

  const filterState = {
    chamber: new Set(),
    committees: new Set(),
    policy_area: new Set(),
    sponsor_party: new Set(),  // values: R/D/I
    status: new Set(),
    update_range: "all"        // single select: 7d/30d/90d/365d/all
  };

  const facetOptions = {
    chamber: [],       // {value,label,count}
    committees: [],
    policy_area: [],
    sponsor_party: [
      { value: "R", label: "Republican", count: 0 },
      { value: "D", label: "Democratic", count: 0 },
      { value: "I", label: "Independent", count: 0 }
    ],
    status: [],
    update_range: [
      { value: "7d", label: "Past 7 days" },
      { value: "30d", label: "Past 30 days" },
      { value: "90d", label: "Past 90 days" },
      { value: "365d", label: "Past year" },
      { value: "all", label: "All time" }
    ]
  };

  function buildFilterBy() {
    const parts = [];

    const chambers = Array.from(filterState.chamber);
    if (chambers.length) parts.push(`chamber:=[${chambers.map(escFilterVal).join(",")}]`);

    const committees = Array.from(filterState.committees);
    if (committees.length) parts.push(`committees:=[${committees.map(escFilterVal).join(",")}]`);

    const policy = Array.from(filterState.policy_area);
    if (policy.length) parts.push(`policy_area:=[${policy.map(escFilterVal).join(",")}]`);

    const party = Array.from(filterState.sponsor_party);
    if (party.length) parts.push(`sponsor_party:=[${party.map(escFilterVal).join(",")}]`);

    const status = Array.from(filterState.status);
    if (status.length) parts.push(`status:=[${status.map(escFilterVal).join(",")}]`);

    // update range (single)
    const r = String(filterState.update_range || "all");
    if (r !== "all") {
      if (r === "7d") parts.push(`update_date:>=${epochSecondsDaysAgo(7)}`);
      if (r === "30d") parts.push(`update_date:>=${epochSecondsDaysAgo(30)}`);
      if (r === "90d") parts.push(`update_date:>=${epochSecondsDaysAgo(90)}`);
      if (r === "365d") parts.push(`update_date:>=${epochSecondsDaysAgo(365)}`);
    }

    return parts.join(" && ");
  }

  /* ---------------- Filter UI (dropdown multi-check) ---------------- */

  function ensureFiltersUI() {
    const mount = document.getElementById("filtersMount");
    if (!mount) return;

    if (mount.getAttribute("data-filters-built") === "1") return;
    mount.setAttribute("data-filters-built", "1");

    mount.innerHTML = `
      <div class="filters">
        ${renderDropdown("chamber", "Chamber")}
        ${renderDropdown("committees", "Committee")}
        ${renderDropdown("policy_area", "Policy area")}
        ${renderDropdown("sponsor_party", "Sponsor party")}
        ${renderDropdown("status", "Status")}
        ${renderDropdown("update_range", "Updated")}

        <div class="filters__actions">
          <button type="button" class="filters__clear" id="clearFiltersBtn">Clear filters</button>
        </div>
      </div>
    `;

    // Toggle open/close
    mount.addEventListener("click", function (ev) {
      const toggle = ev.target.closest(".filter-dd__toggle");
      if (toggle) {
        ev.preventDefault();
        ev.stopPropagation();
        const dd = toggle.closest(".filter-dd");
        if (!dd) return;
        const open = dd.classList.contains("is-open");
        closeAllDropdowns(mount);
        if (!open) dd.classList.add("is-open");
        return;
      }
    });

    // Click outside closes dropdowns
    document.addEventListener("click", function (ev) {
      const inFilters = ev.target && ev.target.closest && ev.target.closest("#filtersMount");
      if (!inFilters) closeAllDropdowns(mount);
    });

    // Change events (checkbox/radio)
    mount.addEventListener("change", function (ev) {
      const inp = ev.target;
      if (!(inp instanceof HTMLInputElement)) return;

      const key = inp.getAttribute("data-filter-key");
      if (!key) return;

      const val = inp.value;

      if (key === "update_range") {
        filterState.update_range = val || "all";
        // keep radios synced visually
        syncDropdown("update_range");
      } else {
        const set = filterState[key];
        if (set && set instanceof Set) {
          if (inp.checked) set.add(val);
          else set.delete(val);
        }
      }

      updateBadge(key);
      // Run search only if we’ve already run at least one search OR user has a query in box
      // (This preserves old behavior but makes filters feel responsive.)
      triggerSearchFromUI();
    });

    // Clear
    const clearBtn = document.getElementById("clearFiltersBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        filterState.chamber.clear();
        filterState.committees.clear();
        filterState.policy_area.clear();
        filterState.sponsor_party.clear();
        filterState.status.clear();
        filterState.update_range = "all";

        syncAllDropdowns();
        updateAllBadges();
        triggerSearchFromUI();
      });
    }

    // Initial render (options may be empty until facet preload)
    renderDropdownOptions("chamber");
    renderDropdownOptions("committees");
    renderDropdownOptions("policy_area");
    renderDropdownOptions("sponsor_party");
    renderDropdownOptions("status");
    renderDropdownOptions("update_range");

    updateAllBadges();
  }

  function closeAllDropdowns(mount) {
    mount.querySelectorAll(".filter-dd").forEach(dd => dd.classList.remove("is-open"));
  }

  function renderDropdown(key, label) {
    return `
      <div class="filter-dd" data-key="${escHtml(key)}">
        <button type="button" class="filter-dd__toggle">
          <span class="filter-dd__label">${escHtml(label)}</span>
          <span class="filter-dd__badge" data-badge="${escHtml(key)}"></span>
          <span class="filter-dd__chev">▾</span>
        </button>
        <div class="filter-dd__panel">
          <div class="filter-dd__body" data-options="${escHtml(key)}">
            <div class="muted">Loading…</div>
          </div>
        </div>
      </div>
    `;
  }

  function renderDropdownOptions(key) {
    const body = document.querySelector(`[data-options="${CSS.escape(key)}"]`);
    if (!body) return;

    const options = facetOptions[key] || [];

    // Update range is always available
    if (key === "update_range") {
      body.innerHTML = options.map((o, idx) => {
        const id = `f-${key}-${idx}`;
        const checked = (filterState.update_range === o.value);
        return `
          <label class="filter-opt" for="${escHtml(id)}">
            <input
              id="${escHtml(id)}"
              type="radio"
              name="f-${escHtml(key)}"
              data-filter-key="${escHtml(key)}"
              value="${escHtml(o.value)}"
              ${checked ? "checked" : ""}
            />
            <span class="filter-opt__text">${escHtml(o.label)}</span>
          </label>
        `;
      }).join("");
      updateBadge(key);
      return;
    }

    if (!options.length) {
      body.innerHTML = `<div class="muted">No options yet.</div>`;
      updateBadge(key);
      return;
    }

    body.innerHTML = options.map((o, idx) => {
      const id = `f-${key}-${idx}`;
      const checked =
        key === "sponsor_party"
          ? filterState.sponsor_party.has(String(o.value))
          : (filterState[key] && filterState[key].has(String(o.value)));

      const label = o.label || o.value;
      const count = Number.isFinite(o.count) && o.count > 0 ? ` <span class="filter-opt__count">(${o.count})</span>` : "";

      return `
        <label class="filter-opt" for="${escHtml(id)}">
          <input
            id="${escHtml(id)}"
            type="checkbox"
            data-filter-key="${escHtml(key)}"
            value="${escHtml(String(o.value))}"
            ${checked ? "checked" : ""}
          />
          <span class="filter-opt__text">${escHtml(label)}${count}</span>
        </label>
      `;
    }).join("");

    updateBadge(key);
  }

  function syncDropdown(key) {
    const body = document.querySelector(`[data-options="${CSS.escape(key)}"]`);
    if (!body) return;

    const inputs = body.querySelectorAll(`input[data-filter-key="${CSS.escape(key)}"]`);
    inputs.forEach(inp => {
      const v = inp.value;
      if (key === "update_range") {
        inp.checked = (filterState.update_range === v);
      } else if (key === "sponsor_party") {
        inp.checked = filterState.sponsor_party.has(v);
      } else {
        const set = filterState[key];
        inp.checked = set && set.has(v);
      }
    });

    updateBadge(key);
  }

  function syncAllDropdowns() {
    ["chamber", "committees", "policy_area", "sponsor_party", "status", "update_range"].forEach(syncDropdown);
  }

  function updateBadge(key) {
    const badge = document.querySelector(`[data-badge="${CSS.escape(key)}"]`);
    if (!badge) return;

    if (key === "update_range") {
      const opt = facetOptions.update_range.find(x => x.value === filterState.update_range);
      badge.textContent = opt ? opt.label : "All time";
      badge.classList.add("is-on");
      return;
    }

    const set =
      key === "sponsor_party"
        ? filterState.sponsor_party
        : filterState[key];

    const count = set ? set.size : 0;
    if (!count) {
      badge.textContent = "";
      badge.classList.remove("is-on");
      return;
    }

    badge.textContent = count === 1 ? "1 selected" : `${count} selected`;
    badge.classList.add("is-on");
  }

  function updateAllBadges() {
    ["chamber", "committees", "policy_area", "sponsor_party", "status", "update_range"].forEach(updateBadge);
  }

  function triggerSearchFromUI() {
    // If user has something typed, run search.
    // If nothing typed but filters changed, we still run a browse search with q="*"
    const input = document.getElementById("mainSearchInput");
    const query = input ? String(input.value || "").trim() : "";
    runSearch(query || "*").catch(e => console.error(e));
  }

  /* ---------------- Typesense facet preload (GET) ---------------- */

  function countsToOptions(counts, limit, transformLabelFn) {
    const arr = (counts || [])
      .map(c => ({
        value: String(c.value ?? ""),
        label: transformLabelFn ? transformLabelFn(String(c.value ?? "")) : String(c.value ?? ""),
        count: Number(c.count ?? 0)
      }))
      .filter(x => x.value && x.value !== "null" && x.value !== "undefined")
      .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label))
      .slice(0, limit || 100);

    return arr;
  }

  async function preloadFacets() {
    // This request is cheap: per_page=0 but returns facet counts.
    const params = new URLSearchParams({
      q: "*",
      query_by: "title",
      per_page: "0",
      page: "1",
      facet_by: "chamber,committees,policy_area,status,sponsor_party",
      max_facet_values: String(MAX_FACET_VALUES),
      include_fields: "id",
      exclude_fields: "embedding"
    });

    const url = `${TS_DOCS_SEARCH}?${params.toString()}`;
    const res = await fetch(url, { method: "GET" });

    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Facet preload failed HTTP ${res.status}: ${txt}`);
    }

    const json = await res.json();
    const facet = json?.facet_counts || [];

    const map = {};
    facet.forEach(f => { map[f.field_name] = f.counts || []; });

    // chamber
    facetOptions.chamber = countsToOptions(map.chamber, 10, (v) => v);
    // committees
    facetOptions.committees = countsToOptions(map.committees, MAX_COMMITTEES, (v) => v);
    // policy
    facetOptions.policy_area = countsToOptions(map.policy_area, MAX_POLICY, (v) => v);
    // status
    facetOptions.status = countsToOptions(map.status, MAX_STATUS, (v) => titleCaseFromToken(v));
    // sponsor_party: keep AP labels and only include values we actually have
    const partyCounts = countsToOptions(map.sponsor_party, 10, (v) => sponsorPartyLabel(v));
    // overwrite counts for R/D/I when present, and append other party values if any
    const fixed = [
      { value: "R", label: "Republican", count: 0 },
      { value: "D", label: "Democratic", count: 0 },
      { value: "I", label: "Independent", count: 0 }
    ];
    const seen = new Set(fixed.map(x => x.value));
    partyCounts.forEach(p => {
      const pv = String(p.value).toUpperCase();
      const idx = fixed.findIndex(x => x.value === pv);
      if (idx >= 0) fixed[idx].count = p.count;
      else if (!seen.has(pv)) {
        fixed.push({ value: pv, label: sponsorPartyLabel(pv), count: p.count });
        seen.add(pv);
      }
    });
    facetOptions.sponsor_party = fixed;

    // render options into dropdowns if UI exists
    renderDropdownOptions("chamber");
    renderDropdownOptions("committees");
    renderDropdownOptions("policy_area");
    renderDropdownOptions("status");
    renderDropdownOptions("sponsor_party");
    renderDropdownOptions("update_range");

    syncAllDropdowns();
    updateAllBadges();
  }

  /* ---------------- OpenAI embeddings ---------------- */

  async function embedQuery(q) {
    const res = await fetch(OA_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  /* ---------------- OpenAI answer generation ---------------- */

  async function generateAnswer({ userQuestion, primaryQuery, sources }) {
    const systemStyle = [
      "You are a helpful legislative search assistant.",
      "Answer in plain English.",
      "Be concise and practical.",
      "Do not invent facts not supported by the provided sources.",
      "If the user asks something that cannot be answered from the sources, say what’s missing and suggest a better query.",
      "Prefer short paragraphs and bullets."
    ].join(" ");

    const prompt = [
      `SEARCH QUERY: ${primaryQuery}`,
      userQuestion && userQuestion !== primaryQuery ? `FOLLOW-UP QUESTION: ${userQuestion}` : "",
      "",
      "SOURCES (ranked search hits, limited fields):",
      JSON.stringify(sources, null, 2),
      "",
      "TASK:",
      "1) Provide a short answer (2–4 sentences).",
      "2) Provide 3–6 bullet points that reference specific bills by bill code (e.g., HR 123) when possible.",
      "3) Add a “Sources” line listing the bill codes you relied on.",
      "",
      "Return text only (no markdown tables)."
    ].filter(Boolean).join("\n");

    const res = await fetch(OA_RESPONSES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ANSWER_MODEL,
        input: [
          { role: "system", content: systemStyle },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_output_tokens: 450
      })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Answer failed HTTP ${res.status}: ${txt}`);
    }

    const json = await res.json();
    const text =
      json?.output_text ||
      json?.output?.[0]?.content?.[0]?.text ||
      json?.choices?.[0]?.message?.content ||
      "";

    if (!text) throw new Error("Answer response missing text");
    return text;
  }

  /* ---------------- Typesense recent bills (GET) ---------------- */

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

    const url = `${TS_DOCS_SEARCH}?${params.toString()}`;
    const res = await fetch(url, { method: "GET" });

    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Recent bills failed HTTP ${res.status}: ${txt}`);
    }

    return res.json();
  }

  /* ---------------- Typesense hybrid search (POST /multi_search) ---------------- */

  async function hybridSearchMulti({ q, vector, perPage = 20, page = 1, alpha = DEFAULT_ALPHA, filterBy = "" }) {
    const k = Math.max(80, perPage * 5);
    const vectorQuery = vector && vector.length
      ? `embedding:([${vector.join(",")}], k:${k}, alpha:${alpha})`
      : undefined;

    const searchObj = {
      collection: COLLECTION,
      q: q,
      query_by: "title,ai_summary_text,policy_area,subjects,committees,latest_action_text",
      per_page: perPage,
      page: page,
      sort_by: "_text_match:desc,update_date:desc",
      rerank_hybrid_matches: true,
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
        "latest_action_text",
        "status"
      ].join(","),
      exclude_fields: "embedding"
    };

    if (vectorQuery) searchObj.vector_query = vectorQuery;
    if (filterBy) searchObj.filter_by = filterBy;

    const body = { searches: [searchObj] };

    const res = await fetch(TS_MULTI_SEARCH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Search failed HTTP ${res.status}: ${txt}`);
    }

    const json = await res.json();
    const first = json?.results?.[0];
    if (!first) throw new Error("multi_search returned no results[]");
    return first;
  }

  /* ---------------- AI Answer UI ---------------- */

  function ensureAnswerUI() {
    const mount = document.getElementById("aiAnswer");
    if (!mount) return;

    if (mount.querySelector("[data-ai-answer-ui='1']")) return;

    mount.innerHTML = `
      <div data-ai-answer-ui="1">
        <div id="aiAnswerBody" class="muted" style="line-height:1.5;">
          Ask a question above to get a plain-English answer.
        </div>

        <div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap;">
          <button type="button" id="aiRefreshBtn" class="search__btn" style="padding:10px 14px;">
            Refresh summary
          </button>
        </div>

        <form id="aiFollowUpForm" style="margin-top:14px;">
          <div class="search__bar" style="border-radius:12px;">
            <input
              id="aiFollowUpInput"
              class="search__input"
              type="text"
              autocomplete="off"
              placeholder="Ask a follow-up question…"
              style="padding:14px 16px; font-size:15px;"
            />
            <button class="search__btn" type="submit" style="padding:0 16px;">
              Ask
            </button>
          </div>
          <div class="muted" style="margin-top:8px; font-size:12px;">
            Follow-ups use the current results as sources.
          </div>
        </form>

        <div id="aiSourcesLinks" style="margin-top:12px;"></div>
      </div>
    `;
  }

  function renderAnswerLoading(message) {
    ensureAnswerUI();

    const body = document.getElementById("aiAnswerBody");
    if (body) {
      body.innerHTML = `<div class="muted">${escHtml(message || "Generating answer…")}</div>`;
    }

    const links = document.getElementById("aiSourcesLinks");
    if (links) links.innerHTML = "";
  }

  function renderAnswerText(answerText, sourceDocs) {
    ensureAnswerUI();

    const body = document.getElementById("aiAnswerBody");

    if (body) {
      if (window.simpleMarkdownToHTML) {
        body.innerHTML = window.simpleMarkdownToHTML(answerText);
      } else {
        body.innerHTML = parseTextToHtml(answerText);
      }
    }

    const links = document.getElementById("aiSourcesLinks");

    if (links) {
      const items = (sourceDocs || [])
        .slice(0, ANSWER_SOURCES_LIMIT)
        .map(d => {
          const label = billShortId(d) || d.id;

          return `
            <a
              href="./bill.html?id=${encodeURIComponent(d.id)}"
              style="
                display:inline-block;
                margin:6px 8px 0 0;
                color:var(--color-primary);
                font-size:13px;
              "
            >
              ${escHtml(label)}
            </a>
          `;
        })
        .join("");

      links.innerHTML = items
        ? `<div class="muted" style="font-size:12px;margin-top:6px;">Source bills:</div>${items}`
        : "";
    }
  }

  function renderAnswerError(message) {
    ensureAnswerUI();

    const body = document.getElementById("aiAnswerBody");

    if (body) {
      body.innerHTML = `<div class="muted">${escHtml(message || "Could not generate an answer right now.")}</div>`;
    }

    const links = document.getElementById("aiSourcesLinks");
    if (links) links.innerHTML = "";
  }

  /* ---------------- render ---------------- */

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
            <span class="${dot}" aria-hidden="true" title="${escHtml(sponsorPartyLabel(d.sponsor_party))}"></span>

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

    $mount.html(html);
  }

  function renderResults(json, q) {
    const $mount = window.jQuery("#results");
    if (!$mount.length) return;

    const found = json?.found ?? 0;
    const hits = json?.hits || [];

    setResultsCount(found);

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
        const status = d.status ? titleCaseFromToken(d.status) : "";

        return `
          <div class="panel" style="margin-bottom:16px;">
            <div style="display:flex;align-items:center;gap:10px;justify-content:space-between;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="${dot}" aria-hidden="true" title="${escHtml(sponsorPartyLabel(d.sponsor_party))}"></span>
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
              ${status ? `<span class="chip">${escHtml(status)}</span>` : ""}
              ${d.sponsor_party ? `<span class="chip">${escHtml(sponsorPartyLabel(d.sponsor_party))}${d.sponsor_state ? " • " + escHtml(String(d.sponsor_state)) : ""}</span>` : ""}
              ${Number.isFinite(d.cosponsor_count) ? `<span class="chip">${escHtml(String(d.cosponsor_count))} cosponsors</span>` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    $mount.html(html);
  }

  /* ---------------- state (so follow-ups + refresh work) ---------------- */

  const state = {
    lastPrimaryQuery: "",
    lastHits: [],
    lastSourceDocs: []
  };

  async function runAnswerFlow({ primaryQuery, question, hits }) {
    ensureAnswerUI();

    const sourceDocs = pickTopDocsForAnswer(hits, ANSWER_SOURCES_LIMIT);
    const sourcesBundle = buildSourcesBundle(sourceDocs);

    state.lastPrimaryQuery = primaryQuery;
    state.lastHits = hits || [];
    state.lastSourceDocs = sourceDocs;

    renderAnswerLoading("Generating summary…");

    try {
      const answerText = await generateAnswer({
        userQuestion: question || primaryQuery,
        primaryQuery,
        sources: sourcesBundle
      });
      renderAnswerText(answerText, sourceDocs);
    } catch (e) {
      console.error(e);
      renderAnswerError("Could not generate a summary right now. Try refresh, or adjust your query.");
    }
  }

  /* ---------------- run search ---------------- */

  async function runSearch(q) {
    const raw = String(q || "").trim();

    // Behavior:
    // - If user typed nothing but filters are set, allow browse search with q="*"
    // - If truly nothing, do nothing (matches old behavior)
    const hasAnyFilters =
      filterState.chamber.size ||
      filterState.committees.size ||
      filterState.policy_area.size ||
      filterState.sponsor_party.size ||
      filterState.status.size ||
      (filterState.update_range && filterState.update_range !== "all");

    if (!raw && !hasAnyFilters) return;

    const query = raw ? raw : "*";

    showResultsSection();
    ensureAnswerUI();

    const $results = window.jQuery("#results");
    if ($results.length) $results.html(`<div class="muted">Searching…</div>`);

    renderAnswerLoading("Searching and generating summary…");

    // Build filter_by
    const filterBy = buildFilterBy();

    // 1) embed query (ONLY if not browsing)
    let vector = null;
    if (query !== "*") {
      vector = await embedQuery(query);
    }

    // 2) hybrid search
    const result = await hybridSearchMulti({
      q: query,
      vector: vector || [],
      perPage: RESULTS_PER_PAGE,
      page: 1,
      alpha: DEFAULT_ALPHA,
      filterBy: filterBy
    });

    // 3) render results
    renderResults(result, query);

    // 4) answer (only when user typed a real query)
    const hits = result?.hits || [];
    if (query === "*") {
      renderAnswerError("Tip: Type a keyword query to generate an AI summary. Browsing mode does not generate summaries.");
      // Still set state so refresh/follow-up works after a real search
      state.lastPrimaryQuery = "";
      state.lastHits = hits;
      state.lastSourceDocs = pickTopDocsForAnswer(hits, ANSWER_SOURCES_LIMIT);
      return;
    }

    await runAnswerFlow({ primaryQuery: query, question: query, hits });
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    const $ = await waitForjQuery();

    // Filters UI (safe even if #filtersMount missing)
    ensureFiltersUI();

    // preload facets (safe failure)
    try {
      await preloadFacets();
    } catch (e) {
      console.warn("Facet preload failed:", e);
      // leave dropdowns with “No options yet.” but keep everything else working
      renderDropdownOptions("chamber");
      renderDropdownOptions("committees");
      renderDropdownOptions("policy_area");
      renderDropdownOptions("status");
      renderDropdownOptions("sponsor_party");
      renderDropdownOptions("update_range");
      updateAllBadges();
    }

    // recent bills
    try {
      const recent = await fetchRecentBills(RECENT_LIMIT);
      renderRecentBills(recent);
    } catch (e) {
      console.error("Recent bills failed:", e);
      const $mount = $("#recentBills");
      if ($mount.length) $mount.html(`<div class="muted">Could not load recent bills.</div>`);
    }

    // ensure AI UI exists (even before first search)
    ensureAnswerUI();

    // bind search
    const $form = $("#mainSearchForm");
    const $input = $("#mainSearchInput");

    if ($form.length && $input.length) {
      $form.on("submit", async function (ev) {
        ev.preventDefault();
        try {
          await runSearch($input.val());
        } catch (e) {
          console.error(e);
          showResultsSection();
          $("#results").html(`<div class="muted">Search failed. Check console.</div>`);
          renderAnswerError("Search failed, so I couldn’t generate a summary. Try again.");
        }
      });
    }

    // bind refresh + follow-up handlers (delegated)
    document.addEventListener("click", async function (ev) {
      const t = ev.target;
      if (!(t instanceof Element)) return;

      if (t && t.id === "aiRefreshBtn") {
        if (!state.lastPrimaryQuery || !state.lastHits.length) {
          renderAnswerError("Run a search first, then refresh the summary.");
          return;
        }
        await runAnswerFlow({
          primaryQuery: state.lastPrimaryQuery,
          question: state.lastPrimaryQuery,
          hits: state.lastHits
        });
      }
    });

    document.addEventListener("submit", async function (ev) {
      const form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;

      if (form.id === "aiFollowUpForm") {
        ev.preventDefault();

        const input = document.getElementById("aiFollowUpInput");
        const follow = input ? String(input.value || "").trim() : "";

        if (!follow) return;

        if (!state.lastPrimaryQuery || !state.lastHits.length) {
          renderAnswerError("Run a search first, then ask a follow-up.");
          return;
        }

        await runAnswerFlow({
          primaryQuery: state.lastPrimaryQuery,
          question: follow,
          hits: state.lastHits
        });
      }
    });

    // auto-run ?q=
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
