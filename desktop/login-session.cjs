const fs = require('node:fs');
const path = require('node:path');
const { isPlatformUrl, cookieUrl, cookieIdentity } = require('./browser-policy.cjs');

// Chromium persists expiring cookies itself. Session-only cookies need an encrypted
// restore snapshot; their server-side validity is never changed or extended.
async function retainLogin(ses, userData, safeStorage, log = () => {}) {
  const file = path.join(userData, 'login-session.bin');
  let timer, restoring = true, revision = 0, chain = Promise.resolve();
  const encrypted = safeStorage.isEncryptionAvailable();
  async function snapshot() {
    if (!encrypted) return;
    const currentRevision = revision;
    const cookies = (await ses.cookies.get({ session: true })).filter(c => isPlatformUrl(cookieUrl(c)));
    // Don't let an older async read overwrite a newer logout/change.
    if (currentRevision !== revision) return;
    const bytes = safeStorage.encryptString(JSON.stringify({ savedAt: Date.now(), cookies }));
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(file + '.tmp', bytes);
    fs.renameSync(file + '.tmp', file);
  }
  function changed() {
    revision++;
    if (restoring) return;
    clearTimeout(timer);
    timer = setTimeout(() => { chain = chain.then(snapshot).catch(() => log('login-save-failed')); }, 200);
  }
  ses.cookies.on('changed', changed);
  if (encrypted && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      // Local restore is bounded; the server may invalidate any token sooner.
      if (Date.now() - saved.savedAt < 7 * 86400000 && Array.isArray(saved.cookies)) {
        const present = new Set((await ses.cookies.get({})).map(cookieIdentity));
        for (const c of saved.cookies) {
          if (!c.session || !isPlatformUrl(cookieUrl(c)) || present.has(cookieIdentity(c))) continue;
          const details = { url: cookieUrl(c), name: c.name, value: c.value, path: c.path || '/',
            secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
          if (!c.hostOnly) details.domain = c.domain;
          await ses.cookies.set(details);
        }
      }
    } catch { log('login-restore-unavailable'); }
  }
  restoring = false;
  if (!encrypted) log('login-encryption-unavailable');
  return {
    async flush() {
      clearTimeout(timer);
      await chain;
      await snapshot();
      await ses.cookies.flushStore();
      ses.flushStorageData();
    },
  };
}
module.exports = { retainLogin };
