// The words of the leaderboard's pseudonyms, the same as electroclean/web/games.py (ADJECTIVES and
// ANIMALS; web_tests/unit/ui_milestones.test.mjs checks that the two lists agree). The study server
// and Firebase make the pseudonyms; the demonstration makes its own from these words.

/** Kind, ordinary words in UK English; an adjective and an animal make a pseudonym ("Steady Heron"). */
export const ADJECTIVES = Object.freeze([
  'Amber', 'Bold', 'Bright', 'Brisk', 'Calm', 'Careful', 'Cheerful', 'Clever', 'Cosy', 'Curious', 'Dapper', 'Eager',
  'Gentle', 'Golden', 'Hardy', 'Honest', 'Jolly', 'Keen', 'Kind', 'Lively', 'Loyal', 'Mellow', 'Merry', 'Modest',
  'Nimble', 'Patient', 'Plucky', 'Polite', 'Quiet', 'Radiant', 'Sensible', 'Serene', 'Silver', 'Sincere', 'Snug',
  'Spry', 'Steady', 'Sunny', 'Thoughtful', 'Tidy', 'Trusty', 'Valiant', 'Warm', 'Watchful', 'Wise', 'Witty',
  'Cordial', 'Hopeful',
]);

export const ANIMALS = Object.freeze([
  'Badger', 'Beaver', 'Blackbird', 'Curlew', 'Dormouse', 'Dove', 'Egret', 'Falcon', 'Finch', 'Fox', 'Gannet',
  'Goldfinch', 'Hare', 'Hedgehog', 'Heron', 'Kestrel', 'Kingfisher', 'Kite', 'Lapwing', 'Lark', 'Lynx', 'Magpie',
  'Marten', 'Mole', 'Moorhen', 'Newt', 'Nightingale', 'Osprey', 'Otter', 'Owl', 'Puffin', 'Rabbit', 'Raven', 'Robin',
  'Seal', 'Skylark', 'Sparrow', 'Squirrel', 'Stoat', 'Swallow', 'Swan', 'Tern', 'Thrush', 'Vole', 'Wagtail', 'Wren',
  'Plover', 'Starling',
]);
