'use strict';
const createMixControl = require('../helpers/mix-control');

module.exports = function (api) {
  api.registerAction('mix', function (player, values) {
    const mix = createMixControl(player);
    if (values.length === 0) return mix.read();
    if (values.length !== 2) return Promise.reject(new Error('Invalid Mix route: use mix or mix/key/value'));
    return mix.set(values[0], values[1]);
  });
};
