// Sprache der Oberfläche. Die Texte stehen auf Deutsch in den Seiten; für Englisch ersetzt dieses Skript sie
// beim Aufbau und bei jeder späteren Änderung der Seite (MutationObserver) anhand des Wörterbuchs in i18n-en.js.
// Deutsch bleibt damit die eine Quelle, und neue Texte erscheinen ohne Übersetzung einfach auf Deutsch.
// Was der Server liefert (Systemprotokoll, Gesprächsergebnisse) und was Menschen eingeben, wird nicht übersetzt:
// Bereiche mit data-no-i18n bleiben unberührt. Die KI selbst spricht am Telefon immer Deutsch.
(() => {
  'use strict';
  const KEY = 'sipfunk.lang';
  const read = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };
  const query = new URLSearchParams(location.search).get('lang');
  /** Gewählte Einstellung: 'auto' (Sprache des Browsers), 'de' oder 'en' */
  const pref = query === 'de' || query === 'en' ? query : read();
  const lang = pref === 'de' || pref === 'en' ? pref : /^de\b/i.test(navigator.language || 'de') ? 'de' : 'en';
  document.documentElement.lang = lang;

  const dict = (lang === 'en' && window.SIPFUNK_EN) || { exact: {}, patterns: [] };
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  /** Texte ohne Übersetzung (nur zur Pflege des Wörterbuchs: I18N.missing in der Konsole) */
  const missing = new Set();

  /** Übersetzt einen deutschen Text; {0}, {1} … werden durch die weiteren Argumente ersetzt. */
  function t(text, ...args) {
    let out = text;
    if (lang !== 'de') {
      const key = norm(String(text));
      const hit = dict.exact[key];
      if (hit !== undefined) out = hit;
      else {
        const p = dict.patterns.find(([re]) => re.test(key));
        if (p) out = key.replace(p[0], p[1]);
        else if (/[a-zäöüß]{3}/i.test(key)) missing.add(key);
      }
    }
    return args.length ? String(out).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) : out;
  }

  const ATTRS = ['placeholder', 'title', 'aria-label', 'data-title'];
  const INLINE = new Set(['B', 'STRONG', 'EM', 'CODE', 'A', 'I']);
  const skip = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    // Der Inhalt eines Textfelds ist Eingabe, sein Platzhalter und Titel sind Oberfläche
    return !el || el.closest(node.nodeType === 1 ? '[data-no-i18n], script, style' : '[data-no-i18n], script, style, textarea') !== null;
  };
  /** Absatz aus Text und einfacher Auszeichnung (fett, Code, Link): als Ganzes übersetzen, damit der Satzbau stimmt. */
  function translateBlock(el) {
    if (!el || el.__i18n || !el.childNodes.length) return false;
    let inline = false;
    for (const c of el.childNodes) {
      if (c.nodeType === 1) { if (!INLINE.has(c.tagName) || c.attributes.length > (c.tagName === 'A' ? 3 : 0)) return false; inline = true; }
      else if (c.nodeType !== 3) return false;
    }
    if (!inline) return false;
    const hit = dict.exact[norm(el.innerHTML)];
    if (hit === undefined) return false;
    el.__i18n = true;
    el.innerHTML = hit;
    return true;
  }
  function translateText(node) {
    if (skip(node)) return;
    const raw = node.nodeValue;
    if (!raw || !raw.trim() || node.__i18n === raw || (node.parentElement && node.parentElement.__i18n)) return;
    if (translateBlock(node.parentElement)) return;
    const out = t(raw);
    if (out !== norm(raw) && out !== raw) {
      const lead = /^\s*/.exec(raw)[0], tail = /\s*$/.exec(raw)[0];
      node.nodeValue = node.__i18n = lead + out + tail;
    }
  }
  function translateAttrs(el) {
    if (skip(el)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && el[`__i18n_${a}`] !== v) { const out = t(v); if (out !== v) { el[`__i18n_${a}`] = out; el.setAttribute(a, out); } }
    }
  }
  function translateTree(root) {
    if (root.nodeType === 3) return translateText(root);
    if (root.nodeType !== 1 || skip(root)) return;
    translateAttrs(root);
    for (const el of root.querySelectorAll('*')) translateAttrs(el);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) if (n.isConnected) translateText(n);
  }

  if (lang !== 'de') {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') translateText(r.target);
        else if (r.type === 'attributes') translateAttrs(r.target);
        else for (const n of r.addedNodes) translateTree(n);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    if (document.title) document.title = t(document.title);
  }

  window.I18N = {
    lang,
    pref,
    /** Gebietsschema für Datum und Uhrzeit */
    locale: lang === 'de' ? 'de-DE' : 'en-GB',
    t,
    missing,
    /** Einstellung übernehmen; lädt die Seite neu, wenn sich dadurch die Sprache ändert. Liefert true beim Neuladen. */
    sync(next) {
      next = next === 'de' || next === 'en' ? next : 'auto';
      if (next === read() || query) return false;
      try { localStorage.setItem(KEY, next); } catch { return false; }
      const resolved = next === 'auto' ? (/^de\b/i.test(navigator.language || 'de') ? 'de' : 'en') : next;
      if (resolved === lang) return false;
      location.reload();
      return true;
    },
  };
})();
