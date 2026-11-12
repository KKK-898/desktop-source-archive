var CODEX_PASTE_RUNTIME_VERSION = 1;

function installCodexPasteRuntime() {
  const previous = window.__gaogeCodexPasteRuntime;
  if (previous?.version === CODEX_PASTE_RUNTIME_VERSION && previous.status?.().installed === true) return previous;
  previous?.dispose?.();

  const doc = window.document;
  let installed = false;
  let handled = 0;
  let fallbacks = 0;
  let reason = "document-unavailable";
  const maxTextLength = 20000;
  const maxPreviewHtmlLength = 100000;

  function editorFor(event) {
    let target = event.target;
    if (target?.nodeType === 3) target = target.parentElement;
    const editor = target?.closest?.(".ProseMirror[contenteditable='true']");
    if (!editor || editor.ownerDocument !== doc || editor.isConnected === false) return null;
    if (!editor.closest("[data-codex-composer-root]")) return null;
    if (editor.closest("[data-codex-composer-request], [data-codex-terminal], [inert], [hidden], [aria-hidden='true'], [aria-disabled='true']")) return null;
    const descriptor = editor.pmViewDesc;
    if (!descriptor || descriptor.dom !== editor || descriptor.parent != null
        || descriptor.node?.type?.name !== "doc" || typeof descriptor.node?.toJSON !== "function") return null;
    const protectedTarget = target.closest?.("[contenteditable='false']");
    if (protectedTarget && editor.contains(protectedTarget)) return null;
    return editor;
  }

  function clipboardFiles(data) {
    const files = Array.from(data.files || []);
    for (const item of Array.from(data.items || [])) {
      if (item.kind !== "file") continue;
      if (item.webkitGetAsEntry?.()?.isDirectory) return null;
      const file = item.getAsFile?.();
      if (!file) return null;
      if (!files.includes(file)) files.push(file);
    }
    return files;
  }

  // Word can expose a bitmap preview alongside text. Only discard that preview
  // when the HTML identifies Word and contains exactly the copied text, with
  // no embedded image/media. Ambiguous mixed content stays with Codex.
  function isWordTextPreview(files, html, plainText) {
    if (!files.length || !files.every(file => /^image\//i.test(file.type || ""))) return false;
    if (!html || html.length > maxPreviewHtmlLength) return false;
    if (!/(?:xmlns:w\s*=\s*["']urn:schemas-microsoft-com:office:word|Microsoft\s+Word|Word\.Document)/i.test(html)) return false;
    if (/<\s*(?:img|svg|canvas|video|audio|object|embed|iframe|picture|source|v:imagedata|v:shape|o:OLEObject)\b/i.test(html)) return false;
    const template = doc.createElement("template");
    template.innerHTML = html;
    const walker = doc.createTreeWalker(template.content, 4);
    const parts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let hidden = false;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches("head, script, style, template, noscript, title, meta, link, [hidden], [aria-hidden='true']")
            || parent.style?.display === "none" || parent.style?.visibility === "hidden"
            || Number.parseFloat(parent.style?.opacity) === 0) { hidden = true; break; }
      }
      if (!hidden) parts.push(node.textContent || "");
    }
    const compact = text => text.replace(/\s+/gu, "").replace(/\u200b/gu, "");
    const visible = compact(parts.join(""));
    return visible.length > 0 && visible === compact(plainText);
  }

  function paste(event) {
    if (!installed || event.defaultPrevented || event.cancelable !== true || !event.clipboardData) return;
    try {
      const target = editorFor(event);
      if (!target) return;
      const data = event.clipboardData;
      // Native internal copies carry mention/page identity; never flatten them.
      if (data.getData("application/x-openai-rich-text")) return;
      const text = data.getData("text/plain");
      if (!text || text.length > maxTextLength) return;
      const html = data.getData("text/html");
      const rtf = data.getData("text/rtf") || data.getData("application/rtf");
      if (!html && !rtf) return;
      const files = clipboardFiles(data);
      if (!files || (files.length && !isWordTextPreview(files, html, text))) return;
      if (typeof window.DataTransfer !== "function") { fallbacks += 1; reason = "clipboard-adapter-unavailable"; return; }
      const plain = new window.DataTransfer();
      plain.setData("text/plain", text.replace(/\r\n?/g, "\n"));
      // ClipboardEvent.clipboardData is read-only, but its prototype getter can
      // be shadowed on this event. Keep the ORIGINAL event (including trust,
      // target and modifier state) and let Codex perform its own transaction.
      // Do not dispatch a synthetic event, cancel paste, insert HTML, or mutate
      // the editor DOM: that would break its draft state and undo history.
      const originalDescriptor = Object.getOwnPropertyDescriptor(event, "clipboardData");
      try {
        Object.defineProperty(event, "clipboardData", { configurable: true, enumerable: true, value: plain });
        if (event.clipboardData !== plain) throw new Error("clipboard override unavailable");
      } catch (_) {
        try {
          if (originalDescriptor) Object.defineProperty(event, "clipboardData", originalDescriptor);
          else delete event.clipboardData;
        } catch (_) {}
        fallbacks += 1;
        reason = "clipboard-adapter-unavailable";
        return;
      }
      handled += 1;
      reason = "plain-text-forwarded";
    } catch (_) {
      fallbacks += 1;
      reason = "native-fallback";
    }
  }

  const runtime = {
    version: CODEX_PASTE_RUNTIME_VERSION,
    status() { return { version: CODEX_PASTE_RUNTIME_VERSION, installed, ready: installed, mode: "native-paste-event", handled, fallbacks, reason }; },
    dispose() {
      if (installed) doc.removeEventListener("paste", paste, true);
      installed = false;
      reason = "disposed";
      if (window.__gaogeCodexPasteRuntime === runtime) delete window.__gaogeCodexPasteRuntime;
    },
  };
  if (typeof doc?.addEventListener === "function") {
    doc.addEventListener("paste", paste, true);
    installed = true;
    reason = "listening";
  }
  window.__gaogeCodexPasteRuntime = runtime;
  return runtime;
}
