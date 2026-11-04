globalThis.ReaderPage = (() => {
  const excluded = "nav,header,footer,aside,script,style,noscript,template,button,input,textarea,select,[role=navigation],[role=button],[role=menu],[role=banner],[role=contentinfo],[aria-hidden=true],[hidden],[data-ad],[data-ad-slot],[aria-label=Advertisement],#selection-text-reader-overlay";
  const blocks = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,div,section,article,main";

  function domain(value) {
    try {
      const text = String(value).trim().replace(/^\*\./, "");
      return new URL(text.includes("://") ? text : `https://${text}`).hostname.toLowerCase();
    } catch { return ""; }
  }

  function siteDisabled(hostname, sites = []) {
    return Array.isArray(sites) && sites.some((site) => {
      const name = domain(site);
      return name && (hostname === name || hostname.endsWith(`.${name}`));
    });
  }

  function editable(event) {
    return event.isComposing || event.composedPath().some((node) => node instanceof Element &&
      (node.isContentEditable || node.matches("input,textarea,select,[role=textbox],[role=searchbox],[role=combobox]")));
  }

  function visible(element) {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && element.getClientRects().length > 0;
  }

  function ignored(element, skipCode) {
    return Boolean(element.closest(excluded) || (skipCode && element.closest("pre,code")));
  }

  function textOf(node, skipCode) {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (!(node instanceof Element) || ignored(node, skipCode) || !visible(node)) return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map((child) => textOf(child, skipCode)).join("");
    return node.matches(blocks) ? `\n${text}\n` : text;
  }

  function findRoot() {
    let best = document.body;
    let bestScore = 0;
    for (const candidate of document.querySelectorAll("article,main,[role=main],[itemprop=articleBody],.markdown-body")) {
      if (ignored(candidate, false) || !visible(candidate)) continue;
      const length = (candidate.innerText || "").length;
      const linkLength = [...candidate.querySelectorAll("a")].reduce((sum, link) => sum + (link.innerText || "").length, 0);
      const weight = candidate.matches("article,.markdown-body,[itemprop=articleBody]") ? 1.3 : 1;
      const score = Math.max(0, length - linkLength) * weight;
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    return best;
  }

  function extract({ skipCode = true, startElement = null } = {}) {
    const root = findRoot();
    const result = [];
    function add(nodes, element) {
      const text = nodes.map((node) => textOf(node, skipCode)).join("").replace(/\s+/gu, " ").trim();
      if (!text) return;
      const range = document.createRange();
      range.setStartBefore(nodes[0]);
      range.setEndAfter(nodes.at(-1));
      result.push({ element, text, range });
    }
    function visit(element) {
      if (ignored(element, skipCode) || !visible(element)) return;
      let inline = [];
      const flush = () => { if (inline.length) add(inline, element); inline = []; };
      for (const node of element.childNodes) {
        if (node instanceof Element && (node.matches(blocks) || node.querySelector(blocks))) {
          flush();
          visit(node);
        } else {
          inline.push(node);
        }
      }
      flush();
    }
    if (root) visit(root);
    let index = 0;
    if (startElement) {
      index = result.findIndex((block) => block.element === startElement || block.element.contains(startElement));
      if (index < 0) index = result.findIndex((block) => startElement.contains(block.element));
      if (index < 0) return { root, blocks: [], text: "" };
    }
    const selected = result.slice(index);
    return { root, blocks: selected, text: selected.map((block) => block.text).join("\n\n") };
  }

  return { domain, siteDisabled, editable, extract, ignored, visible };
})();
