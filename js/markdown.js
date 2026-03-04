/* ---------------------------------------------------
   Minimal Markdown → HTML
   Supports:
   - **bold**
   - *italic*
   - [text](url)
   - Bullets (-, *)
   - Numbered lists (1.)
   - Paragraphs + line breaks
   Notes:
   - Escapes HTML first (safe)
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
    let inOL = false;

    function closeLists() {
      if (inUL) {
        out.push("</ul>");
        inUL = false;
      }
      if (inOL) {
        out.push("</ol>");
        inOL = false;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();

      // Blank line = paragraph break
      if (!t) {
        closeLists();
        continue;
      }

      // Bullet list
      const isBullet = /^[-*]\s+/.test(t);
      if (isBullet) {
        if (inOL) {
          out.push("</ol>");
          inOL = false;
        }
        if (!inUL) {
          out.push('<ul style="margin:10px 0 0 18px; padding:0;">');
          inUL = true;
        }
        out.push(`<li style="margin:6px 0; line-height:1.5;">${inline(t.replace(/^[-*]\s+/, ""))}</li>`);
        continue;
      }

      // Numbered list
      const isNumbered = /^\d+\.\s+/.test(t);
      if (isNumbered) {
        if (inUL) {
          out.push("</ul>");
          inUL = false;
        }
        if (!inOL) {
          out.push('<ol style="margin:10px 0 0 20px; padding:0;">');
          inOL = true;
        }
        out.push(`<li style="margin:6px 0; line-height:1.5;">${inline(t.replace(/^\d+\.\s+/, ""))}</li>`);
        continue;
      }

      // Normal paragraph line(s)
      closeLists();
      out.push(`<p style="margin:10px 0; line-height:1.55;">${inline(t)}</p>`);
    }

    closeLists();
    return out.join("");
  }

  window.simpleMarkdownToHTML = simpleMarkdownToHTML;
})();
