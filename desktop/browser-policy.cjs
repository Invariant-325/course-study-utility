// /mycourse/stu is a particular course, requiring platform-generated parameters.
// Enter through the official portal and use its own course-menu action instead.
const PORTAL_URL = 'https://i.chaoxing.com/base';
function isPlatformUrl(value) {
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) && /(^|\.)(chaoxing|xuexitong)\.com$/i.test(u.hostname); }
  catch { return false; }
}
function isAllowedNavigationUrl(value) {
  try {
    const u=new URL(value);
    return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&/(^|\.)(chaoxing|xuexitong)\.com$/i.test(u.hostname);
  } catch {return false;}
}
function isLandingUrl(value) {
  if (!isPlatformUrl(value)) return false;
  const u = new URL(value);
  // Never interrupt login, QR/face verification, course pages, or return callbacks.
  if (u.searchParams.has('code') || u.searchParams.has('ticket')) return false;
  return u.hostname === 'i.chaoxing.com' && /^\/(?:base(?:\/index)?|index)?\/?$/.test(u.pathname);
}
// Runs in the portal document. Clicking keeps its handlers, iframe target, and
// all URL parameters intact. No account/course IDs or signed URLs are invented.
function clickCourseMenu() {
  const labels = new Set(['课程', '我的课程', '我学的课']);
  const nodes = [...document.querySelectorAll('a, [dataurl], [data-url]')];
  for (const node of nodes) {
    const text = String(node.textContent || '').replace(/\s+/g, '');
    const title = String(node.getAttribute('title') || '').replace(/\s+/g, '');
    if (!labels.has(text) && !labels.has(title)) continue;
    if (!node.getClientRects().length) continue;
    const target = node.getAttribute('dataurl') || node.getAttribute('data-url') || node.getAttribute('href') || '';
    if (/^(?:https?:|\/)/i.test(target)) {
      let url;
      try { url = new URL(target, location.href); } catch { continue; }
      if (!/(^|\.)(chaoxing|xuexitong)\.com$/i.test(url.hostname)) continue;
      if (/\/mycourse\/stu\/?$/i.test(url.pathname) && !url.searchParams.has('courseid') && !url.searchParams.has('courseId')) continue;
    }
    node.click();
    return true;
  }
  return false;
}
function cookieUrl(c) { return (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + (c.path || '/'); }
function cookieIdentity(c) { return JSON.stringify([c.domain, c.path || '/', c.name]); }
module.exports = { PORTAL_URL, isPlatformUrl, isAllowedNavigationUrl, isLandingUrl, clickCourseMenu, cookieUrl, cookieIdentity };
