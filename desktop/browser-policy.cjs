const COURSE_URL = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu';
function isPlatformUrl(value) {
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) && /(^|\.)(chaoxing|xuexitong)\.com$/i.test(u.hostname); }
  catch { return false; }
}
function isLandingUrl(value) {
  if (!isPlatformUrl(value)) return false;
  const u = new URL(value);
  // Never interrupt login, QR/face verification, course pages, or return callbacks.
  if (u.searchParams.has('code') || u.searchParams.has('ticket')) return false;
  return (/^mooc[12](?:-ans)?\.chaoxing\.com$/i.test(u.hostname) && u.pathname === '/') ||
    (u.hostname === 'i.chaoxing.com' && /^\/(?:base(?:\/index)?|index)?\/?$/.test(u.pathname));
}
function cookieUrl(c) { return (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + (c.path || '/'); }
function cookieIdentity(c) { return JSON.stringify([c.domain, c.path || '/', c.name]); }
module.exports = { COURSE_URL, isPlatformUrl, isLandingUrl, cookieUrl, cookieIdentity };
