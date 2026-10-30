// The sections of the expert area (js/expert/area.js), without the page, so that they can be tested in
// Node. Each section is addressed by a plain hash (#expert, #expert-work, ...), matched by EXPERT_ROUTE.
//
// The overview is the area's own. Each later part of the expert work adds its section here with one
// line: { key, route, title, load }, where load() resolves with the section's class (a class whose
// instances have `el` and `async show(params)`, made with the area: new Section(area)).

/** The expert area's plain hashes: #expert and #expert-<section> (app.js routes them here). */
export const EXPERT_ROUTE = /^expert(-[a-z]+)?$/;

export const EXPERT_SECTIONS = Object.freeze([
  { key: 'overview', route: 'expert', title: 'Overview', load: null },
  { key: 'work', route: 'expert-work', title: 'Saved work', load: () => import('./work.js').then((m) => m.SavedWork) },
  { key: 'queue', route: 'expert-queue', title: 'Adjudication', load: () => import('./queue.js').then((m) => m.QueueSection) },
  { key: 'library', route: 'expert-library', title: 'Library', load: () => import('./library.js').then((m) => m.LibrarySection) },
  { key: 'planted', route: 'expert-planted', title: 'Correct the marks', load: () => import('./planted.js').then((m) => m.PlantedSection) },
]);

export function expertSectionForRoute(route, sections = EXPERT_SECTIONS) {
  const s = sections.find((x) => x.route === route);
  return s ? s.key : null;
}

export function routeForExpertSection(key, sections = EXPERT_SECTIONS) {
  const s = sections.find((x) => x.key === key);
  return s ? s.route : 'expert';
}

/** True for an account whose roles (GET /me) open the expert area: an expert, or an administrator. */
export function canUseExpertArea(me) {
  const roles = (me && Array.isArray(me.roles) && me.roles.length) ? me.roles : [me && me.role];
  return roles.includes('expert') || roles.includes('admin');
}
