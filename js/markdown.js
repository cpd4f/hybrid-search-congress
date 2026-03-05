/* ---------------------------------------------------
   Minimal Markdown → HTML (SAFE)
   Supports:
   - **bold**
   - *italic*
   - [text](url)
   - Bullets (-, *)
   - Numbered lists (1.)  -> rendered as bullets (NOT headings / NOT numbered)
   - Paragraphs + line breaks
   Notes:
   - Escapes HTML first (safe)
   - Strips leading markdown heading markers (e.g., ###) because AI sometimes emits them
--------------------------------------------------- */

(function () {
  "use strict";

  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function stripHeadingMarkers(line) {
    // Remove leading markdown heading tokens like "#", "##", "###"
    return String(line || "").replace(/^\s*#{1,6}\s+/, "");
  }

  function inline(md) {
    let s = md;

    // Links [text](url)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, text, url) {
      return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
    });

    // Bold **text**
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Italic *text* (avoid catching bullet markers)
    s = s.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

    return s;
  }

  function simpleMarkdownToHTML(markdown) {
    const raw = escHtml(markdown || "");
    const lines = raw.split(/\r?\n/);

    const out = [];
    let inUL = false;

    function closeUL() {
      if (inUL) {
        out.push("</ul>");
        inUL = false;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      let line = stripHeadingMarkers(lines[i]);
      const t = line.trim();

      // Blank line = paragraph break
      if (!t) {
        closeUL();
        continue;
      }

      // Treat numbered list lines as bullets (avoid AI "1." formatting)
      const isNumbered = /^\d+\.\s+/.test(t);
      const isBullet = /^[-*]\s+/.test(t);

      if (isBullet || isNumbered) {
        if (!inUL) {
          out.push('<ul style="margin:10px 0 0 18px; padding:0;">');
          inUL = true;
        }

        const cleaned = isBullet
          ? t.replace(/^[-*]\s+/, "")
          : t.replace(/^\d+\.\s+/, "");

        out.push(`<li style="margin:6px 0; line-height:1.5;">${inline(cleaned)}</li>`);
        continue;
      }

      // Normal paragraph line(s)
      closeUL();
      out.push(`<p style="margin:10px 0; line-height:1.55;">${inline(t)}</p>`);
    }

    closeUL();
    return out.join("");
  }

  window.simpleMarkdownToHTML = simpleMarkdownToHTML;
})();
