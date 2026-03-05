(function () {
  "use strict";

  const TYPESENSE_WORKER_BASE = "https://typesense-proxy-worker.colemandavis4.workers.dev";
  const OPENAI_WORKER_BASE = "https://openai-proxy-worker.colemandavis4.workers.dev";
  const CONGRESS_WORKER_BASE = "https://congress-proxy.colemandavis4.workers.dev";

  const COLLECTION = (window.APP_CONFIG && window.APP_CONFIG.TYPESENSE_INDEX) || "congress_bills";
  const EMBED_MODEL = (window.APP_CONFIG && window.APP_CONFIG.OPENAI_EMBED_MODEL) || "text-embedding-3-large";
  const ANSWER_MODEL = (window.APP_CONFIG && window.APP_CONFIG.OPENAI_ANSWER_MODEL) || "gpt-4o-mini";
  const DEFAULT_ALPHA = (window.APP_CONFIG && window.APP_CONFIG.HYBRID_ALPHA) || 0.65;

  const TS_DOCS_SEARCH = `${TYPESENSE_WORKER_BASE.replace(/\/$/, "")}/collections/${encodeURIComponent(COLLECTION)}/documents/search`;
  const TS_MULTI_SEARCH = `${TYPESENSE_WORKER_BASE.replace(/\/$/, "")}/multi_search`;
  const OA_EMBED_URL = `${OPENAI_WORKER_BASE.replace(/\/$/, "")}/embeddings`;
  const OA_RESPONSES_URL = `${OPENAI_WORKER_BASE.replace(/\/$/, "")}/responses`;
  const CONGRESS_PROXY_URL = `${CONGRESS_WORKER_BASE.replace(/\/$/, "")}/`;
  const BILL_INCLUDE_FIELDS = [
    "id",
    "title",
    "type",
    "number",
    "congress",
    "chamber",
    "status",
    "committees",
    "policy_area",
    "subjects",
    "sponsor_party",
    "sponsor_state",
    "cosponsor_count",
    "introduced_date",
    "update_date",
    "latest_action_text",
    "ai_summary_text",
    "official_summary_text",
    "official_summary"
  ].join(",");

  function getParam(name) {
    const u = new URL(window.location.href);
    return u.searchParams.get(name);
  }

  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

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

  function titleCaseFromToken(s) {
    const t = String(s || "").replace(/_/g, " ").trim();
    if (!t) return "";
    return t.split(/\s+/).map(w => w.slice(0, 1).toUpperCase() + w.slice(1)).join(" ");
  }

  const billQaState = {
    history: [],
    currentDoc: null,
    currentTextData: null,
    currentCosponsors: []
  };

  function parseTextToHtml(text) {
    const raw = String(text || "");
    const escaped = escHtml(raw);
    const lines = escaped.split(/\r?\n/);
    const out = [];
    let inList = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const isBullet = trimmed.startsWith("- ") || trimmed.startsWith("• ");
      if (isBullet) {
        if (!inList) {
          out.push('<ul style="margin:10px 0 0 18px; padding:0;">');
          inList = true;
        }
        out.push(`<li style="margin:6px 0;">${trimmed.replace(/^(- |• )/, "")}</li>`);
      } else {
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
        if (trimmed.length) out.push(`<p style="margin:10px 0; line-height:1.5;">${line}</p>`);
      }
    }

    if (inList) out.push("</ul>");
    return out.join("");
  }

  function parseBillId(id) {
    const parts = String(id || "").trim().split("-").filter(Boolean);
    if (parts.length < 3) return null;
    const congress = Number.parseInt(parts[0], 10);
    const number = Number.parseInt(parts[parts.length - 1], 10);
    const type = parts.slice(1, parts.length - 1).join("-").toLowerCase();
    if (!Number.isFinite(congress) || !Number.isFinite(number) || !type) return null;
    return { congress, type, number };
  }

  function billTypeToSlug(type) {
    const t = String(type || "").toLowerCase();
    const map = {
      hr: "house-bill",
      s: "senate-bill",
      hres: "house-resolution",
      sres: "senate-resolution",
      hjres: "house-joint-resolution",
      sjres: "senate-joint-resolution",
      hconres: "house-concurrent-resolution",
      sconres: "senate-concurrent-resolution"
    };
    return map[t] || `${t}-bill`;
  }

  function congressGovBillUrl(doc) {
    const parsed = parseBillId(doc?.id) || parseBillId(`${doc?.congress || ""}-${doc?.type || ""}-${doc?.number || ""}`);
    if (!parsed) return "";
    return `https://www.congress.gov/bill/${parsed.congress}th-congress/${billTypeToSlug(parsed.type)}/${parsed.number}`;
  }

  async function fetchBillById(id) {
    const cleanId = String(id || "").trim();
    if (!cleanId) return null;

    const parsed = (() => {
      const parts = cleanId.split("-").filter(Boolean);
      if (parts.length < 3) return null;
      const congress = Number.parseInt(parts[0], 10);
      const number = Number.parseInt(parts[parts.length - 1], 10);
      const type = parts.slice(1, parts.length - 1).join("-").toLowerCase();
      if (!Number.isFinite(congress) || !Number.isFinite(number) || !type) return null;
      return { congress, number, type };
    })();

    async function runSearchAttempt(label, filterBy) {
      const params = new URLSearchParams({
        q: "*",
        query_by: "title,ai_summary_text",
        per_page: "1",
        page: "1",
        filter_by: filterBy,
        include_fields: BILL_INCLUDE_FIELDS
      });

      const url = `${TS_DOCS_SEARCH}?${params.toString()}`;
      console.info(`[bill] ${label}: GET ${url}`);
      const res = await fetch(url);
      const bodyText = await res.text().catch(() => "");
      console.info(`[bill] ${label}: status ${res.status}`);

      if (!res.ok) {
        console.warn(`[bill] ${label}: failed response`, bodyText || "(no body)");
        throw new Error(`${label} failed HTTP ${res.status}: ${bodyText || "(no body)"}`);
      }

      let json;
      try {
        json = bodyText ? JSON.parse(bodyText) : {};
      } catch (parseErr) {
        console.warn(`[bill] ${label}: invalid JSON`, parseErr);
        throw new Error(`${label} returned invalid JSON.`);
      }

      const hits = json?.hits || [];
      console.info(`[bill] ${label}: hits=${hits.length}`);
      return hits[0]?.document || null;
    }

    const directAttempts = [
      { label: "exact-id-search", filterBy: `id:=${escFilterVal(cleanId)}` },
      { label: "lowercase-id-search", filterBy: `id:=${escFilterVal(cleanId.toLowerCase())}` }
    ];

    if (parsed) {
      directAttempts.push(
        {
          label: "bill-fields-search",
          filterBy: `congress:=${parsed.congress} && type:=${escFilterVal(parsed.type)} && number:=${parsed.number}`
        },
        {
          label: "bill-fields-uppercase-type-search",
          filterBy: `congress:=${parsed.congress} && type:=${escFilterVal(parsed.type.toUpperCase())} && number:=${parsed.number}`
        }
      );
    }

    const uniqueAttempts = directAttempts.filter((attempt, i, arr) =>
      attempt.filterBy && arr.findIndex((a) => a.filterBy === attempt.filterBy) === i
    );

    let lastError = null;
    for (const attempt of uniqueAttempts) {
      try {
        const doc = await runSearchAttempt(attempt.label, attempt.filterBy);
        if (doc) {
          console.info(`[bill] ${attempt.label}: found document`, doc.id);
          return doc;
        }
        console.info(`[bill] ${attempt.label}: no matching document`);
      } catch (err) {
        lastError = err;
        console.warn(`[bill] ${attempt.label}: lookup error`, err);
      }
    }

    const multiSearchBody = {
      searches: uniqueAttempts.map((attempt) => ({
        collection: COLLECTION,
        q: "*",
        query_by: "title,ai_summary_text",
        per_page: 1,
        page: 1,
        filter_by: attempt.filterBy,
        include_fields: BILL_INCLUDE_FIELDS
      }))
    };

    if (!multiSearchBody.searches.length) return null;

    console.info("[bill] multi-search-fallback: POST", multiSearchBody);
    const multiRes = await fetch(TS_MULTI_SEARCH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(multiSearchBody)
    });

    const multiBodyText = await multiRes.text().catch(() => "");
    console.info(`[bill] multi-search-fallback: status ${multiRes.status}`);
    if (!multiRes.ok) {
      console.warn("[bill] multi-search-fallback: failed response", multiBodyText || "(no body)");
      const lastErrMsg = lastError ? ` Previous error: ${lastError.message}` : "";
      throw new Error(`multi-search-fallback failed HTTP ${multiRes.status}: ${multiBodyText || "(no body)"}.${lastErrMsg}`);
    }

    let multiJson;
    try {
      multiJson = multiBodyText ? JSON.parse(multiBodyText) : {};
    } catch (parseErr) {
      console.warn("[bill] multi-search-fallback: invalid JSON", parseErr);
      throw new Error("multi-search-fallback returned invalid JSON.");
    }

    const results = multiJson?.results || [];
    console.info(`[bill] multi-search-fallback: results=${results.length}`);
    for (let i = 0; i < results.length; i += 1) {
      const resultHits = results[i]?.hits || [];
      console.info(`[bill] multi-search-fallback: result[${i}] hits=${resultHits.length}`);
      if (resultHits[0]?.document) {
        console.info("[bill] multi-search-fallback: found document", resultHits[0].document.id);
        return resultHits[0].document;
      }
    }

    if (lastError) {
      console.warn("[bill] lookup completed with prior errors and no document match", lastError);
    }
    return null;
  }


  async function embedText(text) {
    const res = await fetch(OA_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: text })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Embeddings failed HTTP ${res.status}: ${txt}`);
    }
    const json = await res.json();
    return json?.data?.[0]?.embedding || [];
  }

  async function fetchRelatedBills(doc) {
    const input = [
      doc?.title || "",
      doc?.ai_summary_text || "",
      doc?.official_summary_text || doc?.official_summary || "",
      doc?.policy_area ? `Policy area: ${doc.policy_area}` : "",
      doc?.latest_action_text ? `Latest action: ${doc.latest_action_text}` : ""
    ].filter(Boolean).join("\n");

    let vector = [];
    try {
      vector = await embedText(input || doc?.title || doc?.id || "");
    } catch (e) {
      console.warn("Related embeddings failed; falling back to text query.", e);
    }

    const searchObj = {
      collection: COLLECTION,
      q: doc?.title || "*",
      query_by: "title,ai_summary_text,policy_area,subjects,committees,latest_action_text",
      per_page: 8,
      page: 1,
      sort_by: "_text_match:desc,update_date:desc",
      include_fields: "id,title,type,number,status,chamber,update_date,ai_summary_text,sponsor_party",
      exclude_fields: "embedding",
      filter_by: `id:!=${escFilterVal(doc?.id || "")}`
    };

    if (Array.isArray(vector) && vector.length) {
      searchObj.vector_query = `embedding:([${vector.join(",")}], alpha:${DEFAULT_ALPHA})`;
      searchObj.rerank_hybrid_matches = true;
    }

    const res = await fetch(TS_MULTI_SEARCH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searches: [searchObj] })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Related search failed HTTP ${res.status}: ${txt}`);
    }

    const json = await res.json();
    return (json?.results?.[0]?.hits || []).map(h => h.document).filter(Boolean);
  }

  function renderBillDetail(doc, congressUrlOverride, cosponsors) {
    const mount = document.getElementById("billMain");
    if (!mount) return;

    if (!doc) {
      mount.innerHTML = `<div class="panel__body"><div class="muted">Bill not found.</div></div>`;
      return;
    }

    const short = `${String(doc.type || "").toUpperCase()} ${String(doc.number || "")}`.trim() || doc.id;
    const committee = Array.isArray(doc.committees) && doc.committees.length ? doc.committees[0] : "";
    const partyLabel = sponsorPartyLabel(doc.sponsor_party);
    const partyClass = sponsorDotClass(doc.sponsor_party);
    const officialSummary = doc.official_summary_text || doc.official_summary || "Official summary unavailable in index data.";
    const congressUrl = congressUrlOverride || congressGovBillUrl(doc);
    const list = Array.isArray(cosponsors) ? cosponsors : [];
    const originals = list.filter((c) => c.isOriginalCosponsor);
    const shown = originals.length ? originals : list.slice(0, 1);
    const hidden = list.filter((c) => !shown.includes(c));

    mount.innerHTML = `
      <div class="panel__body">
        <article class="bill-detail">
          <span class="${partyClass} billcard__party-dot" aria-hidden="true"></span>

          <div class="bill-detail__head">
            <span class="chip">${escHtml(short)}</span>
            ${doc.status ? `<span class="chip billcard__tag">${escHtml(titleCaseFromToken(doc.status))}</span>` : ""}
          </div>

          <h1 class="bill-detail__title">${escHtml(doc.title || "(Untitled bill)")}</h1>

          <div class="bill-detail__facts">
            ${doc.chamber ? `<div class="bill-detail__fact"><div class="bill-detail__fact-label">Chamber</div><div class="bill-detail__fact-value">${escHtml(doc.chamber)}</div></div>` : ""}
            ${doc.congress ? `<div class="bill-detail__fact"><div class="bill-detail__fact-label">Congress</div><div class="bill-detail__fact-value">${escHtml(String(doc.congress))}th Congress</div></div>` : ""}
            ${committee ? `<div class="bill-detail__fact"><div class="bill-detail__fact-label">Committee</div><div class="bill-detail__fact-value">${escHtml(committee)}</div></div>` : ""}
            ${doc.policy_area ? `<div class="bill-detail__fact"><div class="bill-detail__fact-label">Policy area</div><div class="bill-detail__fact-value">${escHtml(doc.policy_area)}</div></div>` : ""}
            <div class="bill-detail__fact"><div class="bill-detail__fact-label">Sponsor party</div><div class="bill-detail__fact-value">${escHtml(partyLabel)}</div></div>
            ${Number.isFinite(doc.cosponsor_count) ? `<div class="bill-detail__fact"><div class="bill-detail__fact-label">Cosponsors</div><div class="bill-detail__fact-value">${escHtml(String(doc.cosponsor_count))}</div></div>` : ""}
            <div class="bill-detail__fact"><div class="bill-detail__fact-label">Updated</div><div class="bill-detail__fact-value">${escHtml(epochToDate(doc.update_date) || "N/A")}</div></div>
            ${doc.status ? `<div class="bill-detail__fact"><div class="bill-detail__fact-label">Status</div><div class="bill-detail__fact-value">${escHtml(titleCaseFromToken(doc.status))}</div></div>` : ""}
          </div>

          <section class="bill-detail__section">
            <h2 class="bill-detail__sectiontitle">AI summary</h2>
            <p class="bill-detail__summary">${escHtml(doc.ai_summary_text || "AI summary unavailable.")}</p>
          </section>

          <section class="bill-detail__section">
            <h2 class="bill-detail__sectiontitle">Official summary</h2>
            <p class="bill-detail__summary">${escHtml(officialSummary)}</p>
          </section>

          ${doc.latest_action_text ? `
            <section class="bill-detail__section">
              <h2 class="bill-detail__sectiontitle">Latest action</h2>
              <p class="bill-detail__summary">${escHtml(doc.latest_action_text)}</p>
            </section>
          ` : ""}

          ${list.length ? `
            <section class="bill-detail__section">
              <h2 class="bill-detail__sectiontitle">Sponsors & cosponsors</h2>
              <ul class="bill-cosponsors">
                ${shown.map((c) => `<li class="bill-cosponsor"><span class="bill-cosponsor__name">${escHtml(c.fullName)}</span>${c.sponsorshipDate ? `<span class="bill-cosponsor__meta muted">Joined ${escHtml(c.sponsorshipDate)}</span>` : ""}</li>`).join("")}
                ${hidden.map((c) => `<li class="bill-cosponsor bill-cosponsor--extra" hidden><span class="bill-cosponsor__name">${escHtml(c.fullName)}</span>${c.sponsorshipDate ? `<span class="bill-cosponsor__meta muted">Joined ${escHtml(c.sponsorshipDate)}</span>` : ""}</li>`).join("")}
              </ul>
              ${hidden.length ? `<button type="button" class="bill-cosponsors__toggle" id="billCosponsorsToggle" data-expanded="0">Show all cosponsors (${list.length})</button>` : ""}
            </section>
          ` : ""}

          ${congressUrl ? `<div class="bill-detail__actions"><a class="bill-detail__button" href="${escHtml(congressUrl)}" target="_blank" rel="noopener noreferrer">View on Congress.gov</a></div>` : ""}
        </article>
      </div>
    `;
  }

  async function fetchCongressJson(path, params = {}) {
    const url = new URL(CONGRESS_PROXY_URL);
    url.searchParams.set("path", path);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    });

    console.info("[bill-text] GET", url.toString());
    const res = await fetch(url.toString());
    const text = await res.text().catch(() => "");
    console.info(`[bill-text] status ${res.status} for ${path}`);
    if (!res.ok) throw new Error(`Congress proxy failed HTTP ${res.status}: ${text || "(no body)"}`);

    try {
      return text ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error(`Congress proxy returned invalid JSON for ${path}`);
    }
  }

  async function fetchCongressPermalink(doc) {
    const parsed = parseBillId(doc?.id) || parseBillId(`${doc?.congress || ""}-${doc?.type || ""}-${doc?.number || ""}`);
    const fallback = congressGovBillUrl(doc);
    if (!parsed) return fallback;

    try {
      const json = await fetchCongressJson(`/v3/bill/${parsed.congress}/${parsed.type}/${parsed.number}`, { format: "json" });
      const candidate = json?.bill?.url || json?.url || "";
      if (candidate && /^https:\/\/www\.congress\.gov\//i.test(candidate)) {
        console.info("[bill] congress permalink from API", candidate);
        return candidate;
      }
    } catch (e) {
      console.warn("[bill] congress permalink lookup failed; using fallback", e);
    }

    return fallback;
  }

  function normalizeCosponsorsPayload(json) {
    const direct = Array.isArray(json?.cosponsors) ? json.cosponsors : [];
    const alt = Array.isArray(json?.bill?.cosponsors) ? json.bill.cosponsors : [];
    const anyArray = Object.values(json || {}).find((v) => Array.isArray(v) && v.some((x) => x && typeof x === "object" && (x.fullName || x.lastName)));
    const raw = direct.length ? direct : (alt.length ? alt : (Array.isArray(anyArray) ? anyArray : []));

    return raw.map((c) => ({
      fullName: c?.fullName || [c?.firstName, c?.lastName].filter(Boolean).join(" ") || "Unknown",
      party: c?.party || "",
      state: c?.state || "",
      district: c?.district,
      sponsorshipDate: c?.sponsorshipDate || "",
      isOriginalCosponsor: Boolean(c?.isOriginalCosponsor),
      bioguideId: c?.bioguidId || c?.bioguideId || ""
    }));
  }

  async function fetchBillCosponsors(doc) {
    const parsed = parseBillId(doc?.id) || parseBillId(`${doc?.congress || ""}-${doc?.type || ""}-${doc?.number || ""}`);
    if (!parsed) return [];
    try {
      const json = await fetchCongressJson(`/v3/bill/${parsed.congress}/${parsed.type}/${parsed.number}/cosponsors`, { format: "json", limit: 250 });
      const normalized = normalizeCosponsorsPayload(json);
      console.info(`[bill] cosponsors fetched count=${normalized.length}`);
      return normalized;
    } catch (e) {
      console.warn("[bill] cosponsors fetch failed", e);
      return [];
    }
  }

  async function fetchHtmlDocumentFromUrl(rawUrl) {
    if (!rawUrl) return "";

    const parsed = new URL(rawUrl);
    let fetchUrl = rawUrl;

    if (parsed.hostname === "api.congress.gov") {
      const proxy = new URL(CONGRESS_PROXY_URL);
      proxy.searchParams.set("path", parsed.pathname);
      parsed.searchParams.forEach((v, k) => {
        if (k !== "api_key") proxy.searchParams.set(k, v);
      });
      fetchUrl = proxy.toString();
    }

    console.info("[bill-text] GET html", fetchUrl);
    const res = await fetch(fetchUrl, { headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" } });
    const html = await res.text().catch(() => "");
    console.info(`[bill-text] html status ${res.status}`);
    if (!res.ok) throw new Error(`HTML fetch failed HTTP ${res.status}`);

    return html;
  }

  async function fetchBillText(doc) {
    const parsed = parseBillId(doc?.id) || parseBillId(`${doc?.congress || ""}-${doc?.type || ""}-${doc?.number || ""}`);
    if (!parsed) return null;

    const indexData = await fetchCongressJson(`/v3/bill/${parsed.congress}/${parsed.type}/${parsed.number}/text`, { format: "json", limit: 5 });
    const versions = indexData?.textVersions || indexData?.bill?.textVersions || [];
    if (!Array.isArray(versions) || !versions.length) {
      return { summary: "No bill text versions were returned by Congress.gov.", html: "", pdfUrl: "" };
    }

    const latest = versions[0] || {};
    const textFormats = Array.isArray(latest.formats) ? latest.formats : [];
    const htmlFormat = textFormats.find((f) => /formatted\s*text|html/i.test(String(f?.type || f?.format || ""))) || textFormats.find((f) => /htm/i.test(String(f?.url || ""))) || null;
    const pdfFormat = textFormats.find((f) => /pdf/i.test(String(f?.type || f?.format || ""))) || textFormats.find((f) => /\.pdf(\?|$)/i.test(String(f?.url || ""))) || null;

    let html = "";
    if (htmlFormat?.url) {
      try {
        html = await fetchHtmlDocumentFromUrl(htmlFormat.url);
      } catch (e) {
        console.warn("[bill-text] formatted HTML fetch failed", e);
      }
    }

    const issued = latest?.date || latest?.issuedOn || latest?.updateDate || "";
    const title = latest?.type || latest?.name || "Latest version";
    const summary = `${title}${issued ? ` • ${issued}` : ""}`;

    return {
      summary,
      html,
      pdfUrl: pdfFormat?.url || ""
    };
  }

  function renderBillText(textData, doc, cosponsors) {
    const mount = document.getElementById("billFullText");
    if (!mount) return;

    if (!doc) {
      mount.innerHTML = `<div class="panel__head"><div class="panel__title">Bill text</div></div><div class="panel__body"><div class="muted">Load a bill to view text metadata.</div></div>`;
      return;
    }

    if (!textData) {
      mount.innerHTML = `<div class="panel__head"><div class="panel__title">Bill text</div></div><div class="panel__body"><div class="muted">No bill text data found.</div></div>`;
      return;
    }

    const pdfButton = textData.pdfUrl
      ? `<a class="bill-text__pdfbtn" href="${escHtml(textData.pdfUrl)}" target="_blank" rel="noopener noreferrer">Open PDF</a>`
      : "";

    const bodyHtml = textData.html
      ? `<div class="bill-text__html">${textData.html}</div>`
      : `<p class="bill-text__content">${escHtml(textData.summary || "Bill text loaded, but formatted HTML was unavailable.")}</p>`;

    mount.innerHTML = `
      <div class="panel__head bill-text__head">
        <div class="panel__title">Bill text</div>
        ${pdfButton}
      </div>
      <div class="panel__body">
        <section class="bill-qa">
          <div class="bill-qa__title">Ask a question about the bill</div>
          <div id="billQaMessages" class="bill-qa__messages"></div>
          <form id="billQaForm" class="bill-qa__form">
            <input id="billQaInput" class="bill-qa__input" type="text" autocomplete="off" placeholder="Ask about this bill…" />
            <button type="submit" class="bill-qa__btn">Ask</button>
          </form>
        </section>
        ${bodyHtml}
      </div>
    `;

    wireBillQa(doc, textData, cosponsors);
  }


  async function generateBillAnswer({ doc, textData, question, history, cosponsors }) {
    const textSnippet = String(textData?.html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 10000);

    const prior = (history || [])
      .slice(-6)
      .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text}`)
      .join("\n");

    const prompt = [
      `Bill id: ${doc?.id || "unknown"}`,
      `Title: ${doc?.title || ""}`,
      `Status: ${doc?.status ? titleCaseFromToken(doc.status) : "Unknown"}`,
      `Sponsor party: ${sponsorPartyLabel(doc?.sponsor_party)}`,
      `Sponsor state: ${doc?.sponsor_state || ""}`,
      `Committee: ${Array.isArray(doc?.committees) && doc.committees.length ? doc.committees[0] : ""}`,
      `Policy area: ${doc?.policy_area || ""}`,
      `Cosponsors: ${Number.isFinite(doc?.cosponsor_count) ? doc.cosponsor_count : "Unknown"}`,
      `Latest action: ${doc?.latest_action_text || ""}`,
      `AI summary: ${doc?.ai_summary_text || ""}`,
      `Official summary: ${doc?.official_summary_text || doc?.official_summary || ""}`,
      `Bill text version: ${textData?.summary || ""}`,
      `Original cosponsors: ${(Array.isArray(cosponsors) ? cosponsors.filter((c) => c.isOriginalCosponsor) : []).map((c) => c.fullName).join("; ") || "Unknown"}`,
      textSnippet ? `Bill text excerpt: ${textSnippet}` : "",
      prior ? `Conversation so far:
${prior}` : "",
      `User question: ${question}`,
      "Answer clearly and concisely. If unknown from the provided bill context, say so."
    ].filter(Boolean).join("\n\n");

    const res = await fetch(OA_RESPONSES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ANSWER_MODEL,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: "You are a helpful legislative assistant focused on a single bill." }]
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
      throw new Error(`Bill answer failed HTTP ${res.status}: ${txt}`);
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

  function appendBillQaMessage(role, text, pending) {
    const mount = document.getElementById("billQaMessages");
    if (!mount) return null;

    const row = document.createElement("div");
    row.className = `bill-qa__row ${role === "user" ? "bill-qa__row--user" : "bill-qa__row--assistant"}`;

    const bubble = document.createElement("div");
    bubble.className = `bill-qa__bubble ${role === "user" ? "bill-qa__bubble--user" : "bill-qa__bubble--assistant"}`;
    if (pending) {
      bubble.innerHTML = `<span class="muted">${escHtml(text || "Thinking…")}</span>`;
    } else if (role === "user") {
      bubble.textContent = String(text || "");
    } else {
      bubble.innerHTML = window.simpleMarkdownToHTML ? window.simpleMarkdownToHTML(text || "") : parseTextToHtml(text || "");
    }

    row.appendChild(bubble);
    mount.appendChild(row);
    mount.scrollTop = mount.scrollHeight;
    return bubble;
  }

  function wireBillQa(doc, textData, cosponsors) {
    billQaState.currentDoc = doc;
    billQaState.currentTextData = textData;
    billQaState.history = [];
    billQaState.currentCosponsors = Array.isArray(cosponsors) ? cosponsors : [];

    const askForm = document.getElementById("billQaForm");
    const askInput = document.getElementById("billQaInput");
    const messages = document.getElementById("billQaMessages");
    if (!askForm || !askInput || !messages) return;

    askForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = String(askInput.value || "").trim();
      if (!q) return;
      askInput.value = "";

      appendBillQaMessage("user", q);
      const pendingBubble = appendBillQaMessage("assistant", "Generating answer…", true);

      try {
        const answer = await generateBillAnswer({
          doc: billQaState.currentDoc,
          textData: billQaState.currentTextData,
          question: q,
          history: billQaState.history,
          cosponsors: billQaState.currentCosponsors
        });

        billQaState.history.push({ role: "user", text: q });
        billQaState.history.push({ role: "assistant", text: answer });

        if (pendingBubble) {
          pendingBubble.innerHTML = window.simpleMarkdownToHTML
            ? window.simpleMarkdownToHTML(answer || "")
            : parseTextToHtml(answer || "");
        }
      } catch (err) {
        console.warn("[bill-qa] failed", err);
        if (pendingBubble) pendingBubble.innerHTML = `<span class="muted">I couldn't answer that right now. Please try again.</span>`;
      }
    });
  }


  function wireCosponsorsToggle() {
    const btn = document.getElementById("billCosponsorsToggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const expanded = btn.getAttribute("data-expanded") === "1";
      const extras = document.querySelectorAll(".bill-cosponsor--extra");
      const baseCount = document.querySelectorAll(".bill-cosponsor:not(.bill-cosponsor--extra)").length;
      extras.forEach((el) => {
        if (expanded) el.setAttribute("hidden", "");
        else el.removeAttribute("hidden");
      });
      btn.setAttribute("data-expanded", expanded ? "0" : "1");
      btn.textContent = expanded ? `Show all cosponsors (${baseCount + extras.length})` : "Show fewer";
    });
  }


  function renderRelated(list) {
    const mount = document.getElementById("relatedBills");
    if (!mount) return;

    if (!list.length) {
      mount.innerHTML = `<div class="muted">No related bills found.</div>`;
      return;
    }

    mount.innerHTML = list.map((d) => {
      const short = `${String(d.type || "").toUpperCase()} ${String(d.number || "")}`.trim() || d.id;
      const partyClass = sponsorDotClass(d.sponsor_party);
      return `
        <a class="related-item" href="./bill.html?id=${encodeURIComponent(d.id)}">
          <span class="${partyClass} related-item__dot" aria-hidden="true"></span>
          <div class="related-item__top">
            <span class="chip billcard__tag">${escHtml(short)}</span>
            </div>
          <div class="related-item__title">${escHtml(d.title || "(Untitled bill)")}</div>
          ${d.status ? `<div class="related-item__sub muted">${escHtml(titleCaseFromToken(d.status))}</div>` : ""}
          <div class="related-item__date muted">${escHtml(epochToDate(d.update_date) || "")}</div>
        </a>
      `;
    }).join("");
  }

  async function boot() {
    const id = getParam("id");
    if (!id) {
      renderBillDetail(null);
      renderBillText(null, null);
      const mount = document.getElementById("relatedBills");
      if (mount) mount.innerHTML = `<div class="muted">Add ?id=... to the URL to load a bill.</div>`;
      return;
    }

    try {
      const doc = await fetchBillById(id);
      if (!doc) {
        renderBillDetail(null);
        return;
      }

      const congressPermalink = await fetchCongressPermalink(doc);
      const cosponsors = await fetchBillCosponsors(doc);
      renderBillDetail(doc, congressPermalink, cosponsors);
      wireCosponsorsToggle();

      try {
        const textData = await fetchBillText(doc);
        renderBillText(textData, doc, cosponsors);
      } catch (textErr) {
        console.warn("[bill-text] failed to load bill text", textErr);
        renderBillText({ summary: "Failed to load bill text from Congress.gov proxy.", html: "", pdfUrl: "" }, doc, cosponsors);
      }

      const related = await fetchRelatedBills(doc);
      renderRelated(related);
    } catch (e) {
      console.error(e);
      const main = document.getElementById("billMain");
      if (main) main.innerHTML = `<div class="panel__body"><div class="muted">Failed to load bill details.</div></div>`;
      const textMount = document.getElementById("billFullText");
      if (textMount) textMount.innerHTML = `<div class="panel__head"><div class="panel__title">Bill text</div></div><div class="panel__body"><div class="muted">Failed to load bill text.</div></div>`;
      const rail = document.getElementById("relatedBills");
      if (rail) rail.innerHTML = `<div class="muted">Failed to load related bills.</div>`;
    }
  }

  if (window.onReady) window.onReady(boot);
  else document.addEventListener("DOMContentLoaded", boot);
})();
