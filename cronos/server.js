'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const auth = require('basic-auth');
const SonosSystem = require('sonos-discovery');
const logger = require('sonos-discovery/lib/helpers/logger');
const SonosHttpAPI = require('./lib/sonos-http-api.js');
const serveStatic = require('serve-static');
const settings = require('./settings');
const requestGuard = require('./lib/helpers/request-guard');

const serve = new serveStatic(settings.webroot);
const discovery = new SonosSystem(settings);
const api = new SonosHttpAPI(discovery, settings);

var requestHandler = function (req, res) {
  req.addListener('end', function () {
    serve(req, res, function (err) {

      // If error, route it.
      // This bypasses authentication on static files!
      //if (!err) {
      //  return;
      //}

      if (settings.auth) {
        var credentials = auth(req);

        if (!credentials || credentials.name !== settings.auth.username || credentials.pass !== settings.auth.password) {
          res.statusCode = 401;
          res.setHeader('WWW-Authenticate', 'Basic realm="Access Denied"');
          res.end('Access denied');
          return;
        }
      }

      if (settings.allowCrossSite) {
        // Opt-in for browser clients served from another origin.
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.headers['access-control-request-headers']) {
          res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
        }
      } else {
        // Every API call is a GET that changes speaker state, so refuse what only
        // another web page would send. Static UI files are served above, so links
        // to the UI from other pages still open it.
        const refused = requestGuard.refusal(req, settings.allowedHosts);
        if (refused) {
          res.statusCode = 403;
          res.end(refused);
          return;
        }
      }

      if (req.method === 'OPTIONS') {
        res.end();
        return;
      }

      if (req.method === 'GET') {
        api.requestHandler(req, res);
      }
    });
  }).resume();
};

let server;

if (settings.https) {
  var options = {};
  if (settings.https.pfx) {
    options.pfx = fs.readFileSync(settings.https.pfx);
    options.passphrase = settings.https.passphrase;
  } else if (settings.https.key && settings.https.cert) {
    options.key = fs.readFileSync(settings.https.key);
    options.cert = fs.readFileSync(settings.https.cert);
  } else {
    logger.error("Insufficient configuration for https");
    return;
  }

  const secureServer = https.createServer(options, requestHandler);
  secureServer.listen(settings.securePort, settings.ip, function () {
    logger.info('https server listening on port', settings.securePort);
  });
}

server = http.createServer(requestHandler);

process.on('unhandledRejection', (err) => {
  logger.error(err);
});

let host = settings.ip;
server.listen(settings.port, host, function () {
  logger.info('http server listening on', host, 'port', settings.port);
});

server.on('error', (err) => {
  if (err.code && err.code === 'EADDRINUSE') {
    logger.error(`Port ${settings.port} seems to be in use already. Make sure the sonos-http-api isn't 
    already running, or that no other server uses that port. You can specify an alternative http port 
    with property "port" in settings.json`);
  } else {
    logger.error(err);
  }

  process.exit(1);
});


