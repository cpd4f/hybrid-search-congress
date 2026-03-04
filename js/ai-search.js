/* ---------------------------------------------------
   AI SEARCH (Typesense hybrid + OpenAI answer)
   - Adds dropdown multi-select filters:
     Chamber, Committee, Policy area, Sponsor party, Status, Update range
   - Builds Typesense filter_by string
   - Loads dynamic facet values from Typesense
--------------------------------------------------- */

(function () {
  "use strict";

  // ---------------------------
  // CONFIG (safe defaults)
  // ---------------------------
  const TYPESENSE_WORKER =
    window.TYPESENSE_WORKER_URL ||
    (window.API && window.API.TYPESENSE) ||
    "https://typesense-proxy-worker.colemandavis4.workers.dev";

  const OPENAI_WORKER =
    window.OPENAI_WORKER_URL ||
    (window.API && window.API.OPENAI) ||
    "https://openai-proxy-worker.colemandavis4.workers.dev";

  const COLLECTION =
    (window.APP_CONFIG && window.APP_CONFIG.TYPESENSE_INDEX) ||
    "congress_bills";

  const RESULTS_PER_PAGE =
    (window.APP_CONFIG && window.APP_CONFIG.RESULTS_PER_PAGE) || 20;

  const RECENT_BILLS_LIMIT =
    (window.APP_CONFIG && window.APP_CONFIG.RECENT_BILLS_LIMIT) || 12;

  const FACET_MAX_COMMITTEES = 250;
  const FACET_MAX_POLICY = 120;
  const FACET_MAX_STATUS = 50;

  const ANSWER_SOURCES_LIMIT = 8;

  // ---------------------------
  // DOM IDs (must match index.html)
  // ---------------------------
  const IDS = {
    form: "mainSearchForm",
    input: "mainSearchInput",
    resultsSection: "resultsSection",
    resultsCount: "resultsCount",
    resultsMount: "results",
    filtersMount: "filtersMount",
    clearFiltersBtn: "clearFiltersBtn",

    // Recent bills
    recentRail: "recentBills",

    // AI answer
    aiAnswerBody: "aiAnswerBody",
    aiSourcesLinks: "aiSourcesLinks",
    askFollowupForm: "aiFollowupForm",
    askFollowupInput: "aiFollowupInput",
    refreshAnswerBtn: "refreshAnswerBtn"
  };

  // ---------------------------
  // Utilities
  // ---------------------------
  function escHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function toTitleCase(s) {
    return String(s || "")
      .split(" ")
      .filter(Boolean)
      .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function epochSecondsDaysAgo(days) {
    const ms = Date.now() - days * 24 * 60 * 60 * 1000;
    return Math.floor(ms / 1000);
  }

  function formatEpoch(epoch) {
    if (!epoch || !Number.isFinite(epoch)) return "";
    const d = new Date(epoch * 1000);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  function normalizeParty(value) {
    const v = String(value || "").trim().toUpperCase();
    if (v === "D") return "D";
    if (v === "R") return "R";
    if (v === "I") return "I";
    return v || "";
  }

  function partyLabelAP(value) {
    const v = normalizeParty(value);
    if (v === "R") return "Republican";
    if (v === "D") return "Democratic";
    if (v === "I") return "Independent";
    return v || "Unknown";
  }

  function partyDotClass(value) {
    const v = normalizeParty(value);
    if (v === "R") return "party-dot--r";
    if (v === "D") return "party-dot--d";
    if (v === "I") return "party-dot--i";
    return "party-dot--u";
  }

  function billShortId(doc) {
    if (!doc) return "";
    const t = String(doc.type || "").toUpperCase();
    const num = doc.number != null ? String(doc.number) : "";
    if (t && num) return `${t}. ${num}`;
    return doc.id || "";
  }

  // Basic markdown-ish parsing (bold + line breaks) if markdown.js not present
  function parseTextToHtml(text) {
    if (window.markdownToHTML && typeof window.markdownToHTML === "function") {
      return window.markdownToHTML(String(text || ""));
    }
    const s = escHtml(String(text || "")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return s.replace(/\n/g, "<br/>");
  }

  // ---------------------------
  // HTTP helpers
  // ---------------------------
  async function fetchJson(url, { method = "GET", body = null, headers = {} } = {}) {
    const res = await fetch(url, {
      method,
      headers: { ...headers },
      body: body ? JSON.stringify(body) : null
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // ignore parse error
    }
    if (!res.ok) {
      const msg = data && (data.message || data.error) ? (data.message || data.error) : text;
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    return data;
  }

  async function typesenseSearch(payload) {
    const url = `${TYPESENSE_WORKER}/collections/${COLLECTION}/documents/search`;
    return fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
  }

  async function typesenseMultiSearch(payload) {
    const url = `${TYPESENSE_WORKER}/multi_search`;
    return fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
  }

  async function getEmbedding(query) {
    // Your OpenAI worker should accept POST with { input } and return { embedding } or OpenAI-like { data:[{embedding:[]}] }
    const resp = await fetchJson(OPENAI_WORKER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { input: String(query || "").trim() }
    });

    if (resp && Array.isArray(resp.embedding)) return resp.embedding;
    if (resp && resp.data && resp.data[0] && Array.isArray(resp.data[0].embedding)) return resp.data[0].embedding;

    throw new Error("Embedding missing from OpenAI worker response.");
  }

  // ---------------------------
  // Filter state
  // ---------------------------
  const FILTERS = {
    chamber: new Set(),
    committees: new Set(),
    policy_area: new Set(),
    sponsor_party: new Set(),
    status: new Set(),
    update_range: new Set() // store keys like "7d","30d","90d","365d","all"
  };

  const FILTER_META = {
    // options will be populated from facets
    chamber: [],
    committees: [],
    policy_area: [],
    sponsor_party: [
      { value: "R", label: "Republican" },
      { value: "D", label: "Democratic" },
      { value: "I", label: "Independent" }
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

  function setFromArray(setObj, arr) {
    setObj.clear();
    (arr || []).forEach((v) => setObj.add(String(v)));
  }

  function setToArray(setObj) {
    return Array.from(setObj.values());
  }

  // Update range: allow only ONE selection (keeps UX sane)
  function setUpdateRange(value) {
    FILTERS.update_range.clear();
    if (value) FILTERS.update_range.add(String(value));
  }

  function getUpdateRangeFilter() {
    const v = setToArray(FILTERS.update_range)[0] || "all";
    if (!v || v === "all") return null;
    if (v === "7d") return `update_date:>=${epochSecondsDaysAgo(7)}`;
    if (v === "30d") return `update_date:>=${epochSecondsDaysAgo(30)}`;
    if (v === "90d") return `update_date:>=${epochSecondsDaysAgo(90)}`;
    if (v === "365d") return `update_date:>=${epochSecondsDaysAgo(365)}`;
    return null;
  }

  function buildFilterBy() {
    const parts = [];

    const chambers = setToArray(FILTERS.chamber);
    if (chambers.length) parts.push(`chamber:=[${chambers.map(escFilterVal).join(",")}]`);

    const committees = setToArray(FILTERS.committees);
    if (committees.length) parts.push(`committees:=[${committees.map(escFilterVal).join(",")}]`);

    const policy = setToArray(FILTERS.policy_area);
    if (policy.length) parts.push(`policy_area:=[${policy.map(escFilterVal).join(",")}]`);

    const party = setToArray(FILTERS.sponsor_party);
    if (party.length) parts.push(`sponsor_party:=[${party.map(escFilterVal).join(",")}]`);

    const status = setToArray(FILTERS.status);
    if (status.length) parts.push(`status:=[${status.map(escFilterVal).join(",")}]`);

    const dateClause = getUpdateRangeFilter();
    if (dateClause) parts.push(dateClause);

    return parts.join(" && ");
  }

  // Typesense filter_by values need quoting if they include spaces or punctuation.
  function escFilterVal(v) {
    const s = String(v);
    // Quote everything to be safe (Typesense supports quoted strings).
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  // ---------------------------
  // Filter UI (dropdown multi-check)
  // ---------------------------
  function ensureFiltersUI() {
    const mount = document.getElementById(IDS.filtersMount);
    if (!mount) return;

    // Build UI once
    if (mount.getAttribute("data-built") === "1") return;
    mount.setAttribute("data-built", "1");

    mount.innerHTML = `
      <div class="filters-grid">

        ${renderDropdown("chamber", "Chamber")}
        ${renderDropdown("committees", "Committee")}
        ${renderDropdown("policy_area", "Policy area")}
        ${renderDropdown("sponsor_party", "Sponsor party")}
        ${renderDropdown("status", "Status")}
        ${renderDropdown("update_range", "Updated")}

        <div class="filters-actions">
          <button type="button" class="btn btn--ghost" id="${IDS.clearFiltersBtn}">Clear filters</button>
        </div>

      </div>
    `;

    // Global click to close dropdowns
    document.addEventListener("click", function (e) {
      const dd = e.target.closest(".filter-dd");
      document.querySelectorAll(".filter-dd").forEach((node) => {
        if (dd && node === dd) return;
        node.classList.remove("is-open");
      });
    });

    // Bind dropdown toggles
    document.querySelectorAll(".filter-dd__toggle").forEach((btn) => {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        const root = btn.closest(".filter-dd");
        if (!root) return;
        const isOpen = root.classList.contains("is-open");
        document.querySelectorAll(".filter-dd").forEach((n) => n.classList.remove("is-open"));
        if (!isOpen) root.classList.add("is-open");
      });
    });

    // Clear
    const clearBtn = document.getElementById(IDS.clearFiltersBtn);
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        Object.keys(FILTERS).forEach((k) => FILTERS[k].clear());
        // Default update_range to "all"
        setUpdateRange("all");
        syncAllDropdownChecks();
        runSearch();
      });
    }

    // Default update_range
    if (!FILTERS.update_range.size) setUpdateRange("all");

    // Initial render of checkbox lists
    updateDropdownOptions("sponsor_party");
    updateDropdownOptions("update_range");

    // The rest (committees/policy/status/chamber) will populate from facets later
    updateDropdownBadgeAll();
  }

  function renderDropdown(key, label) {
    return `
      <div class="filter-dd" data-key="${escHtml(key)}">
        <button type="button" class="filter-dd__toggle" aria-haspopup="true" aria-expanded="false">
          <span class="filter-dd__label">${escHtml(label)}</span>
          <span class="filter-dd__badge" data-badge="${escHtml(key)}"></span>
          <span class="filter-dd__chev" aria-hidden="true">▾</span>
        </button>
        <div class="filter-dd__panel" role="menu" aria-label="${escHtml(label)} options">
          <div class="filter-dd__body" data-options="${escHtml(key)}">
            <div class="muted">Loading…</div>
          </div>
        </div>
      </div>
    `;
  }

  function updateDropdownOptions(key) {
    const body = document.querySelector(`[data-options="${CSS.escape(key)}"]`);
    if (!body) return;

    const options = FILTER_META[key] || [];
    if (!options.length) {
      body.innerHTML = `<div class="muted">No options yet.</div>`;
      updateDropdownBadge(key);
      return;
    }

    body.innerHTML = options
      .map((opt, idx) => {
        const value = String(opt.value);
        const label = String(opt.label || opt.value);
        const id = `dd-${key}-${idx}-${value.replace(/[^a-z0-9]/gi, "_")}`;
        const checked = FILTERS[key] && FILTERS[key].has(value);

        // update_range: allow only one selection
        const type = key === "update_range" ? "radio" : "checkbox";

        return `
          <label class="filter-opt" for="${escHtml(id)}">
            <input
              id="${escHtml(id)}"
              type="${type}"
              name="dd-${escHtml(key)}"
              data-filter-key="${escHtml(key)}"
              value="${escHtml(value)}"
              ${checked ? "checked" : ""}
            />
            <span class="filter-opt__text">${escHtml(label)}</span>
          </label>
        `;
      })
      .join("");

    // Bind change events
    body.querySelectorAll(`input[data-filter-key="${CSS.escape(key)}"]`).forEach((inp) => {
      inp.addEventListener("change", function () {
        const k = inp.getAttribute("data-filter-key");
        const v = inp.value;

        if (k === "update_range") {
          setUpdateRange(v);
          // keep radios in sync
          syncDropdownChecks("update_range");
        } else {
          if (inp.checked) FILTERS[k].add(v);
          else FILTERS[k].delete(v);
        }

        updateDropdownBadge(k);
        runSearch();
      });
    });

    updateDropdownBadge(key);
  }

  function syncDropdownChecks(key) {
    const body = document.querySelector(`[data-options="${CSS.escape(key)}"]`);
    if (!body) return;
    body.querySelectorAll(`input[data-filter-key="${CSS.escape(key)}"]`).forEach((inp) => {
      const v = inp.value;
      inp.checked = key === "update_range" ? FILTERS.update_range.has(v) : (FILTERS[key] && FILTERS[key].has(v));
    });
    updateDropdownBadge(key);
  }

  function syncAllDropdownChecks() {
    Object.keys(FILTERS).forEach((k) => syncDropdownChecks(k));
  }

  function updateDropdownBadge(key) {
    const badge = document.querySelector(`[data-badge="${CSS.escape(key)}"]`);
    if (!badge) return;

    const count = key === "update_range"
      ? (FILTERS.update_range.size ? 1 : 0)
      : (FILTERS[key] ? FILTERS[key].size : 0);

    if (!count) {
      badge.textContent = "";
      badge.classList.remove("is-on");
      return;
    }

    // For update range, show selected label
    if (key === "update_range") {
      const v = setToArray(FILTERS.update_range)[0] || "all";
      const opt = (FILTER_META.update_range || []).find((x) => String(x.value) === v);
      badge.textContent = opt ? opt.label : "Updated";
      badge.classList.add("is-on");
      return;
    }

    badge.textContent = count === 1 ? "1 selected" : `${count} selected`;
    badge.classList.add("is-on");
  }

  function updateDropdownBadgeAll() {
    Object.keys(FILTERS).forEach((k) => updateDropdownBadge(k));
  }

  // ---------------------------
  // Facet loading
  // ---------------------------
  function facetsToOptions(facetCounts, maxValues) {
    const arr = (facetCounts || [])
      .map((x) => ({
        value: String(x.value),
        label: String(x.value),
        count: Number(x.count || 0)
      }))
      .filter((x) => x.value && x.value !== "undefined" && x.value !== "null")
      .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label))
      .slice(0, maxValues || 100);

    return arr;
  }

  async function loadFacetOptions() {
    // Pull facets without a search term (q="*") so filters can render before first search
    const payload = {
      q: "*",
      query_by: "title,ai_summary_text",
      per_page: 0,
      facet_by: "chamber,committees,policy_area,status,sponsor_party",
      max_facet_values: Math.max(FACET_MAX_COMMITTEES, FACET_MAX_POLICY, FACET_MAX_STATUS),
      include_fields: "id"
    };

    const res = await typesenseSearch(payload);
    const facet = (res && res.facet_counts) ? res.facet_counts : [];

    const map = {};
    facet.forEach((f) => {
      map[f.field_name] = f.counts || [];
    });

    FILTER_META.chamber = facetsToOptions(map.chamber, 10).map((o) => ({
      value: o.value,
      label: o.value
    }));

    FILTER_META.committees = facetsToOptions(map.committees, FACET_MAX_COMMITTEES).map((o) => ({
      value: o.value,
      label: o.value
    }));

    FILTER_META.policy_area = facetsToOptions(map.policy_area, FACET_MAX_POLICY).map((o) => ({
      value: o.value,
      label: o.value
    }));

    FILTER_META.status = facetsToOptions(map.status, FACET_MAX_STATUS).map((o) => ({
      value: o.value,
      label: toTitleCase(o.value.replace(/_/g, " "))
    }));

    // sponsor_party is already set to AP style labels; but if your data contains more than D/R/I, include those too
    const seen = new Set(FILTER_META.sponsor_party.map((x) => x.value));
    facetsToOptions(map.sponsor_party, 10).forEach((o) => {
      const v = normalizeParty(o.value);
      if (v && !seen.has(v)) {
        seen.add(v);
        FILTER_META.sponsor_party.push({ value: v, label: partyLabelAP(v) });
      }
    });

    // Render dropdown lists
    updateDropdownOptions("chamber");
    updateDropdownOptions("committees");
    updateDropdownOptions("policy_area");
    updateDropdownOptions("status");
    updateDropdownOptions("sponsor_party");
    updateDropdownOptions("update_range");
  }

  // ---------------------------
  // Recent bills
  // ---------------------------
  async function fetchRecentBills() {
    const rail = document.getElementById(IDS.recentRail);
    if (!rail) return;

    // Keep a placeholder
    rail.innerHTML = `<div class="muted" style="padding:12px;">Loading…</div>`;

    // q="*" requires query_by
    const payload = {
      q: "*",
      query_by: "title",
      sort_by: "update_date:desc",
      per_page: RECENT_BILLS_LIMIT,
      include_fields: "id,type,number,title,committees,status,update_date,sponsor_party,policy_area"
    };

    const res = await typesenseSearch(payload);
    const hits = (res && res.hits) ? res.hits : [];

    if (!hits.length) {
      rail.innerHTML = `<div class="muted" style="padding:12px;">No recent bills found.</div>`;
      return;
    }

    rail.innerHTML = hits
      .map((h) => h.document)
      .map((d) => renderBillCard(d))
      .join("");

    // If your app.js wraps cards into pages, this MutationObserver will rebuild automatically.
  }

  function renderBillCard(doc) {
    const id = doc.id || "";
    const short = billShortId(doc) || id;
    const title = doc.title || "";
    const status = doc.status ? toTitleCase(String(doc.status).replace(/_/g, " ")) : "";
    const committees = Array.isArray(doc.committees) ? doc.committees : [];
    const committeeText = committees.length ? committees[0] : (doc.policy_area ? doc.policy_area : "");
    const update = doc.update_date ? `Updated ${formatEpoch(Number(doc.update_date))}` : "";
    const party = doc.sponsor_party || "";

    return `
      <a class="billcard" href="./bill.html?id=${encodeURIComponent(id)}">
        <span class="party-dot ${partyDotClass(party)}"
          title="Sponsor: ${escHtml(partyLabelAP(party))}"
          aria-label="Sponsor party ${escHtml(partyLabelAP(party))}"></span>

        <div class="billcard__meta">
          <div class="billcard__id">${escHtml(short)}</div>
          <div class="billcard__status">${escHtml(status || "Bill")}</div>
        </div>

        <div class="billcard__title">${escHtml(title)}</div>

        <div class="billcard__footer">
          <div class="billcard__committee" title="Committee">${escHtml(committeeText || "")}</div>
          <div class="billcard__date" title="Updated">${escHtml(update || "")}</div>
        </div>
      </a>
    `;
  }

  // ---------------------------
  // Results + AI Answer UI
  // ---------------------------
  function showResultsSection() {
    const sec = document.getElementById(IDS.resultsSection);
    if (sec) sec.hidden = false;
  }

  function setResultsCount(n) {
    const el = document.getElementById(IDS.resultsCount);
    if (el) el.textContent = String(n || 0);
  }

  function renderResults(docs) {
    const mount = document.getElementById(IDS.resultsMount);
    if (!mount) return;

    if (!docs || !docs.length) {
      mount.innerHTML = `<div class="muted">No matches.</div>`;
      return;
    }

    mount.innerHTML = docs.map(renderResultRow).join("");
  }

  function renderResultRow(doc) {
    const id = doc.id || "";
    const short = billShortId(doc) || id;
    const title = doc.title || "";
    const status = doc.status ? toTitleCase(String(doc.status).replace(/_/g, " ")) : "";
    const party = doc.sponsor_party || "";
    const policy = doc.policy_area || "";
    const committees = Array.isArray(doc.committees) ? doc.committees : [];
    const committeeText = committees.length ? committees.slice(0, 2).join("; ") : "";
    const update = doc.update_date ? formatEpoch(Number(doc.update_date)) : "";

    return `
      <a class="result" href="./bill.html?id=${encodeURIComponent(id)}">
        <div class="result__head">
          <div class="result__id">${escHtml(short)}</div>
          <div class="result__meta">
            <span class="chip">${escHtml(partyLabelAP(party))}</span>
            ${status ? `<span class="chip">${escHtml(status)}</span>` : ""}
            ${policy ? `<span class="chip">${escHtml(policy)}</span>` : ""}
          </div>
        </div>

        <div class="result__title">${escHtml(title)}</div>

        <div class="result__sub">
          ${committeeText ? `<div class="muted">${escHtml(committeeText)}</div>` : ""}
          ${update ? `<div class="muted">Updated ${escHtml(update)}</div>` : ""}
        </div>
      </a>
    `;
  }

  function ensureAnswerUI() {
    // Assumes index.html already contains aiAnswerBody + aiSourcesLinks
    const body = document.getElementById(IDS.aiAnswerBody);
    if (body && !body.innerHTML.trim()) {
      body.innerHTML = `<div class="muted">Ask a question above to get a plain-English answer.</div>`;
    }
  }

  function renderAnswerLoading(message) {
    ensureAnswerUI();
    const body = document.getElementById(IDS.aiAnswerBody);
    if (body) body.innerHTML = `<div class="muted">${escHtml(message || "Generating answer…")}</div>`;
    const links = document.getElementById(IDS.aiSourcesLinks);
    if (links) links.innerHTML = "";
  }

  function renderAnswerText(answerText, sourceDocs) {
    ensureAnswerUI();
    const body = document.getElementById(IDS.aiAnswerBody);
    if (body) body.innerHTML = parseTextToHtml(answerText);

    const links = document.getElementById(IDS.aiSourcesLinks);
    if (links) {
      const items = (sourceDocs || []).slice(0, ANSWER_SOURCES_LIMIT).map((d) => {
        const label = billShortId(d) || d.id;
        return `<a class="source-link" href="./bill.html?id=${encodeURIComponent(d.id)}">${escHtml(label)}</a>`;
      }).join("");

      links.innerHTML = items
        ? `<div class="muted" style="font-size:12px;margin-top:10px;">Source bills:</div><div class="source-links">${items}</div>`
        : "";
    }
  }

  function renderAnswerError(message) {
    ensureAnswerUI();
    const body = document.getElementById(IDS.aiAnswerBody);
    if (body) body.innerHTML = `<div class="muted">${escHtml(message || "Could not generate an answer right now.")}</div>`;
    const links = document.getElementById(IDS.aiSourcesLinks);
    if (links) links.innerHTML = "";
  }

  // ---------------------------
  // Hybrid search (Typesense: keyword + vector)
  // ---------------------------
  async function hybridSearch(query) {
    const q = String(query || "").trim();
    const filter_by = buildFilterBy();

    // If query empty, still allow browsing via filters (use q="*")
    const keywordQ = q.length ? q : "*";

    // Build embeddings only when user actually typed something (saves cost)
    let embedding = null;
    if (q.length) {
      embedding = await getEmbedding(q);
      if (!Array.isArray(embedding) || !embedding.length) throw new Error("Embedding invalid.");
    }

    // Hybrid search in one request (Typesense supports q + vector_query together)
    // Also return facets so we can populate dropdowns with real values.
    const payload = {
      q: keywordQ,
      query_by: "title,ai_summary_text,subjects",
      per_page: RESULTS_PER_PAGE,
      sort_by: q.length ? undefined : "update_date:desc",
      filter_by: filter_by || undefined,

      // vector part
      vector_query: q.length ? `embedding:([${embedding.join(",")}], k: ${Math.max(60, RESULTS_PER_PAGE * 3)})` : undefined,

      // facets
      facet_by: "chamber,committees,policy_area,status,sponsor_party",
      max_facet_values: Math.max(FACET_MAX_COMMITTEES, FACET_MAX_POLICY, FACET_MAX_STATUS),

      include_fields: "id,type,number,title,committees,status,update_date,sponsor_party,policy_area,ai_summary_text",
      highlight_fields: "title,ai_summary_text"
    };

    // Strip undefined
    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const res = await typesenseSearch(payload);
    return res;
  }

  function updateFacetOptionsFromSearch(res) {
    const facet = (res && res.facet_counts) ? res.facet_counts : [];
    if (!facet.length) return;

    const map = {};
    facet.forEach((f) => { map[f.field_name] = f.counts || []; });

    // Only update these if we got data (avoid wiping options)
    if (map.chamber && map.chamber.length) {
      FILTER_META.chamber = facetsToOptions(map.chamber, 10).map((o) => ({ value: o.value, label: o.value }));
      updateDropdownOptions("chamber");
      syncDropdownChecks("chamber");
    }

    if (map.committees && map.committees.length) {
      FILTER_META.committees = facetsToOptions(map.committees, FACET_MAX_COMMITTEES).map((o) => ({ value: o.value, label: o.value }));
      updateDropdownOptions("committees");
      syncDropdownChecks("committees");
    }

    if (map.policy_area && map.policy_area.length) {
      FILTER_META.policy_area = facetsToOptions(map.policy_area, FACET_MAX_POLICY).map((o) => ({ value: o.value, label: o.value }));
      updateDropdownOptions("policy_area");
      syncDropdownChecks("policy_area");
    }

    if (map.status && map.status.length) {
      FILTER_META.status = facetsToOptions(map.status, FACET_MAX_STATUS).map((o) => ({
        value: o.value,
        label: toTitleCase(o.value.replace(/_/g, " "))
      }));
      updateDropdownOptions("status");
      syncDropdownChecks("status");
    }

    if (map.sponsor_party && map.sponsor_party.length) {
      const seen = new Set(FILTER_META.sponsor_party.map((x) => x.value));
      facetsToOptions(map.sponsor_party, 10).forEach((o) => {
        const v = normalizeParty(o.value);
        if (v && !seen.has(v)) {
          seen.add(v);
          FILTER_META.sponsor_party.push({ value: v, label: partyLabelAP(v) });
        }
      });
      updateDropdownOptions("sponsor_party");
      syncDropdownChecks("sponsor_party");
    }

    updateDropdownBadgeAll();
  }

  // ---------------------------
  // AI Answerer
  // ---------------------------
  async function generateAnswer(question, sourceDocs) {
    // Your OpenAI worker should accept { question, sources } or similar
    // We’ll send a compact payload that includes top docs' titles + summaries.
    const q = String(question || "").trim();
    if (!q) return;

    const sources = (sourceDocs || []).slice(0, ANSWER_SOURCES_LIMIT).map((d) => ({
      id: d.id,
      title: d.title,
      summary: d.ai_summary_text,
      status: d.status,
      committees: d.committees,
      policy_area: d.policy_area,
      updated: d.update_date
    }));

    renderAnswerLoading("Generating answer…");

    try {
      const resp = await fetchJson(OPENAI_WORKER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          mode: "answer",
          question: q,
          sources
        }
      });

      const text =
        (resp && (resp.answer || resp.output_text || resp.text)) ||
        (resp && resp.output && resp.output[0] && resp.output[0].content && resp.output[0].content[0] && resp.output[0].content[0].text) ||
        "";

      if (!String(text || "").trim()) throw new Error("No answer text returned.");

      renderAnswerText(String(text).trim(), sources.map((s) => ({ id: s.id, type: "", number: "", title: s.title })));
    } catch (e) {
      renderAnswerError(String(e.message || e));
    }
  }

  // ---------------------------
  // Orchestration
  // ---------------------------
  let lastSearch = {
    query: "",
    docs: []
  };

  async function runSearch() {
    const input = document.getElementById(IDS.input);
    const q = input ? String(input.value || "").trim() : "";

    showResultsSection();

    const mount = document.getElementById(IDS.resultsMount);
    if (mount) mount.innerHTML = `<div class="muted">Searching…</div>`;

    try {
      const res = await hybridSearch(q);
      const hits = (res && res.hits) ? res.hits : [];
      const docs = hits.map((h) => h.document);

      setResultsCount(res && res.found ? res.found : docs.length);
      renderResults(docs);

      // Update dropdown options from live facets (so filters stay relevant)
      updateFacetOptionsFromSearch(res);

      lastSearch.query = q;
      lastSearch.docs = docs;

      // If user typed an explicit question-ish query, you can auto-answer; for now we keep manual.
      ensureAnswerUI();
    } catch (e) {
      if (mount) mount.innerHTML = `<div class="muted">${escHtml(String(e.message || e))}</div>`;
      setResultsCount(0);
    }
  }

  function bindSearchForm() {
    const form = document.getElementById(IDS.form);
    const input = document.getElementById(IDS.input);
    if (!form || !input) return;

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      await runSearch();
    });
  }

  function bindAnswerControls() {
    const form = document.getElementById(IDS.askFollowupForm);
    const input = document.getElementById(IDS.askFollowupInput);
    const refresh = document.getElementById(IDS.refreshAnswerBtn);

    if (form && input) {
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        const q = String(input.value || "").trim();
        if (!q) return;
        await generateAnswer(q, lastSearch.docs);
      });
    }

    if (refresh) {
      refresh.addEventListener("click", async function () {
        const inputQ = document.getElementById(IDS.input);
        const q = inputQ ? String(inputQ.value || "").trim() : "";
        const prompt = q || "Summarize the top matches.";
        await generateAnswer(prompt, lastSearch.docs);
      });
    }
  }

  async function boot() {
    ensureFiltersUI();
    bindSearchForm();
    bindAnswerControls();
    ensureAnswerUI();

    // Load facets first (so dropdowns populate before first search)
    try {
      await loadFacetOptions();
    } catch (e) {
      // Don't kill the page if facets fail
      console.warn("Facet preload failed:", e);
    }

    // Recent bills
    try {
      await fetchRecentBills();
    } catch (e) {
      console.warn("Recent bills failed:", e);
      const rail = document.getElementById(IDS.recentRail);
      if (rail) rail.innerHTML = `<div class="muted" style="padding:12px;">Could not load recent bills.</div>`;
    }
  }

  // Wait for your app.js "onReady" helper if present
  if (window.onReady && typeof window.onReady === "function") {
    window.onReady(boot);
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
