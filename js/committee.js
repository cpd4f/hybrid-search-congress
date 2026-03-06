(function () {
  "use strict";

  const TYPESENSE_WORKER_BASE = "https://typesense-proxy-worker.colemandavis4.workers.dev";
  const CONGRESS_WORKER_BASE = "https://congress-proxy.colemandavis4.workers.dev";
  const COLLECTION = (window.APP_CONFIG && window.APP_CONFIG.TYPESENSE_INDEX) || "congress_bills";

  const TS_DOCS_SEARCH = `${TYPESENSE_WORKER_BASE.replace(/\/$/, "")}/collections/${encodeURIComponent(COLLECTION)}/documents/search`;

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

  function getCommitteeName(item) {
    return String(item?.name || item?.committeeName || item?.officialName || "").trim();
  }

  function getCommitteeChamber(item) {
    return String(item?.chamber || item?.systemCode?.split("00")[0] || "Other").trim() || "Other";
  }


  function isMainCommittee(item) {
    const systemCode = String(item?.systemCode || "").toLowerCase();
    const hasParent = !!(item && item.parent && item.parent.systemCode);
    if (hasParent) return false;
    if (!systemCode) return true;
    return systemCode.endsWith("00");
  }

  function normalizeCommittees(payload) {
    const rows = payload?.committees || payload?.committee || payload?.items || [];
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((item) => isMainCommittee(item))
      .map((item) => ({
        name: getCommitteeName(item),
        chamber: getCommitteeChamber(item)
      }))
      .filter((item) => item.name)
      .sort((a, b) => {
        const chamberCmp = a.chamber.localeCompare(b.chamber);
        if (chamberCmp !== 0) return chamberCmp;
        return a.name.localeCompare(b.name);
      });
  }

  async function fetchCongressJson(path, extraParams = {}) {
    const u = new URL(CONGRESS_WORKER_BASE);
    u.searchParams.set("path", path);
    u.searchParams.set("format", "json");
    Object.keys(extraParams).forEach((key) => {
      if (extraParams[key] !== undefined && extraParams[key] !== null) {
        u.searchParams.set(key, String(extraParams[key]));
      }
    });

    const res = await fetch(u.toString());
    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Congress fetch failed HTTP ${res.status}: ${txt}`);
    }
    return res.json();
  }


  async function fetchAllCommittees() {
    const limit = 250;
    let offset = 0;
    const all = [];

    while (true) {
      const payload = await fetchCongressJson("/v3/committee", { limit, offset });
      const rows = payload?.committees || payload?.committee || payload?.items || [];
      if (!Array.isArray(rows) || !rows.length) break;

      all.push(...rows);

      if (rows.length < limit) break;
      offset += limit;

      if (offset > 5000) break;
    }

    return { committees: all };
  }

  async function fetchCommitteeBills(name) {
    const u = new URL(TS_DOCS_SEARCH);
    u.searchParams.set("q", "*");
    u.searchParams.set("query_by", "title,ai_summary_text");
    u.searchParams.set("per_page", "3");
    u.searchParams.set("page", "1");
    u.searchParams.set("sort_by", "update_date:desc");
    u.searchParams.set("include_fields", "id,title,type,number,update_date,sponsor_party");
    u.searchParams.set("filter_by", `committees:=[${JSON.stringify(name)}]`);

    const res = await fetch(u.toString());
    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Typesense bills fetch failed HTTP ${res.status}: ${txt}`);
    }

    const json = await res.json();
    return (json?.hits || []).map((h) => h.document).filter(Boolean);
  }

  function groupByChamber(committees) {
    const grouped = new Map();
    for (const committee of committees) {
      if (!grouped.has(committee.chamber)) grouped.set(committee.chamber, []);
      grouped.get(committee.chamber).push(committee);
    }
    for (const arr of grouped.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    return grouped;
  }

  function billLabel(bill) {
    const type = String(bill?.type || "").toUpperCase();
    const number = String(bill?.number || "");
    return [type, number].filter(Boolean).join(" ").trim() || bill?.id || "Bill";
  }


  function sponsorDotClass(party) {
    const p = String(party || "").toUpperCase();
    if (p === "R") return "party-dot party-dot--r";
    if (p === "D") return "party-dot party-dot--d";
    if (p === "I") return "party-dot party-dot--i";
    return "party-dot party-dot--u";
  }

  function render(grouped, billsByCommittee) {
    const mount = document.getElementById("committeeMount");
    if (!mount) return;

    if (!grouped.size) {
      mount.innerHTML = '<div class="panel"><div class="panel__body muted">No committees found.</div></div>';
      return;
    }

    const noBillsByChamber = new Map();

    const sections = Array.from(grouped.entries()).map(([chamber, committees]) => {
      const withBills = [];
      const withoutBills = [];

      committees.forEach((committee) => {
        const bills = billsByCommittee.get(committee.name) || [];
        if (!bills.length) {
          withoutBills.push(committee.name);
          return;
        }

        const billsHtml = bills.map((bill) => {
          const dotClass = sponsorDotClass(bill?.sponsor_party);
          return `
            <li class="committee-card__bill-item">
              <a class="committee-card__bill-title" href="./bill.html?id=${encodeURIComponent(bill.id || "")}">${escHtml(bill.title || "Untitled bill")}</a>
              <div class="committee-card__bill-meta">
                <span class="chip committee-card__chip"><span class="${dotClass} committee-card__dot" aria-hidden="true"></span>${escHtml(billLabel(bill))}</span>
                <span class="muted">${escHtml(epochToDate(bill.update_date))}</span>
              </div>
            </li>`;
        }).join("");

        const viewMore = `<a class="bill-detail__button committee-card__more" href="./feed.html?committee=${encodeURIComponent(committee.name)}">View More</a>`;

        withBills.push(`
          <article class="panel committee-card">
            <div class="panel__head">
              <div class="panel__title">${escHtml(committee.name)}</div>
            </div>
            <div class="panel__body">
              <ul class="committee-card__bill-list">${billsHtml}</ul>
              ${viewMore}
            </div>
          </article>
        `);
      });

      noBillsByChamber.set(chamber, withoutBills.slice().sort((a, b) => a.localeCompare(b)));

      const cards = withBills.join("");
      const body = cards || '<div class="panel"><div class="panel__body muted">No committees with active bills.</div></div>';

      return `
        <section class="committee-section">
          <h2 class="committee-section__title">${escHtml(chamber)}</h2>
          <div class="committee-grid">${body}</div>
        </section>
      `;
    }).join("");

    const houseNoBills = [];
    const senateNoBills = [];

    noBillsByChamber.forEach((items, chamber) => {
      const label = String(chamber || "").toLowerCase();
      if (label.includes("house")) houseNoBills.push(...items);
      else if (label.includes("senate")) senateNoBills.push(...items);
    });

    houseNoBills.sort((a, b) => a.localeCompare(b));
    senateNoBills.sort((a, b) => a.localeCompare(b));

    const renderNoBillsList = (items) => {
      if (!items.length) return '<div class="muted">None</div>';
      return `<ul class="committee-card__plain-list committee-card__plain-list--two-col">${items.map((name) => `<li>${escHtml(name)}</li>`).join("")}</ul>`;
    };

    const noBillsFooter = `
      <section class="committee-section committee-section--footer">
        <article class="panel committee-no-bills-footer">
          <div class="panel__head">
            <div class="panel__title">Committees without active bills</div>
          </div>
          <div class="panel__body committee-no-bills-footer__body">
            <details class="committee-no-bills-acc" open>
              <summary class="committee-no-bills-acc__summary">House Committees without Active Bills</summary>
              <div class="committee-no-bills-acc__content">${renderNoBillsList(houseNoBills)}</div>
            </details>
            <details class="committee-no-bills-acc" open>
              <summary class="committee-no-bills-acc__summary">Senate Committees without Active Bills</summary>
              <div class="committee-no-bills-acc__content">${renderNoBillsList(senateNoBills)}</div>
            </details>
          </div>
        </article>
      </section>
    `;

    mount.innerHTML = `${sections}${noBillsFooter}`;
  }

  async function boot() {
    const mount = document.getElementById("committeeMount");
    if (!mount) return;

    try {
      const payload = await fetchAllCommittees();
      const committees = normalizeCommittees(payload);
      const grouped = groupByChamber(committees);

      const billsByCommittee = new Map();
      await Promise.all(committees.map(async (committee) => {
        try {
          const bills = await fetchCommitteeBills(committee.name);
          billsByCommittee.set(committee.name, bills);
        } catch (err) {
          console.warn("committee bills failed", committee.name, err);
          billsByCommittee.set(committee.name, []);
        }
      }));

      render(grouped, billsByCommittee);
    } catch (err) {
      console.error(err);
      mount.innerHTML = '<div class="panel"><div class="panel__body muted">Could not load committees.</div></div>';
    }
  }

  if (window.onReady) window.onReady(boot);
  else document.addEventListener("DOMContentLoaded", boot);
})();
