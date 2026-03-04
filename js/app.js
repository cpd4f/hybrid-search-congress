// app.js
(function () {
  "use strict";

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function getCardsPerPage() {
    const w = window.innerWidth;
    if (w >= 980) return 4;
    if (w >= 720) return 2;
    return 1;
  }

  function buildPagedCarousel(viewport) {
    if (!viewport) return;

    // Grab existing cards (ai-search injects <a class="billcard">…</a>)
    const cards = qsa(".billcard", viewport);

    // If no cards yet, do nothing
    if (!cards.length) return;

    // If we've already wrapped into pages, skip unless we need rebuild
    if (viewport.querySelector(".carousel__track")) return;

    const perPage = getCardsPerPage();

    // Create track
    const track = document.createElement("div");
    track.className = "carousel__track";

    // Move cards into pages
    for (let i = 0; i < cards.length; i += perPage) {
      const page = document.createElement("div");
      page.className = "carousel__page";
      page.setAttribute("data-page", String(i / perPage));

      const slice = cards.slice(i, i + perPage);
      slice.forEach(card => page.appendChild(card));

      track.appendChild(page);
    }

    // Clear viewport and mount track
    viewport.innerHTML = "";
    viewport.appendChild(track);
  }

  function rebuildIfNeeded(viewport) {
    if (!viewport) return;

    // If already built, but breakpoint changed, rebuild
    const track = viewport.querySelector(".carousel__track");
    if (!track) {
      buildPagedCarousel(viewport);
      return;
    }

    // Determine how many cards per page by checking first page length
    const firstPage = track.querySelector(".carousel__page");
    const currentPerPage = firstPage ? firstPage.children.length : 0;
    const desiredPerPage = getCardsPerPage();

    if (currentPerPage !== desiredPerPage) {
      // Extract cards back out and rebuild
      const cards = qsa(".billcard", viewport);
      viewport.innerHTML = "";
      cards.forEach(c => viewport.appendChild(c));
      buildPagedCarousel(viewport);
      viewport.scrollTo({ left: 0 });
    }
  }

  function getPageWidth(viewport) {
    // Each page is 100% of viewport width + gap handled by grid
    return viewport.getBoundingClientRect().width;
  }

  function getCurrentPageIndex(viewport) {
    const w = getPageWidth(viewport);
    if (!w) return 0;
    return Math.round(viewport.scrollLeft / w);
  }

  function scrollToPage(viewport, index) {
    const track = viewport.querySelector(".carousel__track");
    if (!track) return;

    const pages = qsa(".carousel__page", track);
    const max = Math.max(0, pages.length - 1);
    const clamped = Math.max(0, Math.min(index, max));

    const w = getPageWidth(viewport);
    viewport.scrollTo({ left: clamped * w, behavior: "smooth" });

    return clamped;
  }

  function updateButtons(viewport, prevBtn, nextBtn) {
    const track = viewport.querySelector(".carousel__track");
    if (!track) return;

    const pages = qsa(".carousel__page", track);
    const max = Math.max(0, pages.length - 1);
    const idx = getCurrentPageIndex(viewport);

    if (prevBtn) prevBtn.disabled = idx <= 0;
    if (nextBtn) nextBtn.disabled = idx >= max;
  }

  function bindCarouselControls() {
    const viewport = qs("#recentBills");
    const prevBtn = qs('[data-carousel="prev"]');
    const nextBtn = qs('[data-carousel="next"]');

    if (!viewport) return;

    // Build once cards exist
    const obs = new MutationObserver(() => {
      // ai-search injects cards; once present, wrap into pages
      buildPagedCarousel(viewport);
      updateButtons(viewport, prevBtn, nextBtn);
    });

    obs.observe(viewport, { childList: true, subtree: true });

    // Click nav
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        const idx = getCurrentPageIndex(viewport);
        scrollToPage(viewport, idx - 1);
        setTimeout(() => updateButtons(viewport, prevBtn, nextBtn), 250);
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        const idx = getCurrentPageIndex(viewport);
        scrollToPage(viewport, idx + 1);
        setTimeout(() => updateButtons(viewport, prevBtn, nextBtn), 250);
      });
    }

    // On scroll, keep buttons in sync
    viewport.addEventListener("scroll", () => {
      window.requestAnimationFrame(() => updateButtons(viewport, prevBtn, nextBtn));
    });

    // Rebuild on resize (breakpoint change)
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        rebuildIfNeeded(viewport);
        updateButtons(viewport, prevBtn, nextBtn);
      }, 150);
    });

    // Initial state
    rebuildIfNeeded(viewport);
    updateButtons(viewport, prevBtn, nextBtn);
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindCarouselControls();
  });
})();
