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

  function normalizeCommittees(payload) {
    const rows = payload?.committees || payload?.committee || payload?.items || [];
    if (!Array.isArray(rows)) return [];
    return rows
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

  async function fetchCongressJson(path) {
    const u = new URL(CONGRESS_WORKER_BASE);
    u.searchParams.set("path", path);
    u.searchParams.set("format", "json");

    const res = await fetch(u.toString());
    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      throw new Error(`Congress fetch failed HTTP ${res.status}: ${txt}`);
    }
    return res.json();
  }

  async function fetchCommitteeBills(name) {
    const u = new URL(TS_DOCS_SEARCH);
    u.searchParams.set("q", "*");
    u.searchParams.set("query_by", "title,ai_summary_text");
    u.searchParams.set("per_page", "3");
    u.searchParams.set("page", "1");
    u.searchParams.set("sort_by", "update_date:desc");
    u.searchParams.set("include_fields", "id,title,type,number,update_date");
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

  function render(grouped, billsByCommittee) {
    const mount = document.getElementById("committeeMount");
    if (!mount) return;

    if (!grouped.size) {
      mount.innerHTML = '<div class="panel"><div class="panel__body muted">No committees found.</div></div>';
      return;
    }

    const sections = Array.from(grouped.entries()).map(([chamber, committees]) => {
      const cards = committees.map((committee) => {
        const bills = billsByCommittee.get(committee.name) || [];
        const billsHtml = bills.length
          ? bills.map((bill) => `
            <li class="committee-card__bill-item">
              <a href="./bill.html?id=${encodeURIComponent(bill.id || "")}">${escHtml(billLabel(bill))}</a>
              <span class="muted">${escHtml(epochToDate(bill.update_date))}</span>
            </li>`).join("")
          : '<li class="muted">No recent indexed bills.</li>';

        return `
          <article class="panel committee-card">
            <div class="panel__head">
              <div class="panel__title">${escHtml(committee.name)}</div>
            </div>
            <div class="panel__body">
              <ul class="committee-card__bill-list">${billsHtml}</ul>
              <a class="bill-detail__button committee-card__more" href="./index.html?committee=${encodeURIComponent(committee.name)}">View More</a>
            </div>
          </article>
        `;
      }).join("");

      return `
        <section class="committee-section">
          <h2 class="committee-section__title">${escHtml(chamber)}</h2>
          <div class="committee-grid">${cards}</div>
        </section>
      `;
    }).join("");

    mount.innerHTML = sections;
  }

  async function boot() {
    const mount = document.getElementById("committeeMount");
    if (!mount) return;

    try {
      const payload = await fetchCongressJson("/v3/committee");
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
