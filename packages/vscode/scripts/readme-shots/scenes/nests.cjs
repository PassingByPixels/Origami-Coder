// Nests: the Agent Manager view with three desks, and the Accept step.
const F = require('../fixtures.cjs');

const board = (extra) => ({
  height: 760,
  globals: { __ORIGAMI_BOARD__: true },
  state: { 'origami.board.view': 'nests' },
  responders: {
    groupRequest: F.groupData(extra),
    requestNestStorage: F.nestStorage,
  },
});

module.exports = [
  // README (Harbour theme): no tail line, so the offline desk's tile does not
  // combine "ago" with "tailed" (t-vh6kl9: avoid the known missing-space bug).
  { name: 'nests', out: 'images/nests.png', view: { ...board({ tail: null }), theme: 'harbour' } },
  {
    name: 'nests-accept',
    out: 'whats-new/shots/nests-accept.png',
    // The joining desk is not in the list yet: only the two desks already in the nest.
    view: { ...board({ devices: [F.DESKS.self, F.DESKS.home], tail: null, joinCheck: { side: 'inviter', name: F.DESKS.travel.name, code: '482 915' } }), width: 900 },
    clip: '[data-name="desks"]',
  },
];
