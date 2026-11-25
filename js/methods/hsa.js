/* methods/hsa.js: HSA excess (SPEC section 8.3).
 * Pure: no DOM access.
 * Same as Bliss (8.2) with E_exp = max(E_A, E_B). */
(function (name, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    // Node: dependencies come from require()
    module.exports = factory(function (key, nodePath) { return require(nodePath); });
  } else {
    // Browser <script>: dependencies come from the global CB (load order matters)
    var CB = (globalThis.CB = globalThis.CB || {});
    CB[name] = factory(function (key) {
      if (!(key in CB)) throw new Error('CB.' + name + ' needs CB.' + key + '; load it first');
      return CB[key];
    });
  }
})('methods/hsa', function (need) {
  'use strict';

  var registry = need('methods', './index.js');
  var bliss = need('methods/bliss', './bliss.js');

  var mod = bliss.makeExcessMethod({
    id: 'hsa',
    label: 'HSA excess',
    expected: function (ea, eb) { return Math.max(ea, eb); },
    note: 'HSA has no agreed cut-off; FICI and HSA can disagree on the same data.',
  });
  registry.register(mod);
  return mod;
});
