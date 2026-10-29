// Text formatting sent by the study (the practice summary) is shown with a short list of plain
// tags only: no scripts, styles, links or attributes.

const ALLOWED = new Set(['P', 'B', 'STRONG', 'I', 'EM', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BR', 'SPAN', 'H3', 'H4', 'SMALL']);

export function safeFragment(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const clean = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE || !ALLOWED.has(child.tagName)) {
        if (child.nodeType === Node.ELEMENT_NODE && !['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'TEMPLATE'].includes(child.tagName)) {
          clean(child);
          child.replaceWith(...child.childNodes);
        } else child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) child.removeAttribute(attr.name);
      clean(child);
    }
  };
  clean(tpl.content);
  return tpl.content;
}
