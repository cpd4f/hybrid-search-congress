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

window.APP_CONFIG = {

  WORKER_BASE: "https://ai-search-keys.webmaster-cba.workers.dev",

  TYPESENSE_INDEX: "congress_bills",

  RESULTS_PER_PAGE: 20,

  RECENT_BILLS_LIMIT: 12

};


/* ---------------------------------------------------
   ENDPOINTS
--------------------------------------------------- */

window.API = {

  TYPESENSE: `${APP_CONFIG.WORKER_BASE}/typesense`,
  OPENAI: `${APP_CONFIG.WORKER_BASE}/openai`,
  PINECONE: `${APP_CONFIG.WORKER_BASE}/pinecone/query`

};


/* ---------------------------------------------------
   UTILITIES
--------------------------------------------------- */

window.utils = {

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

window.debug = {

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
