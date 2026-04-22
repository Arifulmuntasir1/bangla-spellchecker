/**
 * Bengali Spellchecker – Content Script (Manifest V3)
 * =====================================================
 * This script observes <textarea> and [contenteditable="true"] elements,
 * sends their text to the local Flask server, highlights misspelled words,
 * and shows a suggestion tooltip on click/hover.
 *
 * KEY DESIGN DECISIONS:
 *  1. For <textarea>: We use an invisible overlay <div> that mirrors the
 *     textarea's text. We NEVER touch the textarea's value — the overlay
 *     sits on top and carries the red underlines. This is how Grammarly
 *     does it too; it avoids caret/undo breakage entirely.
 *  2. For contenteditable: We walk the DOM with a TreeWalker, wrapping
 *     misspelled words in <span class="bspell-error">. We save and
 *     restore the caret position so the user's cursor doesn't jump.
 *  3. Debouncing: Every input event is debounced by 500ms so we don't
 *     flood the local Python server.
 */

(() => {
  "use strict";

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  const API_URL = "http://127.0.0.1:5111/check";
  const DEBOUNCE_MS = 500;

  // IMPORTANT: Do NOT use a regex with the /g flag for .test() calls.
  // A /g regex maintains lastIndex state between .test() calls, which
  // causes alternating true/false results — a notorious JS gotcha.
  // We use a non-/g regex for .test() checks and create fresh ones
  // or use matchAll for iteration.
  const BENGALI_TEST_RE = /[\u0980-\u09FF]/;

  // Keep track of elements we're already observing so we don't double-bind.
  const observed = new WeakSet();

  // -----------------------------------------------------------------------
  // Utility: Debounce
  // -----------------------------------------------------------------------
  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  // -----------------------------------------------------------------------
  // API: Send text to server, get errors back
  // -----------------------------------------------------------------------
  async function fetchErrors(text) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.errors || [];
    } catch (err) {
      // Server not running — fail silently
      console.warn("[BSpell] Server unreachable:", err.message);
      return [];
    }
  }

  // =======================================================================
  //  SECTION A – TEXTAREA HANDLING (Overlay Strategy)
  // =======================================================================
  // We create an absolutely-positioned <div> that sits exactly on top of
  // the textarea. The overlay has the same font metrics, padding, and size.
  // It contains highlighted HTML but is pointer-events:none except on the
  // error spans themselves. The textarea remains fully interactive.
  // =======================================================================

  /**
   * Create the mirror overlay for a <textarea>.
   */
  function createOverlay(textarea) {
    const overlay = document.createElement("div");
    overlay.className = "bspell-overlay";
    overlay.setAttribute("aria-hidden", "true");

    // Copy computed styles so text lines up perfectly
    const cs = window.getComputedStyle(textarea);
    overlay.style.cssText = `
      position: absolute;
      pointer-events: none;
      overflow: hidden;
      white-space: pre-wrap;
      word-wrap: break-word;
      color: transparent;
      background: transparent;
      border-color: transparent;
      z-index: 1;
      font: ${cs.font};
      letter-spacing: ${cs.letterSpacing};
      word-spacing: ${cs.wordSpacing};
      line-height: ${cs.lineHeight};
      padding: ${cs.padding};
      border-width: ${cs.borderWidth};
      border-style: ${cs.borderStyle};
      box-sizing: ${cs.boxSizing};
      text-transform: ${cs.textTransform};
      tab-size: ${cs.tabSize};
    `;

    // Position over the textarea
    syncOverlayPosition(textarea, overlay);

    // Ensure the textarea's parent can hold an absolutely-positioned child
    const parent = textarea.parentElement;
    if (parent && getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(overlay);

    return overlay;
  }

  /**
   * Keep the overlay exactly over the textarea.
   */
  function syncOverlayPosition(textarea, overlay) {
    overlay.style.width = textarea.offsetWidth + "px";
    overlay.style.height = textarea.offsetHeight + "px";
    overlay.style.top = textarea.offsetTop + "px";
    overlay.style.left = textarea.offsetLeft + "px";
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
  }

  /**
   * Render errors into the overlay as highlighted HTML.
   * The overlay text is transparent so only the wavy underline shows.
   */
  function renderOverlay(overlay, text, errors) {
    if (!errors.length) {
      overlay.innerHTML = "";
      return;
    }

    // Sort errors by start index
    errors.sort((a, b) => a.start - b.start);

    let html = "";
    let cursor = 0;

    for (const err of errors) {
      // Text before this error
      if (err.start > cursor) {
        html += escapeHTML(text.slice(cursor, err.start));
      }
      // The error word — wrapped in a span (pointer-events enabled so
      // the user can click it to see suggestions)
      const suggAttr = escapeHTML(JSON.stringify(err.suggestions));
      html +=
        `<span class="bspell-error" ` +
        `style="pointer-events:auto;" ` +
        `data-bspell-word="${escapeHTML(err.word)}" ` +
        `data-bspell-start="${err.start}" ` +
        `data-bspell-suggestions='${suggAttr}'>` +
        escapeHTML(err.word) +
        `</span>`;
      cursor = err.end;
    }
    // Remaining text after last error
    if (cursor < text.length) {
      html += escapeHTML(text.slice(cursor));
    }
    // Trailing newline so the overlay height matches
    html += "\n";

    overlay.innerHTML = html;
  }

  /**
   * Set up spellchecking for a <textarea>.
   */
  function attachTextarea(textarea) {
    if (observed.has(textarea)) return;
    observed.add(textarea);

    const overlay = createOverlay(textarea);

    const check = debounce(async () => {
      const text = textarea.value;
      if (!BENGALI_TEST_RE.test(text)) {
        overlay.innerHTML = "";
        return;
      }
      const errors = await fetchErrors(text);
      renderOverlay(overlay, text, errors);
      syncOverlayPosition(textarea, overlay);
    }, DEBOUNCE_MS);

    textarea.addEventListener("input", check);
    textarea.addEventListener("scroll", () => {
      overlay.scrollTop = textarea.scrollTop;
      overlay.scrollLeft = textarea.scrollLeft;
    });

    // Handle resize
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => syncOverlayPosition(textarea, overlay)).observe(textarea);
    }
  }

  // =======================================================================
  //  SECTION B – CONTENTEDITABLE HANDLING (TreeWalker Strategy)
  // =======================================================================
  // For contenteditable elements we must modify the DOM in-place.
  // Strategy:
  //  1. Collect all text content, send it to the server.
  //  2. Walk the text nodes with a TreeWalker.
  //  3. For each misspelled word found inside a text node, split the text
  //     node into [before, <span class="bspell-error">word</span>, after].
  //  4. Save and restore the user's caret so it doesn't jump.
  //
  // We NEVER touch nodes that are already inside a .bspell-error span.
  // Before re-checking we strip all previous .bspell-error wrappers.
  // =======================================================================

  /**
   * Save the current caret (selection) inside a contenteditable.
   * Returns a bookmark object that restoreSelection() can use.
   */
  function saveSelection(root) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    // Only save if the selection is inside our root
    if (!root.contains(range.startContainer)) return null;

    // Walk all text nodes and compute a character offset from the start
    // of the contenteditable to the caret position.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let charOffset = 0;
    let node;
    let startOffset = null;
    let endOffset = null;

    while ((node = walker.nextNode())) {
      if (node === range.startContainer) {
        startOffset = charOffset + range.startOffset;
      }
      if (node === range.endContainer) {
        endOffset = charOffset + range.endOffset;
        break;
      }
      charOffset += node.textContent.length;
    }

    return { startOffset, endOffset };
  }

  /**
   * Restore the caret from a bookmark created by saveSelection().
   */
  function restoreSelection(root, bookmark) {
    if (!bookmark || bookmark.startOffset == null) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let charCount = 0;
    let node;
    let startNode = null, startOff = 0;
    let endNode = null, endOff = 0;

    while ((node = walker.nextNode())) {
      const len = node.textContent.length;

      if (!startNode && charCount + len >= bookmark.startOffset) {
        startNode = node;
        startOff = bookmark.startOffset - charCount;
      }
      if (!endNode && charCount + len >= bookmark.endOffset) {
        endNode = node;
        endOff = bookmark.endOffset - charCount;
        break;
      }
      charCount += len;
    }

    if (startNode && endNode) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {
        // Edge case: offsets out of range after DOM change — ignore.
      }
    }
  }

  /**
   * Remove all previous .bspell-error spans inside a root, unwrapping
   * their text content back into the parent.
   */
  function clearHighlights(root) {
    const spans = root.querySelectorAll(".bspell-error");
    for (const span of spans) {
      const parent = span.parentNode;
      // Replace the span with its text content
      const textNode = document.createTextNode(span.textContent);
      parent.replaceChild(textNode, span);
      // Merge adjacent text nodes so TreeWalker works cleanly
      parent.normalize();
    }
  }

  /**
   * Walk text nodes and wrap misspelled substrings in highlight spans.
   *
   * How it works:
   *  - We maintain a running character offset that maps each text node's
   *    content to the overall plain-text string we sent to the server.
   *  - For each text node, we check which errors (by start/end index)
   *    fall within that node.
   *  - We split the text node at the error boundaries and insert a
   *    <span class="bspell-error"> around the misspelled word.
   *  - After splitting, we continue the walk with the *remaining* part
   *    of the original text node (the "after" piece).
   */
  function applyHighlights(root, errors) {
    if (!errors.length) return;

    // Sort errors by start index
    errors.sort((a, b) => a.start - b.start);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let globalOffset = 0; // character offset in the full text
    let errIdx = 0;       // pointer into the errors array
    let node;

    while ((node = walker.nextNode()) && errIdx < errors.length) {
      const nodeText = node.textContent;
      const nodeStart = globalOffset;
      const nodeEnd = globalOffset + nodeText.length;

      // Collect all errors that start within this text node
      while (errIdx < errors.length) {
        const err = errors[errIdx];
        if (err.start >= nodeEnd) break; // This error is in a later node

        // Compute local offsets within the text node
        const localStart = err.start - nodeStart;
        const localEnd = err.end - nodeStart;

        // Safety: skip if the error doesn't actually fit in this node
        if (localStart < 0 || localEnd > nodeText.length) {
          errIdx++;
          continue;
        }

        // --- Split the text node into [before][error][after] ---
        // 1. Split at the END of the error word first
        const afterNode = node.splitText(localEnd);
        // 2. Now `node` contains text up to localEnd.
        //    Split at the START of the error word.
        const errorTextNode = node.splitText(localStart);
        // Now: node = "before", errorTextNode = "misspelled word",
        //      afterNode = "after"

        // 3. Wrap errorTextNode in a <span>
        const span = document.createElement("span");
        span.className = "bspell-error";
        span.dataset.bspellWord = err.word;
        span.dataset.bspellSuggestions = JSON.stringify(err.suggestions);
        errorTextNode.parentNode.replaceChild(span, errorTextNode);
        span.appendChild(errorTextNode);

        // 4. Advance: the walker should now continue from afterNode.
        //    We re-seat the walker's current node.
        //    Update globalOffset to the position of afterNode.
        globalOffset = err.end;
        node = afterNode;
        errIdx++;

        // Re-check: more errors may fall within the remaining afterNode
        continue;
      }

      globalOffset = nodeEnd;
    }
  }

  /**
   * Set up spellchecking for a contenteditable element.
   */
  function attachContentEditable(el) {
    if (observed.has(el)) return;
    observed.add(el);

    const check = debounce(async () => {
      // 1. Gather plain text
      const text = el.innerText || el.textContent || "";
      if (!BENGALI_TEST_RE.test(text)) {
        clearHighlights(el);
        return;
      }

      // 2. Ask the server
      const errors = await fetchErrors(text);

      // 3. Save caret position
      const bookmark = saveSelection(el);

      // 4. Remove old highlights (unwrap spans back to text)
      clearHighlights(el);

      // 5. Apply new highlights via TreeWalker
      applyHighlights(el, errors);

      // 6. Restore caret
      restoreSelection(el, bookmark);
    }, DEBOUNCE_MS);

    el.addEventListener("input", check);
  }

  // =======================================================================
  //  SECTION C – TOOLTIP (Suggestion Popup)
  // =======================================================================

  let activeTooltip = null;

  /**
   * Remove the currently-visible tooltip.
   */
  function removeTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  /**
   * Show the suggestion tooltip next to a .bspell-error span.
   */
  function showTooltip(errorSpan) {
    removeTooltip();

    const word = errorSpan.dataset.bspellWord;
    let suggestions = [];
    try {
      suggestions = JSON.parse(errorSpan.dataset.bspellSuggestions);
    } catch (_) {}

    const tooltip = document.createElement("div");
    tooltip.className = "bspell-tooltip";

    // Header: show the misspelled word
    const header = document.createElement("div");
    header.className = "bspell-tooltip-header";
    header.textContent = `✗  "${word}"`;
    tooltip.appendChild(header);

    if (suggestions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bspell-tooltip-empty";
      empty.textContent = "কোনো পরামর্শ নেই";
      tooltip.appendChild(empty);
    } else {
      for (const suggestion of suggestions) {
        const item = document.createElement("div");
        item.className = "bspell-tooltip-item";
        item.textContent = suggestion;

        // ---- Clicking a suggestion replaces the word ----
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          replaceMisspelling(errorSpan, suggestion);
          removeTooltip();
        });

        tooltip.appendChild(item);
      }
    }

    // Position the tooltip below the error span
    document.body.appendChild(tooltip);
    const rect = errorSpan.getBoundingClientRect();
    tooltip.style.top = (window.scrollY + rect.bottom + 4) + "px";
    tooltip.style.left = (window.scrollX + rect.left) + "px";

    activeTooltip = tooltip;
  }

  /**
   * Replace a misspelled word with the chosen suggestion.
   * Works for both textarea-overlay spans and contenteditable spans.
   */
  function replaceMisspelling(errorSpan, suggestion) {
    // Case 1: Contenteditable — the span IS in the editable DOM
    const editable = errorSpan.closest("[contenteditable='true']");
    if (editable) {
      const textNode = document.createTextNode(suggestion);
      errorSpan.parentNode.replaceChild(textNode, errorSpan);
      textNode.parentNode.normalize();
      // Trigger an input event so the debounced re-check fires
      editable.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // Case 2: Textarea overlay — find the sibling textarea and replace
    // the word at the exact position using the stored start offset.
    const overlay = errorSpan.closest(".bspell-overlay");
    if (overlay) {
      const textarea = overlay.previousElementSibling ||
        overlay.parentElement.querySelector("textarea");
      if (textarea) {
        const word = errorSpan.dataset.bspellWord;
        const startPos = parseInt(errorSpan.dataset.bspellStart, 10);

        // Use the stored start position for precise replacement
        if (!isNaN(startPos) && textarea.value.slice(startPos, startPos + word.length) === word) {
          textarea.value =
            textarea.value.slice(0, startPos) +
            suggestion +
            textarea.value.slice(startPos + word.length);
        } else {
          // Fallback: replace first occurrence
          const idx = textarea.value.indexOf(word);
          if (idx !== -1) {
            textarea.value =
              textarea.value.slice(0, idx) +
              suggestion +
              textarea.value.slice(idx + word.length);
          }
        }
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  // ---- Global listeners for tooltip ----

  // Show tooltip on click on error spans
  document.addEventListener("click", (e) => {
    const span = e.target.closest(".bspell-error");
    if (span) {
      e.preventDefault();
      showTooltip(span);
    } else if (!e.target.closest(".bspell-tooltip")) {
      removeTooltip();
    }
  });

  // Show tooltip on hover over error spans
  document.addEventListener("mouseenter", (e) => {
    const span = e.target.closest && e.target.closest(".bspell-error");
    if (span) showTooltip(span);
  }, true);

  // Hide tooltip on scroll or Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") removeTooltip();
  });
  window.addEventListener("scroll", removeTooltip, true);

  // =======================================================================
  //  SECTION D – DISCOVERY (Finding editable elements)
  // =======================================================================
  // We look for <textarea> and [contenteditable="true"] elements on page
  // load and also observe the DOM for dynamically-added ones via
  // MutationObserver.
  // =======================================================================

  function discoverEditables(root = document) {
    // Textareas
    for (const ta of root.querySelectorAll("textarea")) {
      attachTextarea(ta);
    }
    // Contenteditable (matches both contenteditable="true" and contenteditable="")
    for (const el of root.querySelectorAll('[contenteditable="true"], [contenteditable=""]')) {
      attachContentEditable(el);
    }
  }

  // Initial scan
  discoverEditables();

  // Observe for dynamically-added elements (SPAs, lazy-loaded UI, etc.)
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const added of m.addedNodes) {
        if (added.nodeType !== Node.ELEMENT_NODE) continue;
        // Check the added node itself
        if (added.tagName === "TEXTAREA") attachTextarea(added);
        if (added.getAttribute && (
          added.getAttribute("contenteditable") === "true" ||
          added.getAttribute("contenteditable") === ""
        )) {
          attachContentEditable(added);
        }
        // Check descendants
        discoverEditables(added);
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // =======================================================================
  //  Helpers
  // =======================================================================
  function escapeHTML(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  console.log("[BSpell] Bengali Spellchecker content script loaded.");
})();
