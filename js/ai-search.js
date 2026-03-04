/* ---------------------------------------------------
   AI SEARCH (Typesense hybrid vector search via Workers)
   - Recent bills: GET /collections/:collection/documents/search (small query)
   - Search: POST /multi_search (vector payload in body)
   - OpenAI:
       - embeddings: POST /embeddings
       - answer: POST /responses
   - Adds AI Answer panel + follow-up + refresh summary
--------------------------------------------------- */

(function () {
  "use strict";

  // Workers
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

  // Answer model (change if you want)
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

  // How many hits to pass to the answer model as context
  const ANSWER_SOURCES_LIMIT =
    (window.APP_CONFIG && window.APP_CONFIG.ANSWER_SOURCES_LIMIT) ||
    8;

  // Endpoints
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
    // “primaryQuery” is the original search query. “userQuestion” is either same, or a follow-up.
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

    // Responses API returns output in different shapes depending on version;
    // We'll handle the common cases:
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

  async function hybridSearchMulti({ q, vector, perPage = 20, page = 1, alpha = DEFAULT_ALPHA }) {
    const k = Math.max(80, perPage * 5);
    const vectorQuery = `embedding:([${vector.join(",")}], k:${k}, alpha:${alpha})`;

    const body = {
      searches: [
        {
          collection: COLLECTION,
          q: q,
          query_by: "title,ai_summary_text,policy_area,subjects,committees,latest_action_text",
          per_page: perPage,
          page: page,
          sort_by: "_text_match:desc,update_date:desc",
          vector_query: vectorQuery,
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
            "latest_action_text"
          ].join(","),
          exclude_fields: "embedding"
        }
      ]
    };

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

    // Build UI only once
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
    // Prefer markdown parser if available
    if (window.simpleMarkdownToHTML) {
      body.innerHTML = window.simpleMarkdownToHTML(answerText);
    } else {
      body.innerHTML = parseTextToHtml(answerText);
    }
  }

  // Render clickable source links
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

  /* ---------------- state (so follow-ups + refresh work) ---------------- */

  const state = {
    lastPrimaryQuery: "",
    lastHits: [],          // raw Typesense hits
    lastSourceDocs: []     // documents used for answering
  };

  async function runAnswerFlow({ primaryQuery, question, hits }) {
    ensureAnswerUI();

    const sourceDocs = pickTopDocsForAnswer(hits, ANSWER_SOURCES_LIMIT);
    const sourcesBundle = buildSourcesBundle(sourceDocs);

    // update state for refresh/follow-up
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
    const query = String(q || "").trim();
    if (!query) return;

    showResultsSection();
    ensureAnswerUI();

    const $results = window.jQuery("#results");
    if ($results.length) $results.html(`<div class="muted">Searching…</div>`);

    renderAnswerLoading("Searching and generating summary…");

    // 1) embed query
    const vector = await embedQuery(query);

    // 2) hybrid search
    const result = await hybridSearchMulti({
      q: query,
      vector,
      perPage: RESULTS_PER_PAGE,
      page: 1,
      alpha: DEFAULT_ALPHA
    });

    // 3) render results
    renderResults(result, query);

    // 4) answer
    const hits = result?.hits || [];
    await runAnswerFlow({ primaryQuery: query, question: query, hits });
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    const $ = await waitForjQuery();

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

        // Use the same sources as the current results
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
