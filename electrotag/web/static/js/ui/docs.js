// Where the guides are read: the rendered Markdown in the repository on GitHub.
export const DOCS_BASE = 'https://github.com/faisalmushtaq/ElectroTag/blob/main/docs/';

/** The address of a guide, e.g. docsUrl('web/using.md', 'confidence-and-notes'). */
export function docsUrl(path, anchor = '') {
  return DOCS_BASE + path + (anchor ? `#${anchor}` : '');
}
