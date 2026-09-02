'use strict';

const os = require('os');

function isPrivate(ip) {
  return /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/** Every usable non-loopback IPv4 address on this host. */
function ipv4Interfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      const family = a.family === 'IPv4' || a.family === 4;
      if (!family || a.internal) continue;
      out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

/**
 * Best guess at the address other machines on the LAN should be told to use.
 * Prefers a private RFC1918 address; falls back to the first non-loopback one.
 */
function detectLanIp() {
  const ifaces = ipv4Interfaces();
  const priority = ['br0', 'eth0', 'en0', 'bond0'];
  const privates = ifaces.filter((i) => isPrivate(i.address));
  const pool = privates.length ? privates : ifaces;
  for (const want of priority) {
    const hit = pool.find((i) => i.name === want);
    if (hit) return hit.address;
  }
  return pool.length ? pool[0].address : '127.0.0.1';
}

/** Resolves the configured advertise IP, honouring an explicit override. */
function advertiseIp(settings) {
  const configured = String(settings?.advertiseIp || 'auto').trim();
  if (configured && configured !== 'auto' && /^\d{1,3}(\.\d{1,3}){3}$/.test(configured)) {
    return configured;
  }
  return detectLanIp();
}

/**
 * Docker's default bridge hands out 172.17-31.x addresses that only exist
 * inside the host. Advertising one over mDNS produces names that resolve to an
 * unreachable address, which is the single most likely way to misconfigure this
 * container — so it is worth calling out loudly at startup.
 */
function looksLikeDockerBridge(ip) {
  if (!/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  // A real LAN on 172.16/12 would normally show more than one usable interface
  // or a non-eth0 name; a bridged container sees exactly eth0.
  const ifaces = ipv4Interfaces();
  return ifaces.length === 1 && ifaces[0].name === 'eth0' && ifaces[0].address === ip;
}

module.exports = {
  ipv4Interfaces, detectLanIp, advertiseIp, isPrivate, looksLikeDockerBridge,
};
