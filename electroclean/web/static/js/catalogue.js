// The artifact label catalogue, as the server (GET /me) or the demonstration provides it.

export class Catalogue {
  constructor(data) {
    this.labels = (data && data.labels ? data.labels : []).map((l) => ({
      label: l.label,
      value: l.value,
      short_code: l.short_code || l.label.slice(0, 5).toUpperCase(),
      colour: l.colour || '#808080',
      section: l.section || '',
      is_group: Boolean(l.is_group),
      description: l.description || '',
    }));
    this._by = new Map(this.labels.map((l) => [l.label, l]));
  }

  get labelNames() {
    return this.labels.map((l) => l.label);
  }

  has(label) {
    return this._by.has(label);
  }

  get(label) {
    const l = this._by.get(label);
    if (!l) throw new Error(`Unknown artifact type: ${label}`);
    return l;
  }

  colourFor(label) {
    const l = this._by.get(label);
    return l ? l.colour : '#808080';
  }

  /** "Eye-blink-artifact  (103)" and, for group terms, "– exact type unclear". */
  labelText(label) {
    const l = this.get(label);
    return `${l.label}  (${l.value})` + (l.is_group ? '  – exact type unclear' : '');
  }

  /** The labels grouped under their family headings, in catalogue order. */
  sections() {
    const out = [];
    for (const l of this.labels) {
      let s = out[out.length - 1];
      if (!s || s.section !== l.section) { s = { section: l.section, labels: [] }; out.push(s); }
      s.labels.push(l);
    }
    return out;
  }

  specificLabels() {
    return this.labels.filter((l) => !l.is_group).map((l) => l.label);
  }

  /** The types on keys 1 to 9: the study's choice (unknown names left out), else the first specific types. */
  quickLabels(chosen) {
    const ok = (chosen || []).filter((n) => this.has(n)).slice(0, 9);
    return ok.length ? ok : this.specificLabels().slice(0, 9);
  }

  /** True if every word typed appears in the type's name, code or abbreviation (the picker's search). */
  static matches(l, text) {
    const hay = `${l.label} ${l.value} ${l.short_code}`.toLowerCase().replace(/-/g, ' ');
    return text.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
}
