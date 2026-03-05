(function () {
  "use strict";

  const TYPESENSE_WORKER_BASE = "https://typesense-proxy-worker.colemandavis4.workers.dev";
  const OPENAI_WORKER_BASE = "https://openai-proxy-worker.colemandavis4.workers.dev";

  const COLLECTION = (window.APP_CONFIG && window.APP_CONFIG.TYPESENSE_INDEX) || "congress_bills";
  const EMBED_MODEL = (window.APP_CONFIG && window.APP_CONFIG.OPENAI_EMBED_MODEL) || "text-embedding-3-large";
  const DEFAULT_ALPHA = (window.APP_CONFIG && window.APP_CONFIG.HYBRID_ALPHA) || 0.65;

  const TS_DOCS_SEARCH = `${TYPESENSE_WORKER_BASE.replace(/\/$/, "")}/collections/${encodeURIComponent(COLLECTION)}/documents/search`;
  const TS_MULTI_SEARCH = `${TYPESENSE_WORKER_BASE.replace(/\/$/, "")}/multi_search`;
  const OA_EMBED_URL = `${OPENAI_WORKER_BASE.replace(/\/$/, "")}/embeddings`;

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

  async function fetchBillById(id) {
    const params = new URLSearchParams({
      q: "*",
      query_by: "title,ai_summary_text",
      per_page: "1",
      page: "1",
      filter_by: `id:=${escFilterVal(id)}`,
      include_fields: [
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
      ].join(",")
    });

    const res = await fetch(`${TS_DOCS_SEARCH}?${params.toString()}`);
    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Bill lookup failed HTTP ${res.status}: ${txt}`);
    }
    const json = await res.json();
    const hit = (json?.hits || [])[0];
    return hit?.document || null;
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

  function renderBillDetail(doc) {
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

    mount.innerHTML = `
      <div class="panel__body">
        <article class="bill-detail">
          <span class="${partyClass} billcard__party-dot" aria-hidden="true"></span>

          <div class="bill-detail__head">
            <span class="chip">${escHtml(short)}</span>
            ${doc.status ? `<span class="chip billcard__tag">${escHtml(titleCaseFromToken(doc.status))}</span>` : ""}
          </div>

          <h1 class="bill-detail__title">${escHtml(doc.title || "(Untitled bill)")}</h1>

          <div class="billcard__tagwrap">
            ${doc.chamber ? `<span class="chip billcard__tag">${escHtml(doc.chamber)}</span>` : ""}
            ${doc.congress ? `<span class="chip billcard__tag">${escHtml(String(doc.congress))}th Congress</span>` : ""}
            ${committee ? `<span class="chip billcard__tag">${escHtml(committee)}</span>` : ""}
            ${doc.policy_area ? `<span class="chip billcard__tag">${escHtml(doc.policy_area)}</span>` : ""}
            <span class="chip billcard__tag">${escHtml(partyLabel)}</span>
          </div>

          <div class="bill-detail__meta muted">
            ${doc.sponsor_state ? `Sponsor state: ${escHtml(doc.sponsor_state)} • ` : ""}
            ${Number.isFinite(doc.cosponsor_count) ? `Cosponsors: ${escHtml(String(doc.cosponsor_count))} • ` : ""}
            Updated: ${escHtml(epochToDate(doc.update_date) || "N/A")}
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
        </article>
      </div>
    `;
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
            <span class="muted">${escHtml(epochToDate(d.update_date))}</span>
          </div>
          <div class="related-item__title">${escHtml(d.title || "(Untitled bill)")}</div>
          ${d.status ? `<div class="related-item__sub muted">${escHtml(titleCaseFromToken(d.status))}</div>` : ""}
        </a>
      `;
    }).join("");
  }

  async function boot() {
    const id = getParam("id");
    if (!id) {
      renderBillDetail(null);
      const mount = document.getElementById("relatedBills");
      if (mount) mount.innerHTML = `<div class="muted">Add ?id=... to the URL to load a bill.</div>`;
      return;
    }

    try {
      const doc = await fetchBillById(id);
      renderBillDetail(doc);
      if (!doc) return;

      const related = await fetchRelatedBills(doc);
      renderRelated(related);
    } catch (e) {
      console.error(e);
      const main = document.getElementById("billMain");
      if (main) main.innerHTML = `<div class="panel__body"><div class="muted">Failed to load bill details.</div></div>`;
      const rail = document.getElementById("relatedBills");
      if (rail) rail.innerHTML = `<div class="muted">Failed to load related bills.</div>`;
    }
  }

  if (window.onReady) window.onReady(boot);
  else document.addEventListener("DOMContentLoaded", boot);
})();
