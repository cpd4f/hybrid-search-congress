/* ---------------------------------------------------
   BASE APP BOOTSTRAP
--------------------------------------------------- */

/* Load jQuery if not already loaded */

(function () {

  if (window.jQuery) {
    console.log("jQuery already loaded");
    return;
  }

  const script = document.createElement("script");
  script.src = "https://code.jquery.com/jquery-3.7.1.min.js";
  script.integrity = "sha256-/JqT3SQfawRcv/BIHPThkBvs0OEvtFFmqPF/lYI/Cxo=";
  script.crossOrigin = "anonymous";

  script.onload = function () {
    console.log("jQuery loaded");
  };

  document.head.appendChild(script);

})();


/* ---------------------------------------------------
   GLOBAL CONFIG
--------------------------------------------------- */

window.APP_CONFIG = window.APP_CONFIG || {

  // NOTE: you are no longer using this combined key worker in this project,
  // but leaving it here is harmless if other scripts reference it.
  WORKER_BASE: "https://ai-search-keys.webmaster-cba.workers.dev",

  TYPESENSE_INDEX: "congress_bills",

  RESULTS_PER_PAGE: 20,

  RECENT_BILLS_LIMIT: 12,

  PromoteME: true

};


/* ---------------------------------------------------
   ENDPOINTS
--------------------------------------------------- */

window.API = window.API || {

  TYPESENSE: `${APP_CONFIG.WORKER_BASE}/typesense`,
  OPENAI: `${APP_CONFIG.WORKER_BASE}/openai`,
  PINECONE: `${APP_CONFIG.WORKER_BASE}/pinecone/query`

};


/* ---------------------------------------------------
   UTILITIES
--------------------------------------------------- */

window.utils = window.utils || {

  getParam(name) {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  },

  truncate(text, length = 120) {
    if (!text) return "";
    if (text.length <= length) return text;
    return text.substring(0, length) + "...";
  },

  formatDate(dateString) {
    if (!dateString) return "";
    const d = new Date(dateString);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

};


/* ---------------------------------------------------
   DEBUG
--------------------------------------------------- */

window.debug = window.debug || {

  log(...args) {
    if (window.APP_DEBUG) {
      console.log(...args);
    }
  }

};


/* ---------------------------------------------------
   DOM READY HELPER
--------------------------------------------------- */

window.onReady = function (callback) {

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback);
  } else {
    callback();
  }

};


/* ---------------------------------------------------
   SNAP CAROUSEL (RECENT BILLS)
   Requirements:
   - Button click snaps by "page" (4 desktop, 2 tablet, 1 mobile)
   - Swipe allowed, but snaps to nearest page on release
   - Prevent "half cut" resting positions
--------------------------------------------------- */

