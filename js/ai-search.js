/* ---------------------------------------------------
   ai-search.js
   Hybrid search (Typesense keyword + vector) + AI answer
--------------------------------------------------- */

(function () {
  "use strict";

  /* ---------------------------------------------------
     STATE
  --------------------------------------------------- */

  const state = {
    lastPrimaryQuery: "",
    lastHits: [],
    lastAnswerQuestion: "",
    lastAnswerSources: [],
    lastAnswerText: "",
    isSearching: false,
    isAnswerLoading: false,
    page: 1,
    perPage: (window.APP_CONFIG && window.APP_CONFIG.RESULTS_PER_PAGE) ? window.APP_CONFIG.RESULTS_PER_PAGE : 20
  };

  // Filters (Sets + single-select)
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
      { value: "7d", label: "Past 7 days", count: 0 },
      { value: "30d", label: "Past 30 days", count: 0 },
      { value: "90d", label: "Past 90 days", count: 0 },
      { value: "365d", label: "Past year", count: 0 },
      { value: "all", label: "All time", count: 0 }
    ]
  };

  // Recent bills
  let recentBillsCache = [];

  /* ---------------------------------------------------
     CONFIG / ENDPOINTS
  --------------------------------------------------- */

  const TYPESENSE_INDEX = (window.APP_CONFIG && window.APP_CONFIG.TYPESENSE_INDEX) ? window.APP_CONFIG.TYPESENSE_INDEX : "congress_bills";

  const API = window.API || {
    TYPESENSE: "",
    OPENAI: ""
  };

  /* ---------------------------------------------------
     HELPERS
  --------------------------------------------------- */

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function epochToDate(epochSeconds) {
    if (!epochSeconds) return "";
    const d = new Date(epochSeconds * 1000);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  function epochSecondsDaysAgo(days) {
    const ms = Date.now() - (days * 24 * 60 * 60 * 1000);
    return Math.floor(ms / 1000);
  }

  function billShortId(doc) {
    const bn = doc.bill_number || "";
    const bt = doc.bill_type || "";
    const cg = doc.congress || "";
    const raw = `${bt}${bn}-${cg}`;
    return raw.replace(/\s+/g, "").toLowerCase();
  }

  function sponsorPartyLabel(p) {
    if (p === "R") return "R";
    if (p === "D") return "D";
    if (p === "I") return "I";
    return "";
  }

  function sponsorDotClass(p) {
    if (p === "R") return "dot dot--r";
    if (p === "D") return "dot dot--d";
    if (p === "I") return "dot dot--i";
    return "dot";
  }

  function firstCommittee(doc) {
    const c = doc.committees;
    if (!c) return "";
    if (Array.isArray(c) && c.length) return String(c[0]);
    if (typeof c === "string") return c;
    return "";
  }

  function titleCaseFromToken(t) {
    const s = String(t || "").trim();
    if (!s) return "";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function getParam(name) {
    if (window.utils && typeof window.utils.getParam === "function") return window.utils.getParam(name);
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  }

  function parseTextToHtml(text) {
    // Prefer markdown helper if present
    if (window.markdownToHTML && typeof window.markdownToHTML === "function") {
      return window.markdownToHTML(String(text || ""));
    }
    // Minimal fallback
    return escHtml(String(text || "")).replace(/\n/g, "<br>");
  }

  function waitForjQuery(timeoutMs) {
    timeoutMs = timeoutMs || 5000;
    const start = Date.now();
    return new Promise((resolve) => {
      (function tick() {
        if (window.jQuery) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 50);
      })();
    });
  }

  /* ---------------------------------------------------
     FILTER UI
  --------------------------------------------------- */

  function renderAccordionItem(key, label) {
    return `
      <details class="filter-acc__item" data-key="${escHtml(key)}">
        <summary class="filter-acc__toggle">
          <span class="filter-acc__label">${escHtml(label)}</span>
          <span class="filter-acc__badge" data-badge="${escHtml(key)}"></span>
          <span class="filter-acc__chev" aria-hidden="true">▾</span>
        </summary>
        <div class="filter-acc__panel">
          <div class="filter-acc__body" data-options="${escHtml(key)}">
            <div class="muted">Loading…</div>
          </div>
        </div>
      </details>
    `;
  }

  function ensureFiltersUI() {
    const mount = document.getElementById("filtersMount");
    if (!mount) return;

    // Avoid rebuilding / rebinding
    if (mount.getAttribute("data-filters-built") === "1") return;
    mount.setAttribute("data-filters-built", "1");

    // IMPORTANT: HTML ONLY. Do not place JS in this template string.
    mount.innerHTML = `
      <div class="filters" data-filters-ui="1">
        <div class="filter-acc" id="filtersAccordion">
          ${renderAccordionItem("chamber", "Chamber")}
          ${renderAccordionItem("committees", "Committee")}
          ${renderAccordionItem("policy_area", "Policy area")}
          ${renderAccordionItem("sponsor_party", "Sponsor party")}
          ${renderAccordionItem("status", "Status")}
          ${renderAccordionItem("update_range", "Updated")}
        </div>

        <div class="filters__actions">
          <button type="button" class="filters__clear" id="clearFiltersBtn">Clear filters</button>
        </div>
      </div>
    `;

    // Bind accordion animation (safe: no DOM injection)
    if (typeof bindFiltersAccordion === "function") {
      bindFiltersAccordion(mount);
    } else if (window.__bindFiltersAccordion) {
      window.__bindFiltersAccordion(mount);
    }
  }

  function renderDropdownOptions(key) {
    const body = document.querySelector(`[data-options="${CSS.escape(key)}"]`);
    if (!body) return;

    const options = facetOptions[key] || [];

    // Updated range is radios
    if (key === "update_range") {
      body.innerHTML = options.map((o, idx) => {
        const id = `f-${key}-${idx}`;
        const checked = (filterState.update_range === o.value);
        return `
          <label class="filter-opt" for="${escHtml(id)}">
            <input
              id="${escHtml(id)}"
              type="radio"
              name="update_range"
              value="${escHtml(o.value)}"
              ${checked ? "checked" : ""}
            />
            <span class="filter-opt__label">${escHtml(o.label)}</span>
          </label>
        `;
      }).join("");
      return;
    }

    // Sets are checkboxes
    body.innerHTML = options.map((o, idx) => {
      const id = `f-${key}-${idx}`;
      const checked = filterState[key] && filterState[key].has(o.value);
      return `
        <label class="filter-opt" for="${escHtml(id)}">
          <input
            id="${escHtml(id)}"
            type="checkbox"
            value="${escHtml(o.value)}"
            ${checked ? "checked" : ""}
          />
          <span class="filter-opt__label">${escHtml(o.label)}</span>
          ${typeof o.count === "number" ? `<span class="filter-opt__count">${o.count}</span>` : ""}
        </label>
      `;
    }).join("");
  }

  function updateBadge(key) {
    const badge = document.querySelector(`[data-badge="${CSS.escape(key)}"]`);
    if (!badge) return;

    // Updated range is single-select
    if (key === "update_range") {
      if (filterState.update_range && filterState.update_range !== "all") {
        const opt = facetOptions.update_range.find(x => x.value === filterState.update_range);
        badge.textContent = opt ? opt.label : "Filtered";
        badge.classList.add("is-on");
      } else {
        badge.textContent = "";
        badge.classList.remove("is-on");
      }
      return;
    }

    const set = filterState[key];
    const count = set && typeof set.size === "number" ? set.size : 0;

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

  function clearAllFilters() {
    filterState.chamber.clear();
    filterState.committees.clear();
    filterState.policy_area.clear();
    filterState.sponsor_party.clear();
    filterState.status.clear();
    filterState.update_range = "all";

    // Sync UI
    ["chamber", "committees", "policy_area", "sponsor_party", "status", "update_range"].forEach(renderDropdownOptions);
    updateAllBadges();

    // Run search if we have a query
    triggerSearchFromUI();
  }

  function triggerSearchFromUI() {
    const input = document.getElementById("q");
    const q = input ? String(input.value || "").trim() : "";
    state.page = 1;
    runSearch(q);
  }

  /* ---------------------------------------------------
     FILTER BY (Typesense)
  --------------------------------------------------- */

  function escFilterVal(v) {
    // Typesense filter_by needs quotes for strings if special chars
    const s = String(v || "");
    const safe = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${safe}"`;
  }

  function buildFilterBy() {
    const parts = [];

    if (filterState.chamber.size) {
      parts.push(`chamber:=[${Array.from(filterState.chamber).map(escFilterVal).join(",")}]`);
    }
    if (filterState.committees.size) {
      parts.push(`committees:=[${Array.from(filterState.committees).map(escFilterVal).join(",")}]`);
    }
    if (filterState.policy_area.size) {
      parts.push(`policy_area:=[${Array.from(filterState.policy_area).map(escFilterVal).join(",")}]`);
    }
    if (filterState.sponsor_party.size) {
      parts.push(`sponsor_party:=[${Array.from(filterState.sponsor_party).map(escFilterVal).join(",")}]`);
    }
    if (filterState.status.size) {
      parts.push(`status:=[${Array.from(filterState.status).map(escFilterVal).join(",")}]`);
    }

    // update range -> epoch seconds threshold
    if (filterState.update_range && filterState.update_range !== "all") {
      let days = 0;
      if (filterState.update_range === "7d") days = 7;
      if (filterState.update_range === "30d") days = 30;
      if (filterState.update_range === "90d") days = 90;
      if (filterState.update_range === "365d") days = 365;
      if (days) {
        const threshold = epochSecondsDaysAgo(days);
        parts.push(`update_date:>=${threshold}`);
      }
    }

    return parts.join(" && ");
  }

  /* ---------------------------------------------------
     TYPESENSE SEARCH
  --------------------------------------------------- */

  async function embedQuery(q) {
    // Proxy worker handles OpenAI key
    const res = await fetch(API.OPENAI, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "embed",
        input: q
      })
    });

    if (!res.ok) {
      throw new Error(`OpenAI embed failed: ${res.status}`);
    }

    const data = await res.json();
    if (!data || !data.embedding || !Array.isArray(data.embedding)) {
      throw new Error("OpenAI embed: missing embedding");
    }
    return data.embedding;
  }

  async function hybridSearchMulti(q, page, perPage) {
    const filter_by = buildFilterBy();

    // If no query, fallback to recent-ish listing
    const query = String(q || "").trim() || "*";

    // Build vector query only when keyword is provided (avoid embedding on blank)
    let vector_query = "";
    if (query !== "*" && query.length > 1) {
      const emb = await embedQuery(query);
      vector_query = `embedding:([${emb.join(",")}], k: 50)`;
    }

    const payload = {
      searches: [
        {
          collection: TYPESENSE_INDEX,
          q: query,
          query_by: "title,summary,display_id,sponsor_name,policy_area,committees,status",
          filter_by: filter_by || undefined,
          sort_by: query === "*" ? "update_date:desc" : undefined,
          per_page: perPage,
          page: page,
          include_fields: "id,display_id,title,summary,congress,bill_type,bill_number,update_date,introduced_date,chamber,policy_area,committees,status,sponsor_name,sponsor_party,url",
          facet_by: "chamber,committees,policy_area,sponsor_party,status",
          max_facet_values: 50,
          exhaustive_search: true,
          vector_query: vector_query || undefined
        }
      ]
    };

    const res = await fetch(`${API.TYPESENSE}/multi_search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Typesense multi_search failed: ${res.status} ${t}`);
    }

    const data = await res.json();

    const r0 = data && data.results && data.results[0] ? data.results[0] : null;
    const hits = r0 && Array.isArray(r0.hits) ? r0.hits.map(h => h.document) : [];
    const found = r0 && typeof r0.found === "number" ? r0.found : 0;
    const facets = r0 && Array.isArray(r0.facet_counts) ? r0.facet_counts : [];

    return { hits, found, facets };
  }

  function countsToOptions(facetCounts) {
    // facetCounts: [{field_name, counts:[{value,count}]}]
    const out = {};
    (facetCounts || []).forEach(fc => {
      const field = fc.field_name;
      const counts = (fc.counts || []).map(c => ({
        value: c.value,
        label: titleCaseFromToken(c.value),
        count: c.count
      }));
      out[field] = counts;
    });
    return out;
  }

  function sortStatusOptions(opts) {
    // Keep stable but prefer higher counts
    return (opts || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0));
  }

  async function preloadFacets() {
    // Run a lightweight query to load facets for building options
    const q = "*";
    const { facets } = await hybridSearchMulti(q, 1, 1);

    const map = countsToOptions(facets);

    facetOptions.chamber = map.chamber || [];
    facetOptions.committees = map.committees || [];
    facetOptions.policy_area = map.policy_area || [];
    // sponsor_party: keep hard-coded labels, but update counts
    const partyCounts = map.sponsor_party || [];
    facetOptions.sponsor_party = facetOptions.sponsor_party.map(p => {
      const c = partyCounts.find(x => x.value === p.value);
      return { ...p, count: c ? c.count : 0 };
    });

    facetOptions.status = sortStatusOptions(map.status || []);
  }

  /* ---------------------------------------------------
     RENDER RESULTS
  --------------------------------------------------- */

  function setResultsCount(found) {
    const el = document.getElementById("resultsCount");
    if (!el) return;
    el.textContent = (typeof found === "number") ? `${found.toLocaleString()} results` : "";
  }

  function showResultsSection() {
    const mount = document.getElementById("results");
    if (!mount) return;
    mount.classList.remove("muted");
  }

  function renderResults(hits, found) {
    const mount = document.getElementById("results");
    if (!mount) return;

    showResultsSection();

    if (!hits || !hits.length) {
      mount.innerHTML = `<div class="muted">No results found.</div>`;
      setResultsCount(0);
      return;
    }

    setResultsCount(found);

    const html = hits.map(doc => {
      const dot = sponsorDotClass(doc.sponsor_party);
      const party = sponsorPartyLabel(doc.sponsor_party);
      const update = epochToDate(doc.update_date);
      const intro = epochToDate(doc.introduced_date);
      const committee = firstCommittee(doc);
      const policy = doc.policy_area ? String(doc.policy_area) : "";
      const status = doc.status ? String(doc.status) : "";

      return `
        <article class="result">
          <div class="result__meta">
            <span class="${dot}" aria-hidden="true"></span>
            <span class="result__id">${escHtml(doc.display_id || "")}</span>
            ${party ? `<span class="pill pill--party">${escHtml(party)}</span>` : ""}
            ${status ? `<span class="pill">${escHtml(status)}</span>` : ""}
          </div>

          <h3 class="result__title">
            <a href="${escHtml(doc.url || "#")}" target="_blank" rel="noopener">
              ${escHtml(doc.title || "")}
            </a>
          </h3>

          <div class="result__sub">
            ${intro ? `<span><strong>Introduced:</strong> ${escHtml(intro)}</span>` : ""}
            ${update ? `<span><strong>Updated:</strong> ${escHtml(update)}</span>` : ""}
            ${committee ? `<span><strong>Committee:</strong> ${escHtml(committee)}</span>` : ""}
            ${policy ? `<span><strong>Policy:</strong> ${escHtml(policy)}</span>` : ""}
          </div>

          ${doc.summary ? `<div class="result__summary">${parseTextToHtml(doc.summary)}</div>` : ""}
        </article>
      `;
    }).join("");

    const showMoreBtn = (found > (state.page * state.perPage))
      ? `<button type="button" class="btn btn--ghost" id="showMoreBtn" style="margin-top:14px;">Show more</button>`
      : "";

    mount.innerHTML = `
      <div class="results">
        ${html}
        ${showMoreBtn}
      </div>
    `;
  }

  /* ---------------------------------------------------
     ANSWER UI
  --------------------------------------------------- */

  function ensureAnswerUI() {
    // Preferred: index.html already provides the Answer UI (aiAnswerBody, aiSourcesLinks, aiFollowupForm, refreshAnswerBtn)
    if (document.getElementById("aiAnswerBody")) return;

    // Back-compat: if a legacy mount exists, build minimal UI
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
            Refresh
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

  function renderAnswerError(message) {
    ensureAnswerUI();

    const body = document.getElementById("aiAnswerBody");
    if (body) {
      body.innerHTML = `<div class="muted">${escHtml(message || "Something went wrong.")}</div>`;
    }
  }

  function renderAnswerText(htmlText, sources) {
    ensureAnswerUI();

    const body = document.getElementById("aiAnswerBody");
    if (body) {
      body.innerHTML = htmlText || `<div class="muted">No answer returned.</div>`;
    }

    const links = document.getElementById("aiSourcesLinks");
    if (!links) return;

    if (!sources || !sources.length) {
      links.innerHTML = "";
      return;
    }

    links.innerHTML = `
      <div class="answer-sources">
        <div class="answer-sources__label">Sources</div>
        <div class="answer-sources__list">
          ${sources.map((s, idx) => {
            const title = s.title || s.display_id || `Source ${idx + 1}`;
            const url = s.url || "#";
            return `<a class="answer-source" href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(title)}</a>`;
          }).join("")}
        </div>
      </div>
    `;
  }

  function pickTopDocsForAnswer(hits, maxDocs) {
    maxDocs = maxDocs || 8;
    const docs = (hits || []).slice(0, maxDocs);
    return docs.map(d => ({
      title: d.title || "",
      display_id: d.display_id || "",
      summary: d.summary || "",
      url: d.url || ""
    }));
  }

  function buildSourcesBundle(hits) {
    const docs = pickTopDocsForAnswer(hits, 10);
    const text = docs.map((d, idx) => {
      return `SOURCE ${idx + 1}\nID: ${d.display_id}\nTITLE: ${d.title}\nSUMMARY: ${d.summary}\nURL: ${d.url}\n`;
    }).join("\n");
    return { docs, text };
  }

  async function generateAnswer(question, hits) {
    const bundle = buildSourcesBundle(hits);

    const res = await fetch(API.OPENAI, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "answer",
        question: question,
        sourcesText: bundle.text
      })
    });

    if (!res.ok) {
      throw new Error(`OpenAI answer failed: ${res.status}`);
    }

    const data = await res.json();
    if (!data || !data.answer) {
      throw new Error("OpenAI answer: missing answer");
    }

    return {
      answer: data.answer,
      sources: bundle.docs
    };
  }

  async function runAnswerFlow(opts) {
    const question = String(opts.question || "").trim();
    const hits = opts.hits || [];

    if (!question) return;

    state.isAnswerLoading = true;
    renderAnswerLoading("Generating answer…");

    try {
      const r = await generateAnswer(question, hits);
      state.lastAnswerQuestion = question;
      state.lastAnswerSources = r.sources || [];
      state.lastAnswerText = r.answer || "";

      renderAnswerText(parseTextToHtml(r.answer), r.sources);
    } catch (err) {
      renderAnswerError(err && err.message ? err.message : "Failed to generate answer.");
    } finally {
      state.isAnswerLoading = false;
    }
  }

  /* ---------------------------------------------------
     RECENT BILLS
  --------------------------------------------------- */

  async function fetchRecentBills() {
    // Use Typesense sorted listing
    const { hits } = await hybridSearchMulti("*", 1, (window.APP_CONFIG && window.APP_CONFIG.RECENT_BILLS_LIMIT) ? window.APP_CONFIG.RECENT_BILLS_LIMIT : 12);
    return hits || [];
  }

  function renderRecentBills(items) {
    const mount = document.getElementById("recentBills");
    if (!mount) return;

    if (!items || !items.length) {
      mount.innerHTML = `<div class="muted">No recent bills found.</div>`;
      return;
    }

    mount.innerHTML = items.map(doc => {
      const update = epochToDate(doc.update_date);
      const party = sponsorPartyLabel(doc.sponsor_party);
      const dot = sponsorDotClass(doc.sponsor_party);
      return `
        <a class="card" href="${escHtml(doc.url || "#")}" target="_blank" rel="noopener">
          <div class="card__meta">
            <span class="${dot}" aria-hidden="true"></span>
            <span class="card__id">${escHtml(doc.display_id || "")}</span>
            ${party ? `<span class="pill pill--party">${escHtml(party)}</span>` : ""}
          </div>
          <div class="card__title">${escHtml(doc.title || "")}</div>
          ${update ? `<div class="card__sub muted">Updated ${escHtml(update)}</div>` : ""}
        </a>
      `;
    }).join("");
  }

  /* ---------------------------------------------------
     MAIN SEARCH FLOW
  --------------------------------------------------- */

  async function runSearch(q) {
    const query = String(q || "").trim();

    state.lastPrimaryQuery = query;
    state.isSearching = true;

    const resultsMount = document.getElementById("results");
    if (resultsMount) {
      resultsMount.innerHTML = `<div class="muted">Searching…</div>`;
    }

    try {
      const { hits, found, facets } = await hybridSearchMulti(query, state.page, state.perPage);
      state.lastHits = hits || [];

      // Update facet options from live result set (so counts are contextual)
      const map = countsToOptions(facets);
      facetOptions.chamber = map.chamber || facetOptions.chamber;
      facetOptions.committees = map.committees || facetOptions.committees;
      facetOptions.policy_area = map.policy_area || facetOptions.policy_area;

      // sponsor_party counts
      const partyCounts = map.sponsor_party || [];
      facetOptions.sponsor_party = facetOptions.sponsor_party.map(p => {
        const c = partyCounts.find(x => x.value === p.value);
        return { ...p, count: c ? c.count : 0 };
      });

      facetOptions.status = sortStatusOptions(map.status || facetOptions.status);

      // Re-render filter bodies + badges
      ["chamber", "committees", "policy_area", "sponsor_party", "status", "update_range"].forEach(renderDropdownOptions);
      updateAllBadges();

      // Render results
      renderResults(hits, found);

      // If user asked a question (query with ?q=...), auto-answer on first search
      const ask = getParam("ask");
      if (ask && state.page === 1) {
        await runAnswerFlow({ question: ask, hits: hits });
      }

    } catch (err) {
      if (resultsMount) {
        resultsMount.innerHTML = `<div class="muted">Search failed: ${escHtml(err && err.message ? err.message : "Unknown error")}</div>`;
      }
    } finally {
      state.isSearching = false;
    }
  }

  /* ---------------------------------------------------
     EVENTS
  --------------------------------------------------- */

  function bindUI() {
    // Search submit
    const form = document.getElementById("searchForm");
    if (form) {
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        state.page = 1;

        const input = document.getElementById("q");
        const q = input ? String(input.value || "").trim() : "";
        runSearch(q);
      });
    }

    // Show more
    document.addEventListener("click", function (ev) {
      const t = ev.target;
      if (!(t instanceof Element)) return;

      if (t && t.id === "showMoreBtn") {
        const input = document.getElementById("q");
        const q = input ? String(input.value || "").trim() : "";
        state.page += 1;

        // Append mode: re-run search then append additional results
        (async function () {
          try {
            const { hits, found } = await hybridSearchMulti(q, state.page, state.perPage);
            state.lastHits = state.lastHits.concat(hits || []);

            // Append by re-rendering full list (simple + stable)
            renderResults(state.lastHits, found);
          } catch (err) {
            // ignore
          }
        })();
      }
    });

    // Filter interactions (delegated)
    document.addEventListener("change", function (ev) {
      const t = ev.target;
      if (!(t instanceof HTMLInputElement)) return;

      const wrap = t.closest(".filter-acc__body");
      if (!wrap) return;

      const key = wrap.getAttribute("data-options");
      if (!key) return;

      if (key === "update_range") {
        filterState.update_range = t.value || "all";
        updateBadge("update_range");
        triggerSearchFromUI();
        return;
      }

      if (!filterState[key]) return;

      if (t.checked) filterState[key].add(t.value);
      else filterState[key].delete(t.value);

      updateBadge(key);
      triggerSearchFromUI();
    });

    // Clear filters
    document.addEventListener("click", function (ev) {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      if (t && t.id === "clearFiltersBtn") {
        clearAllFilters();
      }
    });

    // Answer refresh + follow-up handlers (delegated)
    document.addEventListener("click", async function (ev) {
      const t = ev.target;
      if (!(t instanceof Element)) return;

      if (t && (t.id === "aiRefreshBtn" || t.id === "refreshAnswerBtn")) {
        if (!state.lastPrimaryQuery || !state.lastHits.length) {
          renderAnswerError("Run a search first, then refresh the summary.");
          return;
        }
        await runAnswerFlow({
          question: state.lastPrimaryQuery,
          hits: state.lastHits
        });
      }
    });

    document.addEventListener("submit", async function (ev) {
      const form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;

      if (form.id === "aiFollowUpForm" || form.id === "aiFollowupForm") {
        ev.preventDefault();

        const input = document.getElementById("aiFollowUpInput") || document.getElementById("aiFollowupInput");
        const follow = input ? String(input.value || "").trim() : "";

        if (!follow) return;

        if (!state.lastPrimaryQuery || !state.lastHits.length) {
          renderAnswerError("Run a search first, then ask a follow-up question.");
          return;
        }

        if (input) input.value = "";

        await runAnswerFlow({
          question: follow,
          hits: state.lastHits
        });
      }
    });
  }

  /* ---------------------------------------------------
     ACCORDION ANIMATION (jQuery)
  --------------------------------------------------- */

  function bindFiltersAccordion(mountEl) {
    if (!mountEl) return;
    if (!window.jQuery) return;

    var $mount = window.jQuery(mountEl);

    // Avoid double-binding
    if ($mount.data("filtersAccBound")) return;
    $mount.data("filtersAccBound", true);

    // Sync panels with <details open> state on first paint
    $mount.find("details.filter-acc__item").each(function () {
      var $details = window.jQuery(this);
      var $panel = $details.find(".filter-acc__panel").first();
      if (!$panel.length) return;

      if ($details.prop("open")) $panel.show();
      else $panel.hide();
    });

    // Intercept summary click so we can animate
    $mount.on("click", ".filter-acc__toggle", function (e) {
      e.preventDefault();

      var $summary = window.jQuery(this);
      var $details = $summary.closest("details.filter-acc__item");
      var $panel = $details.find(".filter-acc__panel").first();
      if (!$panel.length) return;

      var isOpen = $details.prop("open");

      if (isOpen) {
        $panel.stop(true, true).slideUp(180, function () {
          $details.prop("open", false);
        });
      } else {
        $details.prop("open", true);
        $panel.hide().stop(true, true).slideDown(180);
      }
    });

    // Keyboard: Space/Enter should act like click on summary
    $mount.on("keydown", ".filter-acc__toggle", function (e) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        window.jQuery(this).trigger("click");
      }
    });
  }

  /* ---------------------------------------------------
     BOOT
  --------------------------------------------------- */

  async function boot() {
    // Ensure jQuery is available for accordion animation (not required for search)
    await waitForjQuery(6000);

    ensureFiltersUI();
    ensureAnswerUI();

    // Load facets and render filter options
    try {
      await preloadFacets();
      ["chamber", "committees", "policy_area", "sponsor_party", "status", "update_range"].forEach(renderDropdownOptions);
      updateAllBadges();
    } catch (e) {
      // If facets fail, still keep UI functional
      ["chamber", "committees", "policy_area", "sponsor_party", "status", "update_range"].forEach(renderDropdownOptions);
      updateAllBadges();
    }

    // Load recent bills
    try {
      recentBillsCache = await fetchRecentBills();
      renderRecentBills(recentBillsCache);
    } catch (e) {
      // ignore
    }

    bindUI();

    // Auto-run search if query param exists
    const qParam = getParam("q");
    const input = document.getElementById("q");
    if (qParam && input) {
      input.value = qParam;
      state.page = 1;
      runSearch(qParam);
    }
  }

  document.addEventListener("DOMContentLoaded", boot);

  // Expose for debugging
  window.__aiSearch = {
    state,
    filterState,
    facetOptions,
    runSearch,
    runAnswerFlow
  };

  // Expose accordion binder for safety
  window.__bindFiltersAccordion = bindFiltersAccordion;

})();
