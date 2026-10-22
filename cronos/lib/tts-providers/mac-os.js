'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const fileDuration = require('../helpers/file-duration');
const settings = require('../../settings');
const logger = require('sonos-discovery/lib/helpers/logger');
var execFile = require('child_process').execFile;

// Voice names as macOS lists them, e.g. "Samantha" or "Ava (Premium)".
const VOICE_NAME = /^[\w .()'-]{1,64}$/;

function macSay(phrase, voice) {
  if (!settings.macSay) {
    return Promise.resolve();
  }

  var selcetedRate = settings.macSay.rate;
  if( !selcetedRate ) {
    selcetedRate = "default";
  }
  var selectedVoice = settings.macSay.voice;
  if( voice ) {
    selectedVoice = voice;
  }
  // The voice comes from the request URL and also names the output file.
  if (selectedVoice && !VOICE_NAME.test(selectedVoice)) {
    return Promise.reject(new Error(`invalid voice name: ${selectedVoice}`));
  }

  // Construct a filesystem neutral filename
  const phraseHash = crypto.createHash('sha1').update(phrase).digest('hex');
  const filename = `macSay-${phraseHash}-${selcetedRate}-${selectedVoice}.m4a`;
  const filepath = path.resolve(settings.webroot, 'tts', filename);

  const expectedUri = `/tts/${filename}`;

  try {
    fs.accessSync(filepath, fs.R_OK);
    return fileDuration(filepath)
      .then((duration) => {
        return {
          duration,
          uri: expectedUri
        };
      });
  } catch (err) {
    logger.info(`announce file for phrase "${phrase}" does not seem to exist, downloading`);
  }

 return new Promise((resolve, reject) => {
    //
    // For more information on the "say" command, type "man say" in Terminal
    // or go to
    // https://developer.apple.com/legacy/library/documentation/Darwin/Reference/ManPages/man1/say.1.html
    //
    // The list of available voices can be configured in
    // System Preferences -> Accessibility -> Speech -> System Voice
    //

    // execFile hands each argument to `say` as-is, so a phrase or voice from the
    // request URL never becomes shell syntax; `--` keeps a phrase starting with
    // "-" from being read as an option.
    const args = [];
    if ( selcetedRate != "default" ) {
      args.push('-r', String(selcetedRate));
    }
    if ( selectedVoice ) {
      args.push('-v', selectedVoice);
    }
    args.push('-o', filepath, '--', phrase);

    execFile('say', args,
      function (error, stdout, stderr) {
        if (error !== null) {
          reject(error);
        } else {
          resolve(expectedUri);
        }
      });

    })
    .then(() => {
      return fileDuration(filepath);
    })
    .then((duration) => {
      return {
        duration,
        uri: expectedUri
      };
    });
}

module.exports = macSay;
