'use strict';
const soap = require('sonos-discovery/lib/helpers/soap');
const TYPE = soap.TYPE;

// sonos-discovery 1.8.0 ships no surround-level prototypes, so drive
// RenderingControl SetEQ directly — same call shape as its subGain/nightMode.
function setSurroundEq(player, eqType, value) {
  if (isNaN(value) || value < -15 || value > 15) {
    return Promise.reject(new Error('Valid range is between -15 and 15'));
  }

  return soap.invoke(
    `${player.baseUrl}/MediaRenderer/RenderingControl/Control`,
    TYPE.SetEQ,
    { eqType: eqType, value: value });
}

function surround(player, values) {
  const action = values[0];
  const value = parseInt(values[1], 10);

  switch (action) {
    case 'tv':
      return setSurroundEq(player, 'SurroundLevel', value).then(() => {
        return { status: 'success', surroundTvLevel: value };
      });
    case 'music':
      return setSurroundEq(player, 'MusicSurroundLevel', value).then(() => {
        return { status: 'success', surroundMusicLevel: value };
      });
  }

  return Promise.resolve({
    message: 'Valid options are tv, music'
  });
}

module.exports = function (api) {
  api.registerAction('surround', surround);
};
