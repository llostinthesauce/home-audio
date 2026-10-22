'use strict';
const os = require('os');

// Fetch-metadata values a browser sends when another site started the request.
// Native clients (Shortcuts, curl) send none, and the bundled UI is same-origin.
const CROSS_SITE = new Set(['cross-site', 'same-site']);

function hostName(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

// Names this box answers to: loopback, its hostname and every interface address
// (LAN, Tailscale), read per request so a DHCP change needs no restart.
function localNames(extra) {
  const names = new Set(['localhost', '127.0.0.1', '::1']);
  const host = os.hostname().toLowerCase().replace(/\.local$/, '');
  names.add(host);
  names.add(`${host}.local`);
  Object.values(os.networkInterfaces()).forEach((addresses) => {
    (addresses || []).forEach((address) => names.add(address.address.toLowerCase()));
  });
  (extra || []).forEach((name) => names.add(String(name).toLowerCase()));
  return names;
}

// Why an API request must be refused, or null. A web page that rebinds its own
// hostname to this box still sends that hostname; a page firing requests at this
// box from another site is labelled cross-site by the browser.
function refusal(req, allowedHosts) {
  if (req.headers.host && !localNames(allowedHosts).has(hostName(req.headers.host))) {
    return 'unexpected Host header';
  }
  if (CROSS_SITE.has(req.headers['sec-fetch-site'])) {
    return 'cross-site request refused';
  }
  return null;
}

module.exports = { refusal, hostName, localNames };