(function () {

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function getPerPage() {
    const w = window.innerWidth;
    if (w >= 980) return 3;
    if (w >= 720) return 2;
    return 1;
  }

  function ensureCarouselStructure(viewport) {
    // We support two possible markups:
    // A) New: #recentBills is the viewport and contains .carousel__track/pages
    // B) Old: #recentBills directly contains .billcard nodes
    //
    // This function will wrap cards into pages if needed.

    if (!viewport) return;

    const hasTrack = viewport.querySelector(".carousel__track");
    if (hasTrack) return;

    const cards = qsa(".billcard", viewport);
    if (!cards.length) return;

    const perPage = getPerPage();

    const track = document.createElement("div");
    track.className = "carousel__track";

    for (let i = 0; i < cards.length; i += perPage) {
      const page = document.createElement("div");
      page.className = "carousel__page";
      page.setAttribute("data-page", String(i / perPage));

      cards.slice(i, i + perPage).forEach(card => page.appendChild(card));
      track.appendChild(page);
    }

    viewport.innerHTML = "";
    viewport.appendChild(track);
  }

  function getPageCount(viewport) {
    const track = viewport.querySelector(".carousel__track");
    if (!track) return 0;
    return track.querySelectorAll(".carousel__page").length;
  }

  function pageWidth(viewport) {
    // Each "page" is designed to be 100% of the viewport width
    return viewport.getBoundingClientRect().width;
  }

  function currentPage(viewport) {
    const w = pageWidth(viewport);
    if (!w) return 0;
    return Math.round(viewport.scrollLeft / w);
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function scrollToPage(viewport, pageIndex) {
    const count = getPageCount(viewport);
    const max = Math.max(0, count - 1);
    const target = clamp(pageIndex, 0, max);

    const w = pageWidth(viewport);
    viewport.scrollTo({ left: target * w, behavior: "smooth" });

    return target;
  }

  function updateButtons(viewport, prevBtn, nextBtn) {
    const count = getPageCount(viewport);
    const max = Math.max(0, count - 1);
    const idx = currentPage(viewport);

    if (prevBtn) prevBtn.disabled = idx <= 0;
    if (nextBtn) nextBtn.disabled = idx >= max;
  }

  function snapToNearestPage(viewport) {
    // Called on touchend / mouseup / scroll-end debounce
    const idx = currentPage(viewport);
    scrollToPage(viewport, idx);
  }

  function bindCarousel() {
    const viewport = qs("#recentBills");
    if (!viewport) return;

    // Buttons (your HTML uses these)
    const prevBtn = qs('[data-carousel="prev"]');
    const nextBtn = qs('[data-carousel="next"]');

    // If you didn't apply the new viewport class in HTML, apply the needed behavior anyway.
    // (CSS should ideally set overflow + snap on #recentBills via .carousel__viewport, but this helps.)
    viewport.style.scrollSnapType = "x mandatory";
    viewport.style.scrollBehavior = "smooth";
    viewport.style.overscrollBehaviorX = "contain";

    // Wrap cards when they arrive (ai-search loads async)
    const observer = new MutationObserver(() => {
      ensureCarouselStructure(viewport);
      updateButtons(viewport, prevBtn, nextBtn);
    });

    observer.observe(viewport, { childList: true, subtree: true });

    // Click handlers
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        ensureCarouselStructure(viewport);
        const idx = currentPage(viewport);
        scrollToPage(viewport, idx - 1);
        setTimeout(() => updateButtons(viewport, prevBtn, nextBtn), 250);
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        ensureCarouselStructure(viewport);
        const idx = currentPage(viewport);
        scrollToPage(viewport, idx + 1);
        setTimeout(() => updateButtons(viewport, prevBtn, nextBtn), 250);
      });
    }

    // Snap after swipe/drag ends
    let snapping = false;
    let snapTimer = null;

    function scheduleSnap() {
      if (snapping) return;
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        snapping = true;
        snapToNearestPage(viewport);
        setTimeout(() => {
          snapping = false;
          updateButtons(viewport, prevBtn, nextBtn);
        }, 220);
      }, 110);
    }

    viewport.addEventListener("scroll", () => {
      updateButtons(viewport, prevBtn, nextBtn);
      scheduleSnap();
    }, { passive: true });

    viewport.addEventListener("touchend", () => {
      ensureCarouselStructure(viewport);
      snapToNearestPage(viewport);
      updateButtons(viewport, prevBtn, nextBtn);
    }, { passive: true });

    viewport.addEventListener("mouseup", () => {
      ensureCarouselStructure(viewport);
      snapToNearestPage(viewport);
      updateButtons(viewport, prevBtn, nextBtn);
    });

    // Rebuild pages on breakpoint changes
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const track = viewport.querySelector(".carousel__track");
        if (!track) return;

        // Extract all cards, rebuild with new perPage
        const cards = qsa(".billcard", viewport);
        viewport.innerHTML = "";
        cards.forEach(c => viewport.appendChild(c));

        ensureCarouselStructure(viewport);
        viewport.scrollTo({ left: 0, behavior: "auto" });
        updateButtons(viewport, prevBtn, nextBtn);
      }, 180);
    });

    // Initial
    ensureCarouselStructure(viewport);
    updateButtons(viewport, prevBtn, nextBtn);
  }

  // Use your onReady helper so it runs in the same boot order as before
  window.onReady(function () {
    bindCarousel();
  });

})();

window.onReady(function () {

  const promoSetting = window.APP_CONFIG && window.APP_CONFIG.PromoteME;
  const showPromotion = ![false, "false", "0", 0, "off", "no"].includes(promoSetting);

  if (!showPromotion) {
    const promoSelectors = [
      'a.footer__link[href="https://colemanpdavis.com"]',
      'a.footer__iconlink[href="https://www.linkedin.com/in/coleman-davis-2bab1128/"]'
    ];

    promoSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        el.style.display = "none";
      });
    });
  }

});


