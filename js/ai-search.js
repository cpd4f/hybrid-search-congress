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
  const SHOW_FILTER_COUNTS = false; // set true if you later implement dynamic counts per query

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

  function titleCaseFromToken(s) {
    const t = String(s || "").replace(/_/g, " ").trim();
    if (!t) return "";
    return t.split(/\s+/).map(w => w.slice(0, 1).toUpperCase() + w.slice(1)).join(" ");
  }

  function sortStatusOptions(options) {
    const order = [
      "Introduced",
      "CommitteeConsideration",
      "FloorConsideration",
      "FailedOneChamber",
      "PassedOneChamber",
      "PassedBothChambers",
      "ResolvingDifferences",
      "ToPresident",
      "VetoActions",
      "BecameLaw"
    ];

    const norm = (v) => String(v || "").replace(/\s+/g, "").toLowerCase();
    const orderMap = new Map(order.map((v, i) => [norm(v), i]));

    return (options || [])
      .slice()
      .sort((a, b) => {
        const ai = orderMap.has(norm(a.value)) ? orderMap.get(norm(a.value)) : 999;
        const bi = orderMap.has(norm(b.value)) ? orderMap.get(norm(b.value)) : 999;
        if (ai !== bi) return ai - bi;
        return String(a.label || a.value).localeCompare(String(b.label || b.value));
      });
  }

  function buildSourcesBundle(docs) {
    // Keep this compact (token-efficient) to speed up the AI response.
    return (docs || []).map((d, idx) => {
      const committee = firstCommittee(d.committees);
      return {
        rank: idx + 1,
        id: d.id,
        bill: billShortId(d),
        title: d.title || "",
        chamber: d.chamber || "",
        congress: d.congress || "",
        status: d.status ? titleCaseFromToken(d.status) : "",
        updated: d.update_date ? epochToDate(d.update_date) : "",
        policy_area: d.policy_area || "",
        committee: committee || "",
        latest_action: d.latest_action_text || "",
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

  /* ---------------- Filter UI (accordion multi-check) ---------------- */

  function ensureFiltersUI() {
    const mount = document.getElementById("filtersMount");
    if (!mount) return;

    if (mount.getAttribute("data-filters-built") === "1") return;
    mount.setAttribute("data-filters-built", "1");

    mount.innerHTML = `
      <div class="filters">
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
      const count = "";

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

    const count = set instanceof Set ? set.size : 0;
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
    const input = document.getElementById("mainSearchInput");
    const q = input ? String(input.value || "") : "";
    const resultsSection = document.getElementById("resultsSection");
    const hasShownResults = resultsSection && !resultsSection.hasAttribute("hidden");
    if (hasShownResults || q.trim()) {
      runSearch(q).catch(err => console.error(err));
    }
  }

  /* ---------------- Typesense fetch helpers ---------------- */

  async function tsGet(url, paramsObj) {
    const u = new URL(url);
    if (paramsObj) {
      Object.keys(paramsObj).forEach(k => {
        if (paramsObj[k] !== undefined && paramsObj[k] !== null) u.searchParams.set(k, String(paramsObj[k]));
      });
    }
    const res = await fetch(u.toString(), { method: "GET" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Typesense GET failed HTTP ${res.status}: ${txt}`);
    }
    return res.json();
  }

  async function tsPost(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Typesense POST failed HTTP ${res.status}: ${txt}`);
    }
    return res.json();
  }

  /* ---------------- Recent bills ---------------- */

  async function fetchRecentBills(limit) {
    const json = await tsGet(TS_DOCS_SEARCH, {
      q: "*",
      query_by: "title",
      per_page: limit || 12,
      page: 1,
      sort_by: "update_date:desc",
      include_fields: [
        "id",
        "title",
        "type",
        "number",
        "congress",
        "chamber",
        "update_date",
        "committees",
        "sponsor_party",
        "status"
      ].join(","),
      exclude_fields: "embedding"
    });

    return json;
  }

  /* ---------------- Facets preload ---------------- */

  async function preloadFacets() {
    const facetBy = [
      "chamber",
      "committees",
      "policy_area",
      "status"
    ].join(",");

    const json = await tsGet(TS_DOCS_SEARCH, {
      q: "*",
      query_by: "title",
      per_page: 0,
      facet_by: facetBy,
      max_facet_values: MAX_FACET_VALUES
    });

    const facets = json?.facet_counts || [];

    const getFacet = (field) => facets.find(f => f.field_name === field);

    const chamberFacet = getFacet("chamber");
    facetOptions.chamber = (chamberFacet?.counts || []).map(c => ({
      value: c.value,
      label: c.value,
      count: c.count
    }));

    const comFacet = getFacet("committees");
    facetOptions.committees = (comFacet?.counts || [])
      .slice(0, MAX_COMMITTEES)
      .map(c => ({ value: c.value, label: c.value, count: c.count }));

    const polFacet = getFacet("policy_area");
    facetOptions.policy_area = (polFacet?.counts || [])
      .slice(0, MAX_POLICY)
      .map(c => ({ value: c.value, label: c.value, count: c.count }));

    const statFacet = getFacet("status");
    facetOptions.status = sortStatusOptions((statFacet?.counts || [])
      .slice(0, MAX_STATUS)
      .map(c => ({ value: c.value, label: titleCaseFromToken(c.value), count: c.count })));

    renderDropdownOptions("chamber");
    renderDropdownOptions("committees");
    renderDropdownOptions("policy_area");
    renderDropdownOptions("sponsor_party");
    renderDropdownOptions("status");
    renderDropdownOptions("update_range");

    updateAllBadges();
  }

  /* ---------------- OpenAI: embeddings ---------------- */

  async function embedQuery(text) {
    const input = String(text || "").trim();
    if (!input) return [];

    const res = await fetch(OA_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: input
      })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Embeddings failed HTTP ${res.status}: ${txt}`);
    }

    const json = await res.json();
    const vec = json?.data?.[0]?.embedding;

    if (!Array.isArray(vec)) throw new Error("Embeddings response missing data[0].embedding");
    if (EXPECTED_EMBED_DIMS && vec.length !== EXPECTED_EMBED_DIMS) {
      console.warn("Embedding dims mismatch:", vec.length, "expected", EXPECTED_EMBED_DIMS);
    }

    return vec;
  }

  /* ---------------- OpenAI: answer generation ---------------- */

  async function generateAnswer({ userQuestion, primaryQuery, sources }) {
    const systemStyle = [
      "You are a helpful legislative search assistant.",
      "Answer in plain English.",
      "Be concise and practical.",
      "Do not invent facts not supported by the provided sources.",
      "If the question cannot be answered from the sources, say what’s missing and suggest a better query.",
      "Formatting rules: do NOT use headings (no # / ## / ###), do NOT use numbered lists.",
      "Use '-' bullets only when listing bills.",
      "When listing bills, use exactly one bullet per bill in this format:",
      "**BILL TITLE (BILL CODE):** One sentence summarizing what it does and the latest action.",
      "Do not break a bill into sub-bullets like Chamber/Summary/Latest Action."
    ].join(" ");

    const prompt = [
      `SEARCH QUERY: ${primaryQuery}`,
      userQuestion && userQuestion !== primaryQuery ? `FOLLOW-UP QUESTION: ${userQuestion}` : "",
      "",
      "SOURCES (ranked search hits, limited fields):",
      JSON.stringify(sources, null, 2),
      "",
      "TASK:",
      "1) Start with 2–4 sentences summarizing the main themes across these bills (include party trends only if the sources support it).",
      "2) Then list 4–10 key bills as '-' bullets. One bullet per bill only, following the required format.",
      "Do NOT include headings, numbered items, or any '###' markers.",
      "Do NOT add a Sources/Source bills line. The UI shows clickable source links separately.",
      "",
      "Return plain text with minimal markdown: bold is OK; no tables."
    ].filter(Boolean).join("\n");

    const res = await fetch(OA_RESPONSES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ANSWER_MODEL,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemStyle }]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: prompt }]
          }
        ],
        temperature: 0.2
      })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Answer failed HTTP ${res.status}: ${txt}`);
    }

    const json = await res.json();

    const out = json?.output || [];
    let text = "";

    for (const item of out) {
      const content = item?.content || [];
      for (const part of content) {
        if (part?.type === "output_text" && part?.text) text += part.text;
      }
    }

    return String(text || "").trim();
  }

  /* ---------------- Typesense hybrid search ---------------- */

  async function hybridSearchMulti({ q, vector, perPage, page, alpha, filterBy }) {
    const vectorQuery = (Array.isArray(vector) && vector.length)
      ? `embedding:([${vector.join(",")}], alpha:${alpha ?? DEFAULT_ALPHA})`
      : null;

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
    const headActions = document.getElementById("aiAnswerHeadActions");
    if (!mount) return;

    if (headActions && !headActions.querySelector("#aiRefreshBtn")) {
      headActions.innerHTML = `
        <button type="button" id="aiRefreshBtn" class="search__btn" style="padding:10px 14px; height:auto;">
          Refresh summary
        </button>
      `;
    }

    if (mount.querySelector("[data-ai-answer-ui='1']")) return;

    mount.innerHTML = `
      <div data-ai-answer-ui="1">
        <div id="aiAnswerBody" class="muted" style="line-height:1.5;">
          Ask a question above to get a plain-English answer.
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

  function ensureSpinnerStyles() {
    if (document.getElementById("aiSpinnerStyles")) return;

    const style = document.createElement("style");
    style.id = "aiSpinnerStyles";
    style.textContent = `
      .ai-spinner-row { display:flex; align-items:center; gap:10px; }
      .ai-spinner {
        width: 16px;
        height: 16px;
        border-radius: 999px;
        border: 2px solid rgba(107,114,128,0.35);
        border-top-color: rgba(26,115,232,0.95);
        animation: aiSpin 0.8s linear infinite;
        flex: 0 0 auto;
      }
      @keyframes aiSpin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  function renderAnswerLoading(message) {
    ensureAnswerUI();
    ensureSpinnerStyles();

    const body = document.getElementById("aiAnswerBody");
    if (body) {
      body.innerHTML = `
        <div class="ai-spinner-row">
          <span class="ai-spinner" aria-hidden="true"></span>
          <span class="muted">${escHtml(message || "Generating answer…")}</span>
        </div>
      `;
    }

    const links = document.getElementById("aiSourcesLinks");
    if (links) links.innerHTML = "";
  }

  function normalizeAnswerText(answerText) {
    let t = String(answerText || "");

    // Strip markdown heading markers if the model emits them anyway.
    t = t.replace(/^\s*#{1,6}\s+/gm, "");

    // Convert numbered list items ("1. Foo") to dash bullets ("- Foo")
    t = t.replace(/^\s*\d+\.\s+/gm, "- ");

    // If the model emits "-Chamber:" without a space, normalize spacing (harmless)
    t = t.replace(/^\s*-([A-Za-z])/gm, "- $1");

    return t.trim();
  }

  function renderAnswerText(answerText, sourceDocs) {
    ensureAnswerUI();

    const body = document.getElementById("aiAnswerBody");

    if (body) {
      if (window.simpleMarkdownToHTML) {
        body.innerHTML = window.simpleMarkdownToHTML(normalizeAnswerText(answerText));
      } else {
        body.innerHTML = parseTextToHtml(normalizeAnswerText(answerText));
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
        const status = d.status ? titleCaseFromToken(d.status) : "";

        return `
          <a class="billcard" href="./bill.html?id=${encodeURIComponent(d.id)}">
            <span class="${dot}" aria-hidden="true" title="${escHtml(sponsorPartyLabel(d.sponsor_party))}"></span>

            <div class="billcard__meta">
              <div class="billcard__id">${escHtml(billShortId(d))}</div>
              <div class="billcard__status">${escHtml(d.chamber || "")}${d.congress ? " • " + escHtml(String(d.congress)) + "th" : ""}${status ? " • " + escHtml(status) : ""}</div>
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
      $mount.html(`<div class="muted">No matches found.</div>`);
      return;
    }

    const html = hits
      .map(h => h.document)
      .map(d => {
        const updated = epochToDate(d.update_date);
        const dot = sponsorDotClass(d.sponsor_party);
        const committee = firstCommittee(d.committees);
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

    const filterBy = buildFilterBy();

    let vector = null;
    if (query !== "*") {
      vector = await embedQuery(query);
    }

    const result = await hybridSearchMulti({
      q: query,
      vector: vector || [],
      perPage: RESULTS_PER_PAGE,
      page: 1,
      alpha: DEFAULT_ALPHA,
      filterBy: filterBy
    });

    renderResults(result, query);

    const hits = result?.hits || [];
    if (query === "*") {
      renderAnswerError("Tip: Type a keyword query to generate an AI summary. Browsing mode does not generate summaries.");
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

    ensureFiltersUI();

    try {
      await preloadFacets();
    } catch (e) {
      console.warn("Facet preload failed:", e);
      renderDropdownOptions("chamber");
      renderDropdownOptions("committees");
      renderDropdownOptions("policy_area");
      renderDropdownOptions("status");
      renderDropdownOptions("sponsor_party");
      renderDropdownOptions("update_range");
      updateAllBadges();
    }

    try {
      const recent = await fetchRecentBills(RECENT_LIMIT);
      renderRecentBills(recent);
    } catch (e) {
      console.error("Recent bills failed:", e);
      const $mount = $("#recentBills");
      if ($mount.length) $mount.html(`<div class="muted">Could not load recent bills.</div>`);
    }

    ensureAnswerUI();

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

/* =========================================================
   Filters accordion UX
   - Allows multiple panels open (no "close others")
   - jQuery slideDown/slideUp for smooth animation
========================================================= */
(function () {
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
  }

  document.addEventListener("DOMContentLoaded", function () {
    var mount = document.getElementById("filtersMount");
    if (mount) bindFiltersAccordion(mount);
  });

  window.__bindFiltersAccordion = bindFiltersAccordion;
})();
