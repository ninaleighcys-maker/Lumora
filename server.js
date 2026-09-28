
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// Keep user data outside the website source folder by default so replacing/updating
// the Lumora code does not overwrite follows, accounts, messages, books, etc.
// Set LUMORA_DATA_DIR when you want a specific persistent data location.
const DEFAULT_DATA_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Lumora')
  : path.join(process.env.HOME || process.env.USERPROFILE || ROOT, '.lumora-data');
const DATA_DIR = process.env.LUMORA_DATA_DIR || DEFAULT_DATA_DIR;
const DB_FILE = process.env.LUMORA_DB_FILE || path.join(DATA_DIR, 'db.json');
const LEGACY_DB_FILE = path.join(ROOT, 'data', 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Optional managed PostgreSQL storage for public deployments. The existing JSON
// database remains available for local development. We keep the same data shape
// in one PostgreSQL row so the rest of Lumora's feature code does not need a rewrite.
const DATABASE_URL = process.env.DATABASE_URL || '';
let remotePool = null;
let remoteDb = null;
let remoteSaveQueue = Promise.resolve();
let databaseInitPromise = null;
let databaseReady = false;
let databaseInitError = null;

const EMPTY_DB = {
  users: [], sessions: [], emailVerifications: [], passwordResets: [], books: [], diaries: [],
  posts: [], comments: [], likes: [], highlights: [], bookmarks: [], follows: [], followRequests: [], friendRequests: [], friendships: [], messages: [], messageRequests: [], notifications: [], libraries: [], readingProgress: [], favorites: [], reposts: [], bookReads: [], chapterReads: []
};
if (!fs.existsSync(DB_FILE)) {
  // One-time migration from the old project-local database. This keeps existing
  // follows and all other user data when the enhanced project is opened.
  if (DB_FILE !== LEGACY_DB_FILE && fs.existsSync(LEGACY_DB_FILE)) {
    fs.copyFileSync(LEGACY_DB_FILE, DB_FILE);
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(EMPTY_DB, null, 2));
  }
}

function normalizeDb(d) {
  d = d && typeof d === 'object' ? d : {};
  for (const k of Object.keys(EMPTY_DB)) if (!Array.isArray(d[k])) d[k] = [];
  let changed = false;
  for (const b of d.books) {
    const font = storyFont(b.fontFamily);
    if (b.fontFamily !== font) { b.fontFamily = font; changed = true; }
    if (!Array.isArray(b.chapters)) { b.chapters = []; changed = true; }
    for (const c of b.chapters) if (c.contentHtml === undefined) { c.contentHtml = ''; changed = true; }
  }
  if (changed) save(d);
  return d;
}
function db() {
  if (remoteDb) return remoteDb;
  return normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
}
function save(d) {
  if (Object.prototype.hasOwnProperty.call(d,'__bookStatsCache')) delete d.__bookStatsCache;
  if (Object.prototype.hasOwnProperty.call(d,'__lumoraIndex')) delete d.__lumoraIndex;
  if (remotePool && remoteDb) {
    remoteDb = normalizeDb(d);
    const snapshot = JSON.parse(JSON.stringify(remoteDb));
    remoteSaveQueue = remoteSaveQueue
      .then(() => remotePool.query('UPDATE lumora_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1', [JSON.stringify(snapshot)]))
      .catch(err => console.error('Remote database save failed:', err.message));
    return;
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
}
async function initRemoteDatabase() {
  if (!DATABASE_URL) return;
  remotePool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
  await remotePool.query(`CREATE TABLE IF NOT EXISTS lumora_state (id INTEGER PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const result = await remotePool.query('SELECT data FROM lumora_state WHERE id = 1');
  if (result.rows.length) {
    remoteDb = normalizeDb(result.rows[0].data);
  } else {
    const local = normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    remoteDb = local;
    await remotePool.query('INSERT INTO lumora_state (id, data) VALUES (1, $1::jsonb)', [JSON.stringify(local)]);
  }
  // Keep startup fast. The normalized schema/backfill is intentionally not run before server.listen().
  console.log('Lumora is using managed PostgreSQL storage.');
}
async function closeRemoteDatabase() {
  if (remotePool) await remotePool.end();
}
const TRASH_DAYS = 30;
function notify(d, userId, type, actorId, message, targetType='', targetId='') {
  if (!userId || !actorId || userId === actorId) return;
  const now=Date.now();
  const duplicate=d.notifications.some(n=>n.userId===userId&&n.type===type&&n.actorId===actorId&&n.targetType===targetType&&n.targetId===targetId&&!n.readAt&&now-Number(n.createdAt||0)<5*60*1000);
  if(duplicate)return;
  d.notifications.push({id:id(),userId,type,actorId,message,targetType,targetId,createdAt:now,readAt:null});
}
function activeOnly(arr) { return arr.filter(x => !x.deletedAt); }
function cleanupTrash(d) {
  const now = Date.now();
  let changed = false;
  const expired = (x) => x.deletedAt && (x.deletedUntil || (x.deletedAt + TRASH_DAYS*24*60*60*1000)) <= now;
  for (const type of ['posts','diaries','books']) {
    const arr = d[type];
    const doomed = arr.filter(expired);
    if (!doomed.length) continue;
    for (const item of doomed) {
      if (type === 'books') {
        const chapterIds = (item.chapters||[]).map(c=>c.id);
        d.comments = d.comments.filter(c => !(c.targetType === 'chapter' && chapterIds.includes(c.targetId)));
        d.highlights = d.highlights.filter(h => !chapterIds.includes(h.chapterId));
        d.bookmarks = d.bookmarks.filter(b => !chapterIds.includes(b.chapterId));
        d.libraries = d.libraries.filter(l => l.bookId !== item.id);
        d.favorites = d.favorites.filter(f => f.bookId !== item.id);
        d.bookReads = d.bookReads.filter(r => r.bookId !== item.id);
        d.chapterReads = d.chapterReads.filter(r => r.bookId !== item.id);
      } else {
        d.comments = d.comments.filter(c => !(c.targetType === (type==='posts'?'post':'diary') && c.targetId === item.id));
      }
      d.notifications = d.notifications.filter(n => !(n.targetType === type.slice(0,-1) && n.targetId === item.id));
    }
    d[type] = arr.filter(x => !expired(x));
    changed = true;
  }
  if (changed) save(d);
  return changed;
}
function markTrash(item) {
  const now = Date.now();
  item.deletedAt = now;
  item.deletedUntil = now + TRASH_DAYS*24*60*60*1000;
  item.updatedAt = now;
}
function contentIsActive(item) { return !!item && !item.deletedAt; }
function id() { return crypto.randomUUID(); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}
function cookie(name, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' || String(process.env.APP_URL || '').startsWith('https://');
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; ${secure ? 'Secure; ' : ''}${maxAge === 0 ? 'Max-Age=0' : `Max-Age=${maxAge}`}`;
}
function getCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => {
    const i = x.indexOf('=');
    return [x.slice(0, i).trim(), decodeURIComponent(x.slice(i + 1))];
  }));
}
function userFrom(req) {
  const token = getCookies(req).lumora_session;
  if (!token) return null;
  const d = db();
  const s = d.sessions.find(x => x.token === token && x.expiresAt > Date.now());
  if (!s) return null;
  return d.users.find(u => u.id === s.userId) || null;
}
function safeUser(u) {
  return u && { id: u.id, username: u.username, name: u.name, email: u.email, emailVerified: !!u.emailVerified, bio: u.bio, avatarUrl: u.avatarUrl || '', coverUrl: u.coverUrl || '', favoriteQuote: u.favoriteQuote || '', theme: u.theme || 'Rose', accountPrivacy: u.accountPrivacy || 'public', messagePermission: u.messagePermission || 'everyone', createdAt: u.createdAt };
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => {
      s += c;
      if (s.length > 12e6) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function requireUser(req, res, options = {}) {
  const u = userFrom(req);
  if (!u) { send(res, 401, { error: 'Please log in first.' }); return null; }
  if (!u.emailVerified && !options.allowUnverified) {
    send(res, 403, { error: 'Please verify your email before using Lumora.', code: 'EMAIL_NOT_VERIFIED' });
    return null;
  }
  return u;
}
function lumoraIndex(d){
  let idx=d.__lumoraIndex;if(idx)return idx;
  const usersById=new Map(),booksById=new Map(),chapterToBook=new Map(),follows=new Set(),friends=new Set(),followersByUser=new Map(),followingByUser=new Map(),friendsByUser=new Map(),commentsByTarget=new Map(),likesByTarget=new Map(),repostsByUserPost=new Set(),notificationsByUser=new Map(),messagesByPair=new Map(),chapterReads=new Map();
  for(const u of d.users)usersById.set(u.id,u);
  for(const b of d.books){booksById.set(b.id,b);for(const ch of b.chapters||[])chapterToBook.set(ch.id,b.id);}
  for(const x of d.follows){follows.add(x.followerId+'|'+x.followingId);let a=followingByUser.get(x.followerId);if(!a){a=new Set();followingByUser.set(x.followerId,a)}a.add(x.followingId);let b=followersByUser.get(x.followingId);if(!b){b=new Set();followersByUser.set(x.followingId,b)}b.add(x.followerId)}
  for(const x of d.friendships){const k=x.userA<x.userB?x.userA+'|'+x.userB:x.userB+'|'+x.userA;friends.add(k);for(const id of [x.userA,x.userB]){let a=friendsByUser.get(id);if(!a){a=new Set();friendsByUser.set(id,a)}a.add(id===x.userA?x.userB:x.userA)}}
  for(const x of d.comments){const k=x.targetType+'|'+x.targetId;commentsByTarget.set(k,(commentsByTarget.get(k)||0)+1)}
  for(const x of d.likes){const k=x.targetType+'|'+x.targetId;let v=likesByTarget.get(k);if(!v){v={count:0,users:new Set()};likesByTarget.set(k,v)}v.count++;v.users.add(x.userId)}
  for(const x of d.reposts)repostsByUserPost.add(x.userId+'|'+x.postId);
  for(const x of d.notifications){let a=notificationsByUser.get(x.userId);if(!a){a=[];notificationsByUser.set(x.userId,a)}a.push(x)}
  for(const x of d.messages){const k=x.fromId<x.toId?x.fromId+'|'+x.toId:x.toId+'|'+x.fromId;let a=messagesByPair.get(k);if(!a){a=[];messagesByPair.set(k,a)}a.push(x)}
  for(const x of d.chapterReads)chapterReads.set(x.chapterId,(chapterReads.get(x.chapterId)||0)+1);
  idx={usersById,booksById,chapterToBook,follows,friends,followersByUser,followingByUser,friendsByUser,commentsByTarget,likesByTarget,repostsByUserPost,notificationsByUser,messagesByPair,chapterReads};
  Object.defineProperty(d,'__lumoraIndex',{value:idx,writable:true,configurable:true,enumerable:false});return idx;
}
function undirectedKey(a,b){return a<b?a+'|'+b:b+'|'+a}

function publicUser(d, userId, includeAvatar = true) {
  const u = lumoraIndex(d).usersById.get(userId);
  if (!u) return { id: userId, username: 'Unknown', name: 'Unknown', ...(includeAvatar ? { avatarUrl: '' } : {}) };
  return { id: u.id, username: u.username, name: u.name, ...(includeAvatar ? { avatarUrl: u.avatarUrl || '' } : {}) };
}
function isFollowing(d, followerId, followingId) { return lumoraIndex(d).follows.has(followerId+'|'+followingId); }
function areFriends(d, a, b) { return lumoraIndex(d).friends.has(undirectedKey(a,b)); }
function accountVisible(d, ownerId, viewer) {
  if (!viewer || ownerId === viewer.id) return true;
  const owner = lumoraIndex(d).usersById.get(ownerId);
  if (!owner || (owner.accountPrivacy || 'public') === 'public') return true;
  const i=lumoraIndex(d); return i.follows.has(viewer.id+'|'+ownerId) || i.friends.has(undirectedKey(viewer.id,ownerId));
}
function visibilityAllowed(d, visibility, ownerId, viewer) {
  if (ownerId === viewer.id) return true;
  if (!accountVisible(d, ownerId, viewer)) return false;
  if (visibility === 'public') return true;
  if (visibility === 'followers') return isFollowing(d, viewer.id, ownerId);
  if (visibility === 'friends') return areFriends(d, viewer.id, ownerId);
  return false;
}
function friendshipPair(a,b){return a<b?{userA:a,userB:b}:{userA:b,userB:a};}
function syncMutualFriendship(d,a,b){
  if(a===b || !isFollowing(d,a,b) || !isFollowing(d,b,a)) return false;
  if(!areFriends(d,a,b)) { d.friendships.push({id:id(),...friendshipPair(a,b),createdAt:Date.now()}); return true; }
  return false;
}
function syncAllMutualFriendships(d){
  let changed=false;
  for(const f of d.follows){ if(syncMutualFriendship(d,f.followerId,f.followingId)) changed=true; }
  return changed;
}
function syncFriendshipsFromFollows(d){
  const before=d.friendships.length;
  d.friendships=d.friendships.filter(fr=>isFollowing(d,fr.userA,fr.userB)&&isFollowing(d,fr.userB,fr.userA));
  for(const f of d.follows) syncMutualFriendship(d,f.followerId,f.followingId);
  return d.friendships.length!==before;
}
function cleanSocial(d) {
  let changed=false;
  for (const u of d.users) { if (!u.accountPrivacy) { u.accountPrivacy = 'public'; changed=true; } if (!u.messagePermission) { u.messagePermission = 'everyone'; changed=true; } }
  for (const k of ['follows','followRequests','friendRequests','friendships','messages','messageRequests','readingProgress','libraries','favorites','reposts','likes','bookReads','chapterReads']) if (!Array.isArray(d[k])) { d[k] = []; changed=true; }
  if(syncAllMutualFriendships(d)) changed=true;
  if(syncFriendshipsFromFollows(d)) changed=true;
  if(changed) save(d);
}
function expirePosts(d) {
  let changed = false;
  const now = Date.now();
  for (const p of d.posts) {
    if (p.visibility === 'public' && !p.archivedAt && now - p.createdAt >= 24 * 60 * 60 * 1000) { p.archivedAt = now; changed = true; }
  }
  if (changed) save(d);
}
function sanitizeStoryHtml(value) {
  return String(value || '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*\/?>/gi, '')
    .replace(/\s+(?:on[a-z]+|style|class|id)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/<(?!\/?(?:b|strong|i|em|u|br|p|div)\b)[^>]*>/gi, '')
    .replace(/<\s*strong\s*>/gi, '<b>').replace(/<\s*\/\s*strong\s*>/gi, '</b>')
    .replace(/<\s*em\s*>/gi, '<i>').replace(/<\s*\/\s*em\s*>/gi, '</i>');
}
function storyFont(value) {
  const allowed = ['Roboto','Sans-serif','Arial','Calibri','Source Sans Pro','DM Pro'];
  return allowed.includes(String(value || '')) ? String(value) : 'Roboto';
}
function bookStats(d, b, viewerId) {
  let cache=d.__bookStatsCache;
  if(!cache){
    const reads=new Map(), libraries=new Map(), favorites=new Map(), favoredByViewer=new Map();
    for(const x of d.bookReads){if(x.bookId)reads.set(x.bookId,(reads.get(x.bookId)||0)+1);}
    const libUsers=new Map();
    for(const x of d.libraries){if(!x.bookId||!x.userId)continue;let set=libUsers.get(x.bookId);if(!set){set=new Set();libUsers.set(x.bookId,set);}set.add(x.userId);}
    for(const [k,set] of libUsers)libraries.set(k,set.size);
    const favUsers=new Map();
    for(const x of d.favorites){if(!x.bookId||!x.userId)continue;let set=favUsers.get(x.bookId);if(!set){set=new Set();favUsers.set(x.bookId,set);}set.add(x.userId);}
    for(const [k,set] of favUsers)favorites.set(k,set.size);
    cache={reads,libraries,favorites,favUsers};
    Object.defineProperty(d,'__bookStatsCache',{value:cache,writable:true,configurable:true,enumerable:false});
  }
  const reads=Math.max(cache.reads.get(b.id)||0,Number(b.readingCount||0));
  const library=cache.libraries.get(b.id)||0;
  const favorites=cache.favorites.get(b.id)||0;
  const favored=!!viewerId&&!!cache.favUsers.get(b.id)?.has(viewerId);
  return {reads,libraryAdds:library,favorites,favorited:favored};
}
function chapterReadCount(d, chapterId) { return lumoraIndex(d).chapterReads.get(chapterId)||0; }
function publicBook(b, d, viewerId, includeAvatar = true) {
  const stats = bookStats(d, b, viewerId);
  return {
    id: b.id, userId: b.userId, title: b.title, description: b.description, cover: b.cover,
    genre: b.genre, tags: Array.isArray(b.tags) ? b.tags : [], visibility: b.visibility, readingCount: stats.reads,
    fontFamily: storyFont(b.fontFamily), stats,
    createdAt: b.createdAt, updatedAt: b.updatedAt, author: publicUser(d, b.userId, includeAvatar),
    chapters: b.chapters.map(c => ({ id: c.id, title: c.title, readCount: chapterReadCount(d, c.id) }))
  };
}
function publicBookSummary(b, d, viewerId, includeAvatar = true) {
  const stats = bookStats(d, b, viewerId);
  return { id:b.id, userId:b.userId, title:b.title, description:b.description, cover:b.cover, genre:b.genre, tags:Array.isArray(b.tags)?b.tags:[], visibility:b.visibility, readingCount:stats.reads, fontFamily:storyFont(b.fontFamily), stats, createdAt:b.createdAt, updatedAt:b.updatedAt, chapterCount:Array.isArray(b.chapters)?b.chapters.length:0, chapters:Array.isArray(b.chapters)?b.chapters.map(c=>({id:c.id})):[], author:publicUser(d,b.userId,includeAvatar) };
}
function publicPost(p,d,viewerId=null,includeAvatar=true){const idx=lumoraIndex(d),lk=idx.likesByTarget.get('post|'+p.id)||{count:0,users:new Set()};return {...p,author:publicUser(d,p.userId,includeAvatar),commentCount:idx.commentsByTarget.get('post|'+p.id)||0,likesCount:lk.count,liked:!!viewerId&&lk.users.has(viewerId),reposted:!!viewerId&&idx.repostsByUserPost.has(viewerId+'|'+p.id),mentions:publicMentions(d,p.mentionUserIds)};}
function publicDiary(x,d,viewerId=null,includeAvatar=true){const idx=lumoraIndex(d),lk=idx.likesByTarget.get('diary|'+x.id)||{count:0,users:new Set()};return {...x,author:publicUser(d,x.userId,includeAvatar),commentCount:idx.commentsByTarget.get('diary|'+x.id)||0,likesCount:lk.count,liked:!!viewerId&&lk.users.has(viewerId),mentions:publicMentions(d,x.mentionUserIds)};}
function publicComment(c,d){return {...c,parentId:c.parentId||null,author:publicUser(d,c.userId),mentions:publicMentions(d,c.mentionUserIds)};}function publicRepost(r,d,viewerId=null,includeAvatar=true){const p=d.posts.find(x=>x.id===r.postId&&!x.deletedAt&&x.visibility==='public');return p?{id:r.id,createdAt:r.createdAt,post:publicPost(p,d,viewerId,includeAvatar),reposter:publicUser(d,r.userId,includeAvatar)}:null;}
function publicChapter(c) { return { id: c.id, title: c.title, content: c.content || '', contentHtml: sanitizeStoryHtml(c.contentHtml || '') }; }
const GENRES = ['Romance','New-Adult','R-18','Historical','Horror','Thriller','Sci-fi','Comedy','Action','RomCom','Drama','Apocalyptic','Mystery Thriller','Self-Help','CookBook','Travel','Fantasy'];
function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(x => String(x).trim().replace(/^#/, '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0,40)).filter(Boolean))].slice(0,20);
}
function searchable(value) { return String(value || '').toLowerCase(); }
function extractMentionUserIds(d,text){const ids=new Set();for(const m of String(text||'').matchAll(/@([a-z0-9_]{3,24})/ig)){const username=String(m[1]||'').toLowerCase();const found=d.users.find(x=>x.username===username);if(found)ids.add(found.id);}return [...ids];}
function publicMentions(d,ids){return [...new Set(Array.isArray(ids)?ids:[])].map(x=>d.users.find(u=>u.id===x)).filter(Boolean).map(u=>publicUser(d,u.id));}
function notifyMentions(d,actor,ids,targetType,targetId,label){for(const id of ids||[])notify(d,id,'mention',actor.id,(actor.name||'@'+actor.username)+' '+(label||'mentioned you')+'.',targetType,targetId);}

async function sendVerificationEmail(u, token, code) {
  // Email verification is intentionally code-only. The verification-link path
  // remains available for compatibility, but no verification URL is emailed.
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) {
    console.log(`\n[Lumora email verification] ${u.email}: code ${code}\n`);
    return { delivered: false, previewCode: code };
  }
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: u.email,
    subject: 'Your Lumora verification code',
    text: `Welcome to Lumora.\n\nYour Lumora verification code is: ${code}\n\nEnter this 6-digit code in Lumora to verify your email. This code expires in 5 minutes.`,
    html: `<p>Welcome to Lumora.</p><p>Your Lumora verification code is:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px"><b>${code}</b></p><p>Enter this 6-digit code in Lumora to verify your email.</p><p>This code expires in <b>5 minutes</b>.</p>`
  });
  return { delivered: true };
}
function createVerification(d, u) {
  const token = crypto.randomBytes(32).toString('hex');
  const code = String(crypto.randomInt(100000, 1000000));
  d.emailVerifications = d.emailVerifications.filter(x => x.userId !== u.id);
  d.emailVerifications.push({ tokenHash: hashResetToken(token), codeHash: hashResetToken(code), userId: u.id, expiresAt: Date.now() + 5 * 60 * 1000 });
  return { token, code };
}

function hashResetToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function createPasswordReset(d, u) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(token);
  const codeHash = hashResetToken(code);
  d.passwordResets = d.passwordResets.filter(x => x.userId !== u.id);
  d.passwordResets.push({
    tokenHash,
    codeHash,
    userId: u.id,
    codeExpiresAt: Date.now() + 5 * 60 * 1000,
    expiresAt: Date.now() + 15 * 60 * 1000,
    codeVerifiedAt: null,
    usedAt: null
  });
  return { token, code };
}

async function sendPasswordResetEmail(u, code) {
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) return { delivered: false, previewCode: code };
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: u.email,
    subject: 'Your Lumora password reset code',
    text: `We received a request to reset your Lumora password. Your 6-digit verification code is: ${code}\n\nThis code expires in 5 minutes. If you did not request this, you can ignore this email.`,
    html: `<p>We received a request to reset your Lumora password.</p><p>Your 6-digit verification code is:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px"><b>${code}</b></p><p>This code expires in <b>10 minutes</b>. If you did not request this, you can ignore this email.</p>`
  });
  return { delivered: true };
}

function emailVerificationPage(title, message, ok = false) {
  const safeTitle = String(title || 'Email verification').replace(/[<>&"]/g, '');
  const safeMessage = String(message || '').replace(/[<>&"]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle} • Lumora</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbf7fb;color:#3d3140;font-family:Georgia,'Times New Roman',serif}.box{width:min(560px,calc(100% - 40px));box-sizing:border-box;padding:38px;border:1px solid #eadfea;border-radius:24px;background:white;box-shadow:0 16px 50px rgba(80,55,85,.10);text-align:center}h1{margin:0 0 14px;font-size:34px}.icon{font-size:42px;margin-bottom:12px}p{line-height:1.7;color:#6e6270}.btn{display:inline-block;margin-top:12px;padding:12px 18px;border-radius:12px;background:#9b4f79;color:#fff;text-decoration:none}</style></head><body><main class="box"><div class="icon">${ok?'✓':'✉'}</div><h1>${safeTitle}</h1><p>${safeMessage}</p><a class="btn" href="/">Open Lumora</a></main></body></html>`;
}
function handleEmailVerificationLink(req, res, url) {
  const token = url.searchParams.get('token') || '';
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    res.writeHead(400, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(emailVerificationPage('Invalid verification link', 'This verification link is invalid. Please return to Lumora and request a new verification email.'));
  }
  const d = db();
  const v = d.emailVerifications.find(x => x.expiresAt > Date.now() && (x.token === token || x.tokenHash === hashResetToken(token)));
  if (!v) {
    res.writeHead(400, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(emailVerificationPage('Verification link expired', 'This verification link is invalid or has expired. Please return to Lumora and request a new verification email.'));
  }
  const u = d.users.find(x => x.id === v.userId);
  if (!u) {
    res.writeHead(404, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(emailVerificationPage('Account not found', 'We could not find the Lumora account connected to this verification link.'));
  }
  u.emailVerified = true;
  d.emailVerifications = d.emailVerifications.filter(x => x.userId !== u.id);
  save(d);
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  return res.end(emailVerificationPage('Email verified ✓', 'Your Lumora email has been verified successfully. You can now open Lumora and log in.', true));
}

function passwordResetPage(token, message='') {
  const safeToken = String(token || '').replace(/[^a-f0-9]/gi, '');
  const d = db();
  const valid = /^[a-f0-9]{64}$/i.test(safeToken) && d.passwordResets.some(x => x.tokenHash === hashResetToken(safeToken) && !x.usedAt && x.expiresAt > Date.now());
  const safeMessage = String(message || '').replace(/[<>&"]/g, '');
  if (!valid) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset your Lumora password</title><style>body{margin:0;background:#fbf7fa;color:#352934;font-family:Georgia,serif}.wrap{max-width:520px;margin:70px auto;padding:28px}.card{background:#fff;border:1px solid #eadce5;border-radius:24px;padding:30px;box-shadow:0 18px 50px #6b3f5518}a{color:#9b4f79}.msg{padding:12px;border-radius:12px;background:#f7edf3;margin-bottom:15px}</style></head><body><div class="wrap"><div class="card"><h1>Reset link expired</h1><div class="msg">This password reset link is invalid, expired, or has already been used.</div><p>Please return to Lumora and request a new password reset email.</p><p><a href="/">Back to Lumora</a></p></div></div></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset your Lumora password</title><style>body{margin:0;background:#fbf7fa;color:#352934;font-family:Georgia,serif}.wrap{max-width:520px;margin:70px auto;padding:28px}.card{background:#fff;border:1px solid #eadce5;border-radius:24px;padding:30px;box-shadow:0 18px 50px #6b3f5518}input{width:100%;box-sizing:border-box;padding:13px 14px;border:1px solid #dccbd5;border-radius:12px;margin:8px 0 16px;font:inherit}button{border:0;border-radius:12px;padding:12px 18px;background:#9b4f79;color:#fff;font:inherit;cursor:pointer}a{color:#9b4f79}.msg{padding:12px;border-radius:12px;background:#f7edf3;margin-bottom:15px}</style></head><body><div class="wrap"><div class="card"><h1>Reset your Lumora password</h1>${safeMessage?`<div class="msg">${safeMessage}</div>`:''}<p>Choose a new password for your Lumora account.</p><form id="f"><label>New password</label><input id="p" type="password" minlength="8" autocomplete="new-password" required><label>Confirm new password</label><input id="c" type="password" minlength="8" autocomplete="new-password" required><button>Reset password</button></form><p id="out"></p><p><a href="/">Back to Lumora</a></p></div></div><script>const token=${JSON.stringify(safeToken)};document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const p=document.getElementById('p').value,c=document.getElementById('c').value,o=document.getElementById('out');if(p.length<8)return o.textContent='Password must be at least 8 characters.';if(p!==c)return o.textContent='Passwords do not match.';try{const r=await fetch('/api/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password:p})});const x=await r.json();if(!r.ok)throw new Error(x.error||'Could not reset password.');document.getElementById('f').style.display='none';o.innerHTML='Password reset successfully. <a href="/">Open Lumora and log in.</a>';}catch(err){o.textContent=err.message;}}</script></body></html>`;
}

function targetAllowed(d, type, targetId, u) {
  if (type === 'post') { const p = d.posts.find(x => x.id === targetId); return p && contentIsActive(p) && (!p.archivedAt || p.userId === u.id) && visibilityAllowed(d, p.visibility || 'private', p.userId, u) ? p : null; }
  if (type === 'diary') { const x = d.diaries.find(x => x.id === targetId); return x && contentIsActive(x) && visibilityAllowed(d, x.visibility || 'private', x.userId, u) ? x : null; }
  if (type === 'chapter') {
    for (const b of d.books) {
      const c = b.chapters.find(c => c.id === targetId);
      if (c && (b.visibility === 'public' || b.userId === u.id)) return { ...c, book: b };
    }
  }
  return null;
}

function socialCounts(d, userId) { const i=lumoraIndex(d); return {followers:i.followersByUser.get(userId)?.size||0,following:i.followingByUser.get(userId)?.size||0,friends:i.friendsByUser.get(userId)?.size||0}; }
function socialSummary(d,u) { return {notifications:d.notifications.filter(n=>n.userId===u.id&&!n.readAt).length,...socialCounts(d,u.id), followRequests:d.followRequests.filter(x=>x.toId===u.id&&x.status==='pending').length, friendRequests:d.friendRequests.filter(x=>x.toId===u.id&&x.status==='pending').length, messageRequests:d.messageRequests.filter(x=>x.toId===u.id&&x.status==='pending').length}; }
function messagingAllowed(d,from,to) {
  if (!to || from.id===to.id) return false;
  if ((to.accountPrivacy||'public')==='private' && !accountVisible(d,to.id,from)) return false;
  if (areFriends(d,from.id,to.id)) return true;
  const p=to.messagePermission||'everyone';
  if(p==='everyone') return true;
  if(p==='followers') return isFollowing(d,from.id,to.id);
  if(p==='friends') return false;
  return false;
}
function messageRequestAllowed(d,from,to) {
  if (!to || from.id===to.id) return false;
  if ((to.accountPrivacy||'public')==='private' && !accountVisible(d,to.id,from)) return false;
  return true;
}
function messageRequestDeclined(d,fromId,toId) {
  const rows=d.messageRequests.filter(r=>r.fromId===fromId&&r.toId===toId);
  const latest=rows.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0))[0];
  return latest?.status==='declined';
}

function notifyBookChapterUpdate(d,book,chapter,actorId){
  if(!book||!chapter||!actorId)return;
  const recipients=new Set();
  for(const f of d.follows||[])if(f.followingId===book.userId&&f.followerId!==actorId)recipients.add(f.followerId);
  for(const r of d.bookReads||[])if(r.bookId===book.id&&r.userId!==actorId)recipients.add(r.userId);
  for(const r of d.readingProgress||[])if(r.bookId===book.id&&r.userId!==actorId)recipients.add(r.userId);
  const actor=d.users.find(x=>x.id===actorId);
  const message=(actor?.name||'Author')+' added a new chapter to "'+(book.title||'this book')+'".';
  for(const userId of recipients){notify(d,userId,'new_chapter',actorId,message,'chapter',chapter.id);const n=d.notifications[d.notifications.length-1];if(n&&n.type==='new_chapter'&&n.targetId===chapter.id&&n.userId===userId)n.bookId=book.id;}
}

async function api(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/me') return send(res, 200, { user: safeUser(userFrom(req)) });


  if (req.method === 'POST' && p === '/api/forgot-password') {
    const x = await body(req);
    const identifier = String(x.identifier || x.email || '').trim().toLowerCase();
    const d = db();
    const user = d.users.find(item => item.email === identifier || item.username === identifier);
    if (!user) return send(res, 200, { ok: true, message: 'If that account exists, a password reset code has been sent.' });
    const reset = createPasswordReset(d, user);
    save(d);
    try {
      const delivery = await sendPasswordResetEmail(user, reset.code);
      return send(res, 200, {
        ok: true,
        message: 'If that account exists, a password reset code has been sent.',
        previewCode: delivery.previewCode || null
      });
    } catch (e) {
      console.error('Password reset email failed:', e.message);
      return send(res, 200, { ok: true, message: 'If that account exists, a password reset code has been sent.' });
    }
  }

  if (req.method === 'POST' && p === '/api/verify-password-reset-code') {
    const x = await body(req);
    const identifier = String(x.identifier || x.email || '').trim().toLowerCase();
    const code = String(x.code || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) return send(res, 400, { error: 'Please enter the 6-digit password reset code.' });
    const d = db();
    const user = d.users.find(item => item.email === identifier || item.username === identifier);
    const reset = user && d.passwordResets.find(item =>
      item.userId === user.id &&
      !item.usedAt &&
      item.codeExpiresAt > Date.now() &&
      (item.code === code || item.codeHash === hashResetToken(code))
    );
    if (!reset) return send(res, 400, { error: 'That password reset code is invalid or expired.' });
    reset.codeVerifiedAt = Date.now();
    reset.expiresAt = Date.now() + 15 * 60 * 1000;
    save(d);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/reset-password') {
    const x = await body(req);
    const password = String(x.password || '');
    if (password.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
    const d = db();
    const token = String(x.token || '');
    let reset = null;

    if (/^[a-f0-9]{64}$/i.test(token)) {
      reset = d.passwordResets.find(item => item.tokenHash === hashResetToken(token) && !item.usedAt && item.expiresAt > Date.now());
    } else {
      const identifier = String(x.identifier || x.email || '').trim().toLowerCase();
      const code = String(x.code || '').replace(/\D/g, '');
      const user = d.users.find(item => item.email === identifier || item.username === identifier);
      reset = user && d.passwordResets.find(item =>
        item.userId === user.id &&
        !item.usedAt &&
        item.codeVerifiedAt &&
        item.expiresAt > Date.now() &&
        (item.code === code || item.codeHash === hashResetToken(code))
      );
    }

    if (!reset) return send(res, 400, { error: 'Your password reset code is invalid or expired. Please request a new code.' });
    const user = d.users.find(item => item.id === reset.userId);
    if (!user) return send(res, 400, { error: 'Your password reset request is invalid or expired.' });
    user.passwordHash = hashPassword(password);
    reset.usedAt = Date.now();
    d.passwordResets = d.passwordResets.filter(item => item.userId !== user.id);
    d.sessions = d.sessions.filter(item => item.userId !== user.id);
    save(d);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/verify-email-code') {
    const u = userFrom(req);
    if (!u) return send(res, 401, { error: 'Please log in first.' });
    if (u.emailVerified) return send(res, 400, { error: 'Your email is already verified.' });
    const x = await body(req);
    const code = String(x.code || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) return send(res, 400, { error: 'Please enter the 6-digit verification code.' });
    const d = db();
    const v = d.emailVerifications.find(x => x.userId === u.id && x.expiresAt > Date.now());
    const codeMatches = v && (v.code === code || v.codeHash === hashResetToken(code));
    if (!v || !codeMatches) return send(res, 400, { error: 'That verification code is invalid or expired.' });
    u.emailVerified = true;
    d.emailVerifications = d.emailVerifications.filter(x => x.userId !== u.id);
    save(d);
    return send(res, 200, { ok: true, user: safeUser(u) });
  }


  if (req.method === 'POST' && p === '/api/signup') {
    const x = await body(req);
    const email = String(x.email || '').trim().toLowerCase();
    const username = String(x.username || '').trim().toLowerCase();
    const name = String(x.name || username).trim();
    const password = String(x.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Please enter a valid email address.' });
    if (!/^[a-z0-9_]{3,25}$/.test(username)) return send(res, 400, { error: 'Username must be 3-25 characters using letters, numbers, or underscores.' });
    if (password.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
    const d = db();
    if (d.users.some(u => u.username === username)) return send(res, 409, { error: 'Username already exists.' });
    if (d.users.some(u => u.email === email)) return send(res, 409, { error: 'Email is already registered.' });
    const u = { id: id(), username, email, name, bio: '', avatarUrl: '', coverUrl: '', favoriteQuote: '', passwordHash: hashPassword(password), emailVerified: false, createdAt: Date.now() };
    d.users.push(u);
    const verification = createVerification(d, u);
    const sessionToken = crypto.randomBytes(32).toString('hex');
    d.sessions.push({ token: sessionToken, userId: u.id, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
    save(d);
    let delivery = { delivered: false };
    try { delivery = await sendVerificationEmail(u, verification.token, verification.code); } catch (e) { console.error('Verification email failed:', e.message); }
    return send(res, 201, { user: safeUser(u), requiresVerification: true, previewCode: delivery.previewCode || null },
      { 'Set-Cookie': cookie('lumora_session', sessionToken, 30 * 24 * 60 * 60) });
  }

  if (req.method === 'POST' && p === '/api/resend-verification') {
    const u = userFrom(req);
    if (!u) return send(res, 401, { error: 'Please log in first.' });
    if (u.emailVerified) return send(res, 400, { error: 'Your email is already verified.' });
    const d = db();
    const verification = createVerification(d, u); save(d);
    try {
      const delivery = await sendVerificationEmail(u, verification.token, verification.code);
      return send(res, 200, { ok: true, previewCode: delivery.previewCode || null });
    } catch (e) {
      console.error(e); return send(res, 500, { error: 'Could not send the verification email.' });
    }
  }

  if (req.method === 'POST' && p === '/api/login') {
    const x = await body(req);
    const identifier = String(x.identifier || x.username || '').trim().toLowerCase();
    const password = String(x.password || '');
    const d = db();
    const u = d.users.find(u => u.username === identifier || u.email === identifier);
    if (!u || !verifyPassword(password, u.passwordHash)) return send(res, 401, { error: 'Invalid email/username or password.' });
    const token = crypto.randomBytes(32).toString('hex');
    d.sessions = d.sessions.filter(s => s.userId !== u.id || s.expiresAt <= Date.now());
    d.sessions.push({ token, userId: u.id, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
    save(d);
    return send(res, 200, { user: safeUser(u) },
      { 'Set-Cookie': cookie('lumora_session', token, 30 * 24 * 60 * 60) });
  }

  if (req.method === 'POST' && p === '/api/logout') {
    const token = getCookies(req).lumora_session;
    const d = db(); d.sessions = d.sessions.filter(s => s.token !== token); save(d);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('lumora_session', '', 0) });
  }

  const u = requireUser(req, res);
  if (!u) return;
  const d = db();
  // Scheduled maintenance handles consistency/archiving/trash cleanup; requests stay focused on the requested operation.
  for (const b of d.books) if (!Array.isArray(b.tags)) b.tags=[];
  for (const x of d.diaries) { if (x.weather===undefined) x.weather=''; if (x.season===undefined) x.season=''; }

  if (req.method === 'GET' && p === '/api/dashboard') {
    return send(res, 200, {
      user: { ...safeUser(u), avatarUrl: '', coverUrl: '' },
      books: d.books.filter(b => b.userId === u.id && !b.deletedAt).sort((a,b) => b.updatedAt-a.updatedAt).map(b => ({...b, tags: Array.isArray(b.tags)?b.tags:[], stats: bookStats(d,b,u.id), fontFamily: storyFont(b.fontFamily)})),
      diaries: d.diaries.filter(x => x.userId === u.id && !x.deletedAt).sort((a,b) => b.updatedAt-a.updatedAt).map(x => publicDiary(x,d,u.id,false)),
      posts: d.posts.filter(x => x.userId === u.id && !x.deletedAt && !x.archivedAt).sort((a,b) => b.createdAt-a.createdAt).map(p => publicPost(p,d,u.id,false)),      archivedPosts: d.posts.filter(x => x.userId === u.id && !x.deletedAt && !!x.archivedAt).sort((a,b) => b.archivedAt-a.archivedAt).map(p => publicPost(p,d,u.id,false)),
      libraryBooks: d.libraries.filter(x => x.userId === u.id).map(x => { const b=lumoraIndex(d).booksById.get(x.bookId); return b && !b.deletedAt ? {...publicBookSummary(b,d,u.id,false),addedAt:x.createdAt} : null; }).filter(Boolean).sort((a,b)=>b.addedAt-a.addedAt),
      continueReading: d.readingProgress.filter(x=>x.userId===u.id).map(x => { const b=lumoraIndex(d).booksById.get(x.bookId); return b && !b.deletedAt ? {...publicBookSummary(b,d,u.id,false), chapterId:x.chapterId, pageNumber:x.pageNumber, progressUpdatedAt:x.updatedAt} : null; }).filter(Boolean).sort((a,b)=>(b.progressUpdatedAt||0)-(a.progressUpdatedAt||0)),
      favorites: d.favorites.filter(x=>x.userId===u.id).map(x => { const b=lumoraIndex(d).booksById.get(x.bookId); return b && !b.deletedAt ? {...publicBookSummary(b,d,u.id,false), favorited:true, favoritedAt:x.createdAt} : null; }).filter(Boolean).sort((a,b)=>(b.favoritedAt||0)-(a.favoritedAt||0)),      reposts: d.reposts.filter(x=>x.userId===u.id).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).map(x=>publicRepost(x,d,u.id,false)).filter(Boolean),
      social: socialSummary(d,u)
    });
  }

  if (req.method === 'GET' && p === '/api/feed') {
    // News Feed is Shared Thoughts only (the existing posts collection),
    // de-duplicated by the original post ID and sorted by persisted creation time.
    const posts = [...new Map(
      d.posts
        .filter(x => !x.archivedAt && !x.deletedAt && visibilityAllowed(d, x.visibility || 'private', x.userId, u))
        .map(x => [x.id, x])
    ).values()]
      .sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0) || String(b.id).localeCompare(String(a.id)))
      .map(x=>publicPost(x,d,u.id));
    return send(res, 200, { posts });
  }
  if (req.method === 'GET' && p === '/api/discover/books') {
    const q=searchable(url.searchParams.get('q'));
    const genre=String(url.searchParams.get('genre')||'');
    const tag=searchable(url.searchParams.get('tag'));
    const offset=Math.max(0,Number(url.searchParams.get('offset')||0));
    const limit=Math.min(20,Math.max(5,Number(url.searchParams.get('limit')||15)));
    const allowed=b=>b.visibility==='public'&&!b.deletedAt&&accountVisible(d,b.userId,u);
    const matches=b=>(!genre||b.genre===genre)&&(!tag||(b.tags||[]).some(t=>searchable(t)===tag))&&(!q||[b.title,b.description,b.genre,(b.tags||[]).join(' '),publicUser(d,b.userId).username,publicUser(d,b.userId).name].some(v=>searchable(v).includes(q)));
    const base=d.books.filter(b=>allowed(b)&&matches(b)).sort((a,b)=>b.updatedAt-a.updatedAt);
    const score=b=>{const st=bookStats(d,b,u.id);const age=Math.max(0,Date.now()-(b.updatedAt||b.createdAt||Date.now()));const freshness=Math.max(0,30-Math.floor(age/86400000));const queryBoost=q&&[b.title,b.description,b.genre,(b.tags||[]).join(' ')].some(v=>searchable(v).includes(q))?80:0;return st.reads*4+st.libraryAdds*3+st.favorites*3+freshness+queryBoost;};
    const recommendations=offset===0?[...base].sort((a,b)=>score(b)-score(a)||b.updatedAt-a.updatedAt).slice(0,12).map(b=>publicBook(b,d,u.id)):[];
    const books=base.slice(offset,offset+limit).map(b=>publicBook(b,d,u.id));
    return send(res,200,{books,recommendations,genres:GENRES,total:base.length,offset,limit,hasMore:offset+books.length<base.length,nextOffset:offset+books.length});
  }
  if (req.method === 'GET' && p === '/api/chika') {
    // Chika is intentionally diary-only. Keep the query server-side and apply
    // the same privacy rules used by the rest of Lumora.
    const diaries = [...new Map(
      d.diaries
        .filter(x => !x.deletedAt && visibilityAllowed(d, x.visibility || 'private', x.userId, u))
        .map(x => [x.id, x])
    ).values()]
      .sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0) || String(b.id).localeCompare(String(a.id)))
      .map(x=>publicDiary(x,d,u.id));
    return send(res, 200, { diaries });
  }

  if (req.method === 'GET' && p === '/api/search') {
    const q=searchable(url.searchParams.get('q')).trim();
    if(!q) return send(res,200,{books:[],people:[],diaries:[],posts:[]});
    const people=d.users
      .filter(x=>searchable(x.username).includes(q)||searchable(x.name).includes(q))
      .slice(0,20)
      .map(x=>{
        const visible=accountVisible(d,x.id,u);
        return {
          id:x.id,
          username:x.username,
          name:x.name,
          bio:visible?(x.bio||''):'',
          avatarUrl:visible?(x.avatarUrl||''):'',
          accountPrivacy:x.accountPrivacy||'public'
        };
      });
    const books=d.books.filter(b=>b.visibility==='public' && !b.deletedAt && accountVisible(d,b.userId,u)).filter(b=>[b.title,b.description,b.genre,(b.tags||[]).join(' '),publicUser(d,b.userId).username,publicUser(d,b.userId).name].some(v=>searchable(v).includes(q))).slice(0,30).map(b=>publicBookSummary(b,d));
    const diaries=d.diaries.filter(x=>!x.deletedAt && visibilityAllowed(d,x.visibility||'private',x.userId,u)).filter(x=>[x.title,x.content,x.mood,x.weather,x.season,publicUser(d,x.userId).username,publicUser(d,x.userId).name].some(v=>searchable(v).includes(q))).slice(0,30).map(x=>publicDiary(x,d,u.id));
    const posts=d.posts.filter(x=>!x.archivedAt && !x.deletedAt && visibilityAllowed(d,x.visibility||'private',x.userId,u)).filter(x=>[x.content,publicUser(d,x.userId).username,publicUser(d,x.userId).name].some(v=>searchable(v).includes(q))).slice(0,30).map(x=>publicPost(x,d,u.id));
    return send(res,200,{books,people,diaries,posts});
  }
  if (req.method === 'GET' && p === '/api/profile/check-username') {
    const u=requireUser(req,res); if(!u)return;
    const username=String(url.searchParams.get('username')||'').trim().toLowerCase();
    if(!/^[a-z0-9_]{3,25}$/.test(username))return send(res,200,{available:false,reason:'Username must be 3-25 characters using letters, numbers, or underscores.'});
    const taken=[...lumoraIndex(d).usersById.values()].some(item=>item.username===username&&item.id!==u.id);
    return send(res,200,{available:!taken,reason:taken?'Username already taken.':'Username available.'});
  }

  if (req.method === 'PUT' && p === '/api/profile/theme') {
    const u = requireUser(req, res); if (!u) return;
    const x = await body(req); const d = db();
    const current = d.users.find(user => user.id === u.id);
    if (!current) return send(res,404,{error:'Account not found.'});
    const theme = String(x.theme || '').trim().slice(0,60);
    if (!theme) return send(res,400,{error:'Theme is required.'});
    current.theme = theme;
    save(d); return send(res,200,{user:safeUser(current)});
  }

  if (req.method === 'PUT' && p === '/api/profile') {
    const u = requireUser(req, res); if (!u) return;
    const x = await body(req); const d = db();
    const current = d.users.find(user => user.id === u.id);
    if (!current) return send(res,404,{error:'Account not found.'});
    let username=current.username;
    if(x.username!==undefined){
      username=String(x.username||'').trim().toLowerCase();
      if(username!==current.username){
        if(!/^[a-z0-9_]{3,25}$/.test(username))return send(res,400,{error:'Username must be 3-25 characters using letters, numbers, or underscores.'});
        if(d.users.some(item=>item.username===username&&item.id!==current.id))return send(res,409,{error:'Username already taken.'});
        const currentPassword=String(x.currentPassword||'');
        if(!currentPassword||!verifyPassword(currentPassword,current.passwordHash))return send(res,401,{error:'Current password is required to change your username.'});
      }
    }
    const name = x.name === undefined ? current.name : String(x.name || '').trim().slice(0,80);
    const bio = x.bio === undefined ? (current.bio || '') : String(x.bio || '').trim().slice(0,500);
    const avatarUrl = x.avatarUrl === undefined ? (current.avatarUrl || '') : String(x.avatarUrl || '').trim().slice(0,5000000);
    const coverUrl = x.coverUrl === undefined ? (current.coverUrl || '') : String(x.coverUrl || '').trim().slice(0,5000000);
    const favoriteQuote = x.favoriteQuote === undefined ? (current.favoriteQuote || '') : String(x.favoriteQuote || '').trim().slice(0,300);
    const accountPrivacy = x.accountPrivacy === undefined ? (current.accountPrivacy || 'public') : (x.accountPrivacy === 'private' ? 'private' : 'public');
    const messagePermission = x.messagePermission === undefined ? (current.messagePermission || 'everyone') : (['everyone','followers','friends','none'].includes(x.messagePermission) ? x.messagePermission : (current.messagePermission || 'everyone'));
    const theme = x.theme === undefined ? (current.theme || 'Rose') : String(x.theme || current.theme || 'Rose').trim().slice(0,60);
    if (!name) return send(res,400,{error:'Display name is required.'});
    current.username=username; current.name=name; current.bio=bio; current.avatarUrl=avatarUrl; current.coverUrl=coverUrl; current.favoriteQuote=favoriteQuote; current.accountPrivacy=accountPrivacy; current.messagePermission=messagePermission; current.theme=theme;
    save(d); return send(res,200,{user:safeUser(current)});
  }

  if (req.method === 'GET' && p.startsWith('/api/users/')) {
    const userId=p.split('/').pop(); const profile=d.users.find(x=>x.id===userId);
    if(!profile) return send(res,404,{error:'User not found.'});
    const visible = accountVisible(d,userId,u);
    const incomingFollowRequest=d.followRequests.find(x=>x.fromId===userId&&x.toId===u.id&&x.status==='pending');
    const relationship = { following:isFollowing(d,u.id,userId), follower:isFollowing(d,userId,u.id), friends:areFriends(d,u.id,userId), pendingFollow:!!d.followRequests.find(x=>x.fromId===u.id&&x.toId===userId&&x.status==='pending'), pendingFriend:!!d.friendRequests.find(x=>x.fromId===u.id&&x.toId===userId&&x.status==='pending'), incomingFollowRequest:incomingFollowRequest?{id:incomingFollowRequest.id,from:publicUser(d,incomingFollowRequest.fromId),createdAt:incomingFollowRequest.createdAt}:null };
    const books=visible?d.books.filter(b=>b.userId===userId&&!b.deletedAt&&b.visibility==='public').sort((a,b)=>b.updatedAt-a.updatedAt).map(b=>publicBookSummary(b,d)):[];
    const diaries=visible?d.diaries.filter(x=>x.userId===userId&&!x.deletedAt&&visibilityAllowed(d,x.visibility||'private',x.userId,u)).sort((a,b)=>b.createdAt-a.createdAt).map(x=>publicDiary(x,d)):[];
    const posts=visible?d.posts.filter(x=>x.userId===userId&&!x.deletedAt&&visibilityAllowed(d,x.visibility||'private',x.userId,u)&&!x.archivedAt).sort((a,b)=>b.createdAt-a.createdAt).map(x=>publicPost(x,d)):[];    const reposts=visible?d.reposts.filter(x=>x.userId===userId).sort((a,b)=>b.createdAt-a.createdAt).map(x=>publicRepost(x,d,u.id)).filter(Boolean):[];
    return send(res,200,{user:{id:profile.id,username:profile.username,name:profile.name,bio:visible?profile.bio:'',avatarUrl:profile.avatarUrl||'',coverUrl:visible?(profile.coverUrl||''):'',favoriteQuote:visible?(profile.favoriteQuote||''):'',createdAt:profile.createdAt,accountPrivacy:profile.accountPrivacy||'public'},relationship,counts:socialCounts(d,userId),books,diaries,posts,reposts});
  }

  if (req.method === 'GET' && p.startsWith('/api/people/')) {
    const type=p.split('/').pop(); let ids=[];
    if(type==='followers') ids=d.follows.filter(x=>x.followingId===u.id).map(x=>x.followerId);
    else if(type==='following') ids=d.follows.filter(x=>x.followerId===u.id).map(x=>x.followingId);
    else if(type==='friends') ids=d.friendships.filter(x=>x.userA===u.id||x.userB===u.id).map(x=>x.userA===u.id?x.userB:x.userA);
    else return send(res,400,{error:'Unknown people list.'});
    return send(res,200,{type,people:ids.map(x=>publicUser(d,x))});
  }
  if (req.method === 'GET' && p === '/api/social') {
    return send(res,200,{...socialSummary(d,u),followRequests:d.followRequests.filter(x=>x.toId===u.id&&x.status==='pending').map(x=>({...x,from:publicUser(d,x.fromId)})),friendRequests:d.friendRequests.filter(x=>x.toId===u.id&&x.status==='pending').map(x=>({...x,from:publicUser(d,x.fromId)})),messageRequests:d.messageRequests.filter(x=>x.toId===u.id&&x.status==='pending').map(x=>({...x,from:publicUser(d,x.fromId),message:x.message}))});
  }
  if (req.method === 'POST' && p.startsWith('/api/follow/')) {
    const targetId=p.split('/').pop();
    if(targetId===u.id)return send(res,400,{error:'You cannot follow yourself.'});
    const target=d.users.find(x=>x.id===targetId);
    if(!target)return send(res,404,{error:'User not found.'});
    if(isFollowing(d,u.id,targetId)) return send(res,200,{following:true,pending:false,friends:areFriends(d,u.id,targetId)});
    const pending=d.followRequests.find(x=>x.fromId===u.id&&x.toId===targetId&&x.status==='pending');
    if(target.accountPrivacy==='private'){
      if(!pending) { d.followRequests.push({id:id(),fromId:u.id,toId:targetId,status:'pending',createdAt:Date.now()}); notify(d,targetId,'follow_request',u.id,`${u.name || '@'+u.username} wants to follow you.`,'user',u.id); }
    }else{
      d.followRequests=d.followRequests.filter(x=>!(x.fromId===u.id&&x.toId===targetId&&x.status==='pending'));
      d.follows.push({id:id(),followerId:u.id,followingId:targetId,createdAt:Date.now()});
      syncMutualFriendship(d,u.id,targetId);
      notify(d,targetId,'follow',u.id,`${u.name || '@'+u.username} followed you.`,'user',u.id);
    }
    save(d);
    return send(res,200,{following:isFollowing(d,u.id,targetId),pending:!!d.followRequests.find(x=>x.fromId===u.id&&x.toId===targetId&&x.status==='pending'),friends:areFriends(d,u.id,targetId)});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/follow/')) {
    const targetId=p.split('/').pop();
    d.follows=d.follows.filter(x=>!(x.followerId===u.id&&x.followingId===targetId));
    d.followRequests=d.followRequests.filter(x=>!(x.fromId===u.id&&x.toId===targetId));
    syncFriendshipsFromFollows(d);
    save(d);
    return send(res,200,{ok:true,following:false,pending:false,friends:areFriends(d,u.id,targetId)});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/followers/')) {
    const followerId=p.split('/').pop();
    if(followerId===u.id)return send(res,400,{error:'You cannot remove yourself as a follower.'});
    const target=d.follows.find(x=>x.followerId===followerId&&x.followingId===u.id);
    if(!target)return send(res,404,{error:'Follower not found.'});
    d.follows=d.follows.filter(x=>!(x.followerId===followerId&&x.followingId===u.id));
    syncFriendshipsFromFollows(d);
    save(d);
    return send(res,200,{ok:true,removed:true});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/follow-requests/')) {
    const targetId=p.split('/').pop();
    const before=d.followRequests.length;
    d.followRequests=d.followRequests.filter(x=>!(x.fromId===u.id&&x.toId===targetId&&x.status==='pending'));
    if(d.followRequests.length===before)return send(res,404,{error:'Follow request not found.'});
    save(d);
    return send(res,200,{ok:true,cancelled:true});
  }
  if (req.method === 'POST' && p.startsWith('/api/follow-requests/') && p.endsWith('/accept')) { const rid=p.split('/')[3]; const r=d.followRequests.find(x=>x.id===rid&&x.toId===u.id&&x.status==='pending'); if(!r)return send(res,404,{error:'Follow request not found.'}); r.status='accepted'; d.notifications=d.notifications.filter(n=>!(n.userId===u.id&&n.type==='follow_request'&&n.actorId===r.fromId&&n.targetType==='user'&&n.targetId===r.fromId)); if(!isFollowing(d,r.fromId,u.id)){d.follows.push({id:id(),followerId:r.fromId,followingId:u.id,createdAt:Date.now()}); notify(d,r.fromId,'follow',u.id,`${u.name || '@'+u.username} accepted your follow request.`,'user',u.id);} syncMutualFriendship(d,r.fromId,u.id); save(d); return send(res,200,{ok:true,friends:areFriends(d,r.fromId,u.id),counts:socialCounts(d,u.id)}); }
  if (req.method === 'POST' && p.startsWith('/api/follow-requests/') && p.endsWith('/decline')) { const rid=p.split('/')[3]; const r=d.followRequests.find(x=>x.id===rid&&x.toId===u.id&&x.status==='pending'); if(!r)return send(res,404,{error:'Follow request not found.'}); r.status='declined'; d.notifications=d.notifications.filter(n=>!(n.userId===u.id&&n.type==='follow_request'&&n.actorId===r.fromId&&n.targetType==='user'&&n.targetId===r.fromId)); save(d); return send(res,200,{ok:true,counts:socialCounts(d,u.id)}); }
  if (req.method === 'GET' && p === '/api/messages') {
    const byUser=new Map();
    for(const m of d.messages){
      const otherId=m.fromId===u.id?m.toId:m.toId===u.id?m.fromId:null;if(!otherId)continue;
      let entry=byUser.get(otherId);
      if(!entry){entry={lastMessage:m,unreadCount:0};byUser.set(otherId,entry);}
      else if(Number(m.createdAt||0)>Number(entry.lastMessage.createdAt||0))entry.lastMessage=m;
      if(m.fromId===otherId&&m.toId===u.id&&!m.readAt)entry.unreadCount++;
    }
    const conversations=[...byUser.entries()].sort((a,b)=>Number(b[1].lastMessage.createdAt||0)-Number(a[1].lastMessage.createdAt||0)).map(([otherId,entry])=>({user:publicUser(d,otherId),lastMessage:entry.lastMessage,unreadCount:entry.unreadCount}));
    return send(res,200,{conversations});
  }
  if (req.method === 'GET' && p.startsWith('/api/messages/')) { const otherId=p.split('/').pop(); const other=lumoraIndex(d).usersById.get(otherId); if(!other)return send(res,404,{error:'User not found.'}); if(messageRequestDeclined(d,u.id,otherId))return send(res,403,{error:"You can't message this person",code:'MESSAGE_BLOCKED'}); const pair=undirectedKey(u.id,otherId),messages=[...(lumoraIndex(d).messagesByPair.get(pair)||[])].sort((a,b)=>a.createdAt-b.createdAt); const existingConversation=messages.length>0; const allowed=messagingAllowed(d,u,other)||existingConversation; if(!allowed)return send(res,403,{error:'Messaging is not open between you yet. Send a message request instead.',code:'MESSAGE_REQUEST_REQUIRED'}); let changed=false; for(const m of messages){if(m.toId===u.id&&!m.readAt){m.readAt=Date.now();changed=true;}} if(changed)save(d); return send(res,200,{messages:messages.map(x=>({...x,from:publicUser(d,x.fromId)})),user:publicUser(d,otherId)}); }
  if (req.method === 'POST' && p.startsWith('/api/messages/')) { const otherId=p.split('/').pop(); const other=d.users.find(x=>x.id===otherId); if(!other)return send(res,404,{error:'User not found.'}); const x=await body(req); const content=String(x.content||'').trim().slice(0,3000); const clientMessageId=String(x.clientMessageId||'').trim().slice(0,120); if(!content)return send(res,400,{error:'Message cannot be empty.'}); if(messageRequestDeclined(d,u.id,otherId))return send(res,403,{error:"You can't message this person",code:'MESSAGE_BLOCKED'}); if(clientMessageId){const duplicate=d.messages.find(m=>m.fromId===u.id&&m.toId===otherId&&m.clientMessageId===clientMessageId);if(duplicate)return send(res,200,{message:{...duplicate,from:publicUser(d,u.id)},request:false,duplicate:true});} const existingConversation=d.messages.some(m=>(m.fromId===u.id&&m.toId===otherId)||(m.fromId===otherId&&m.toId===u.id)); if(messagingAllowed(d,u,other)||existingConversation){const m={id:id(),fromId:u.id,toId:otherId,content,clientMessageId:clientMessageId||null,createdAt:Date.now(),readAt:null};d.messages.push(m);notify(d,otherId,'message',u.id,(u.name||'@'+u.username)+' sent you a message.','user',u.id);save(d);return send(res,201,{message:{...m,from:publicUser(d,u.id)},request:false});} if(!messageRequestAllowed(d,u,other))return send(res,403,{error:'You are not allowed to message this private account.',code:'MESSAGE_PRIVATE_BLOCKED'}); const duplicateRequest=clientMessageId&&d.messageRequests.find(r=>r.fromId===u.id&&r.toId===otherId&&r.clientMessageId===clientMessageId&&r.status==='pending'); if(duplicateRequest)return send(res,200,{request:true,messageRequest:duplicateRequest,duplicate:true}); const mr={id:id(),fromId:u.id,toId:otherId,message:content,clientMessageId:clientMessageId||null,status:'pending',createdAt:Date.now()}; d.messageRequests.push(mr); notify(d,otherId,'message',u.id,u.name||'@'+u.username+' sent you a message request.','user',u.id); save(d); return send(res,201,{request:true,messageRequest:{...mr,from:publicUser(d,u.id)}}); }
  if (req.method === 'POST' && p.startsWith('/api/message-requests/') && p.endsWith('/accept')) { const rid=p.split('/')[3]; const r=d.messageRequests.find(x=>x.id===rid&&x.toId===u.id&&x.status==='pending'); if(!r)return send(res,404,{error:'Message request not found.'}); r.status='accepted'; if(!d.messages.some(m=>m.fromId===r.fromId&&m.toId===u.id&&r.clientMessageId&&m.clientMessageId===r.clientMessageId))d.messages.push({id:id(),fromId:r.fromId,toId:u.id,content:r.message,clientMessageId:r.clientMessageId||null,createdAt:r.createdAt,readAt:null}); save(d); return send(res,200,{ok:true,conversationWith:r.fromId}); }
  if (req.method === 'POST' && p.startsWith('/api/message-requests/') && p.endsWith('/decline')) { const rid=p.split('/')[3]; const r=d.messageRequests.find(x=>x.id===rid&&x.toId===u.id&&x.status==='pending'); if(!r)return send(res,404,{error:'Message request not found.'}); r.status='declined'; d.notifications=d.notifications.filter(n=>!(n.userId===u.id&&n.type==='message'&&n.actorId===r.fromId&&n.targetType==='user'&&n.targetId===r.fromId)); save(d); return send(res,200,{ok:true,blockedUserId:r.fromId}); }


  if (req.method === 'GET' && p === '/api/notifications') {
    const items=d.notifications.filter(n=>n.userId===u.id).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100).map(n=>{const item={...n,actor:publicUser(d,n.actorId)};if(n.targetType==='chapter'){const bid=lumoraIndex(d).chapterToBook.get(n.targetId);if(bid)item.bookId=bid;}return item;});
    return send(res,200,{notifications:items,unread:items.filter(n=>!n.readAt).length});
  }
  if (req.method === 'POST' && p === '/api/notifications/read-all') {
    const now=Date.now(); d.notifications.forEach(n=>{if(n.userId===u.id&&!n.readAt)n.readAt=now;}); save(d); return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && p.startsWith('/api/notifications/')) {
    const nid=p.split('/').pop(); const n=d.notifications.find(x=>x.id===nid&&x.userId===u.id); if(!n)return send(res,404,{error:'Notification not found.'}); n.readAt=Date.now(); save(d); return send(res,200,{ok:true,notification:n});
  }

  if (req.method === 'GET' && p.startsWith('/api/posts/')) {
    const post = d.posts.find(x => x.id === p.split('/').pop()&&!x.deletedAt);
    if (!post || (post.archivedAt && post.userId !== u.id) || !visibilityAllowed(d, post.visibility || 'private', post.userId, u)) return send(res,404,{error:'Post not found.'});
    return send(res,200,{post:publicPost(post,d,u.id),comments:d.comments.filter(c=>c.targetType==='post'&&c.targetId===post.id).sort((a,b)=>a.createdAt-b.createdAt).map(c=>({...c,author:publicUser(d,c.userId)}))});
  }
  if (req.method === 'PUT' && p.startsWith('/api/posts/')) {
    const post = d.posts.find(x => x.id === p.split('/').pop() && x.userId === u.id && !x.deletedAt);
    if (!post) return send(res,404,{error:'Post not found.'});
    const x = await body(req);
    if (x.content !== undefined) { post.content = String(x.content).slice(0,10000); post.mentionUserIds = extractMentionUserIds(d,post.content); notifyMentions(d,u,post.mentionUserIds,'post',post.id,'mentioned you in a post'); }
    if (x.visibility !== undefined) post.visibility = ['public','followers','friends','private'].includes(x.visibility) ? x.visibility : 'private';
    if (post.visibility === 'public') delete post.archivedAt; else delete post.archivedAt;
    post.updatedAt = Date.now(); save(d); return send(res,200,{post:publicPost(post,d)});
  }
  if (req.method === 'POST' && p === '/api/posts') {
    const x = await body(req);
    const visibility = ['public','followers','friends','private'].includes(x.visibility) ? x.visibility : 'private';
    const content=String(x.content||'').slice(0,10000); const post={id:id(),userId:u.id,content,mentionUserIds:extractMentionUserIds(d,content),visibility,createdAt:Date.now(),updatedAt:Date.now(),archivedAt:null};
    d.posts.push(post); notifyMentions(d,u,post.mentionUserIds,'post',post.id,'mentioned you in a post'); save(d); return send(res,201,{post:publicPost(post,d,u.id)});
  }

  if (req.method === 'GET' && p.startsWith('/api/diaries/')) {
    const diary = d.diaries.find(x=>x.id===p.split('/').pop()&&!x.deletedAt);
    if (!diary || !visibilityAllowed(d, diary.visibility || 'private', diary.userId, u)) return send(res,404,{error:'Diary not found.'});
    return send(res,200,{diary:publicDiary(diary,d,u.id),comments:d.comments.filter(c=>c.targetType==='diary'&&c.targetId===diary.id).sort((a,b)=>a.createdAt-b.createdAt).map(c=>({...c,author:publicUser(d,c.userId)}))});
  }
  if (req.method === 'POST' && p === '/api/diaries') {
    const x = await body(req);
    const a = {id:id(),userId:u.id,title:String(x.title||'Untitled Entry'),date:x.date||new Date().toISOString().slice(0,10),content:String(x.content||''),mood:String(x.mood||''),weather:String(x.weather||''),season:String(x.season||''),imageUrl:String(x.imageUrl||'').slice(0,5000000),visibility:['public','followers','friends','private'].includes(x.visibility)?x.visibility:'private',createdAt:Date.now(),updatedAt:Date.now()};
    d.diaries.push(a); save(d); return send(res,201,{diary:a});
  }
  if (req.method === 'PUT' && p.startsWith('/api/diaries/')) {
    const a=d.diaries.find(x=>x.id===p.split('/').pop()&&x.userId===u.id&&!x.deletedAt);
    if(!a)return send(res,404,{error:'Diary not found.'});
    const x=await body(req);
    Object.assign(a,{title:x.title!==undefined?String(x.title):a.title,content:x.content!==undefined?String(x.content):a.content,mood:x.mood!==undefined?String(x.mood):a.mood,weather:x.weather!==undefined?String(x.weather):a.weather,season:x.season!==undefined?String(x.season):a.season,imageUrl:x.imageUrl!==undefined?String(x.imageUrl).slice(0,5000000):(a.imageUrl||''),visibility:x.visibility!==undefined?(['public','followers','friends','private'].includes(x.visibility)?x.visibility:'private'):a.visibility,date:x.date||a.date,updatedAt:Date.now()});
    save(d);return send(res,200,{diary:a});
  }


  if (req.method === 'GET' && p === '/api/trash') {
    const map=(type,arr)=>arr.filter(x=>x.userId===u.id&&x.deletedAt).map(x=>({id:x.id,type,title:type==='books'?(x.title||'Untitled Book'):type==='diaries'?(x.title||'Untitled Diary'):(x.content||'Untitled Thought').slice(0,90),deletedAt:x.deletedAt,deletedUntil:x.deletedUntil}));
    return send(res,200,{items:[...map('books',d.books),...map('diaries',d.diaries),...map('posts',d.posts)].sort((a,b)=>b.deletedAt-a.deletedAt)});
  }
  if (req.method === 'POST' && p.startsWith('/api/trash/') && p.endsWith('/restore')) {
    const parts=p.split('/').filter(Boolean), type=parts[2], itemId=parts[3]; const arr={books:d.books,diaries:d.diaries,posts:d.posts}[type]; if(!arr)return send(res,400,{error:'Unknown trash type.'}); const item=arr.find(x=>x.id===itemId&&x.userId===u.id&&x.deletedAt); if(!item)return send(res,404,{error:'Trash item not found.'}); delete item.deletedAt; delete item.deletedUntil; item.updatedAt=Date.now(); save(d); return send(res,200,{ok:true});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/trash/')) {
    const parts=p.split('/').filter(Boolean), type=parts[2], itemId=parts[3]; const arr={books:d.books,diaries:d.diaries,posts:d.posts}[type]; if(!arr)return send(res,400,{error:'Unknown trash type.'}); const item=arr.find(x=>x.id===itemId&&x.userId===u.id&&x.deletedAt); if(!item)return send(res,404,{error:'Trash item not found.'});
    if(type==='books'){const chapterIds=(item.chapters||[]).map(c=>c.id);d.comments=d.comments.filter(c=>!(c.targetType==='chapter'&&chapterIds.includes(c.targetId)));d.highlights=d.highlights.filter(h=>!chapterIds.includes(h.chapterId));d.bookmarks=d.bookmarks.filter(b=>!chapterIds.includes(b.chapterId));d.libraries=d.libraries.filter(l=>l.bookId!==item.id);}
    else d.comments=d.comments.filter(c=>!(c.targetType===(type==='posts'?'post':'diary')&&c.targetId===item.id));
    d.notifications=d.notifications.filter(n=>!(n.targetType===(type==='posts'?'post':type==='diaries'?'diary':'book')&&n.targetId===item.id));
    arr.splice(arr.indexOf(item),1);save(d);return send(res,200,{ok:true});
  }


  if (req.method === 'DELETE' && p.startsWith('/api/posts/')) {
    const item=d.posts.find(x=>x.id===p.split('/').pop()&&x.userId===u.id&&!x.deletedAt&&!x.deletedAt); if(!item)return send(res,404,{error:'Post not found.'}); markTrash(item); save(d); return send(res,200,{ok:true,deletedUntil:item.deletedUntil});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/diaries/')) {
    const item=d.diaries.find(x=>x.id===p.split('/').pop()&&x.userId===u.id&&!x.deletedAt&&!x.deletedAt); if(!item)return send(res,404,{error:'Diary not found.'}); markTrash(item); save(d); return send(res,200,{ok:true,deletedUntil:item.deletedUntil});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/books/')) {
    const item=d.books.find(x=>x.id===p.split('/').pop()&&x.userId===u.id&&!x.deletedAt&&!x.deletedAt); if(!item)return send(res,404,{error:'Book not found.'}); markTrash(item); save(d); return send(res,200,{ok:true,deletedUntil:item.deletedUntil});
  }

  if (req.method === 'POST' && p === '/api/comments') {
    const x=await body(req); const targetType=['post','diary','chapter'].includes(x.targetType)?x.targetType:''; const targetId=String(x.targetId||''); const target=targetAllowed(d,targetType,targetId,u); if(!target)return send(res,404,{error:'This content is not available for commenting.'});
    const parentId=String(x.parentId||'')||null; if(parentId&&!d.comments.some(c=>c.id===parentId&&c.targetType===targetType&&c.targetId===targetId))return send(res,400,{error:'The comment you are replying to no longer exists.'});
    const content=String(x.content||'').trim().slice(0,2000); if(!content)return send(res,400,{error:'Comment cannot be empty.'});
    const c={id:id(),userId:u.id,targetType,targetId,parentId,content,mentionUserIds:extractMentionUserIds(d,content),createdAt:Date.now()}; d.comments.push(c);
    if(targetType==='post'||targetType==='diary')notify(d,target.userId,parentId?'reply':'comment',u.id,parentId?(u.name||'@'+u.username)+' replied to your comment.':(u.name||'@'+u.username)+' commented on your '+targetType+'.',targetType,targetId);
    if(parentId){const parent=d.comments.find(item=>item.id===parentId);if(parent)notify(d,parent.userId,'reply',u.id,(u.name||'@'+u.username)+' replied to your comment.',targetType,targetId);}
    const subscriberIds=new Set(d.comments.filter(item=>item.targetType===targetType&&item.targetId===targetId&&item.userId!==u.id).map(item=>item.userId));
    if(parentId){const parent=d.comments.find(item=>item.id===parentId);if(parent)subscriberIds.delete(parent.userId);}
    for(const recipientId of subscriberIds)notify(d,recipientId,'comment_activity',u.id,(u.name||'@'+u.username)+' commented on a '+targetType+' you also commented on.',targetType,targetId);
    notifyMentions(d,u,c.mentionUserIds,targetType,targetId,'mentioned you in a comment'); save(d); return send(res,201,{comment:publicComment(c,d)});
  }

  if (req.method === 'GET' && p === '/api/comments') {
    const type=url.searchParams.get('targetType');const targetId=url.searchParams.get('targetId'); if(!targetAllowed(d,type,targetId,u))return send(res,404,{error:'Content not found.'});
    return send(res,200,{comments:d.comments.filter(c=>c.targetType===type&&c.targetId===targetId).sort((a,b)=>a.createdAt-b.createdAt).map(c=>publicComment(c,d))});
  }

  if (req.method === 'PUT' && p.startsWith('/api/reading-progress/')) {
    const bookId=p.split('/').pop(); const b=d.books.find(x=>x.id===bookId&&!x.deletedAt);
    if(!b || (b.userId!==u.id && b.visibility!=='public')) return send(res,404,{error:'Book not found.'});
    const x=await body(req); const chapterId=String(x.chapterId||''); const chapter=b.chapters.find(c=>c.id===chapterId);
    if(!chapter)return send(res,404,{error:'Chapter not found.'});
    const scrollTop=Math.max(0,Number(x.scrollTop||0)); let rp=d.readingProgress.find(v=>v.userId===u.id&&v.bookId===bookId);
    if(rp){rp.chapterId=chapterId;rp.pageNumber=b.chapters.findIndex(c=>c.id===chapterId)+1;rp.scrollTop=scrollTop;rp.updatedAt=Date.now();}
    else{rp={id:id(),userId:u.id,bookId,chapterId,pageNumber:b.chapters.findIndex(c=>c.id===chapterId)+1,scrollTop,updatedAt:Date.now(),createdAt:Date.now()};d.readingProgress.push(rp);}
    save(d); return send(res,200,{ok:true,readingProgress:rp});
  }

  if (req.method === 'GET' && p.startsWith('/api/books/') && p.endsWith('/stats')) {
    const bookId=p.split('/')[3]; const b=d.books.find(x=>x.id===bookId&&!x.deletedAt);
    if(!b || (b.userId!==u.id && (b.visibility!=='public' || !accountVisible(d,b.userId,u)))) return send(res,404,{error:'Book not found.'});
    return send(res,200,{stats:bookStats(d,b,u.id),chapters:b.chapters.map(c=>({id:c.id,title:c.title,readCount:chapterReadCount(d,c.id)}))});
  }

  if (req.method === 'GET' && p.startsWith('/api/books/')) {
    const parts=p.split('/').filter(Boolean); const bookId=parts[2]; const chapterId=parts[4];
    const b=d.books.find(x=>x.id===bookId&&!x.deletedAt);
    if(!b || (b.userId!==u.id && !accountVisible(d,b.userId,u) && b.visibility!=='public') || (b.userId!==u.id && b.visibility!=='public'))return send(res,404,{error:'Book not found.'});
    if(chapterId){
      const c=b.chapters.find(x=>x.id===chapterId);if(!c)return send(res,404,{error:'Chapter not found.'});
      const pageNumber=b.chapters.findIndex(x=>x.id===chapterId)+1;
      const rp=d.readingProgress.find(x=>x.userId===u.id&&x.bookId===bookId);
      if(rp){if(rp.chapterId!==chapterId){rp.chapterId=chapterId;rp.pageNumber=pageNumber;rp.scrollTop=0;}rp.updatedAt=Date.now();} else d.readingProgress.push({id:id(),userId:u.id,bookId,chapterId,pageNumber,scrollTop:0,updatedAt:Date.now(),createdAt:Date.now()});
      if(!d.bookReads.some(x=>x.userId===u.id&&x.bookId===bookId)) d.bookReads.push({id:id(),userId:u.id,bookId,createdAt:Date.now()});
      if(!d.chapterReads.some(x=>x.userId===u.id&&x.bookId===bookId&&x.chapterId===chapterId)) d.chapterReads.push({id:id(),userId:u.id,bookId,chapterId,createdAt:Date.now()});
      save(d);
      return send(res,200,{book:publicBook(b,d,u.id),chapter:publicChapter(c),pageNumber,scrollTop:Math.max(0,Number(rp?.scrollTop||0)),comments:d.comments.filter(x=>x.targetType==='chapter'&&x.targetId===c.id).sort((a,b)=>a.createdAt-b.createdAt).map(c=>({...c,author:publicUser(d,c.userId)})),highlights:d.highlights.filter(x=>x.userId===u.id&&x.chapterId===c.id),bookmark:d.bookmarks.find(x=>x.userId===u.id&&x.chapterId===c.id)||null});
    }
    if(!d.bookReads.some(x=>x.userId===u.id&&x.bookId===bookId)) { d.bookReads.push({id:id(),userId:u.id,bookId,createdAt:Date.now()}); save(d); }
    return send(res,200,{book:publicBook(b,d,u.id)});
  }
  if (req.method === 'POST' && p === '/api/books') {
    const x=await body(req);
    const chapters=Array.isArray(x.chapters)&&x.chapters.length?x.chapters.map(c=>({id:c.id||id(),title:String(c.title||''),content:String(c.content||''),contentHtml:sanitizeStoryHtml(c.contentHtml||'')})):[{id:id(),title:'',content:'',contentHtml:''}];
    const b={id:id(),userId:u.id,title:String(x.title||'Untitled Book').slice(0,120),description:String(x.description||''),cover:String(x.cover||'').slice(0,5000000),genre:GENRES.includes(String(x.genre||''))?String(x.genre):'',tags:cleanTags(x.tags),visibility:x.visibility==='public'?'public':'private',fontFamily:storyFont(x.fontFamily),chapters,readingCount:0,createdAt:Date.now(),updatedAt:Date.now()};
    d.books.push(b);save(d);return send(res,201,{book:b});
  }
  if (req.method === 'PUT' && p.startsWith('/api/books/')) {
    const b=d.books.find(x=>x.id===p.split('/').pop()&&x.userId===u.id&&!x.deletedAt);if(!b)return send(res,404,{error:'Book not found.'});
    const x=await body(req);
    const previous=new Map((b.chapters||[]).map(c=>[c.id,{title:c.title||'',content:c.content||'',contentHtml:c.contentHtml||''}]));
    const chapters=Array.isArray(x.chapters)?x.chapters.map(c=>({id:c.id||id(),title:String(c.title||''),content:String(c.content||''),contentHtml:sanitizeStoryHtml(c.contentHtml||'')})):b.chapters;
    Object.assign(b,{title:x.title!==undefined?String(x.title):b.title,description:x.description!==undefined?String(x.description):b.description,cover:x.cover!==undefined?String(x.cover).slice(0,5000000):b.cover,genre:x.genre!==undefined?(GENRES.includes(String(x.genre))?String(x.genre):''):b.genre,tags:x.tags!==undefined?cleanTags(x.tags):Array.isArray(b.tags)?b.tags:[],visibility:x.visibility==='public'?'public':x.visibility==='private'?'private':b.visibility,fontFamily:x.fontFamily!==undefined?storyFont(x.fontFamily):storyFont(b.fontFamily),chapters,updatedAt:Date.now()});
    for(const chapter of chapters){const before=previous.get(chapter.id);const changed=!before||before.title!==chapter.title||before.content!==chapter.content||before.contentHtml!==chapter.contentHtml;if(changed)notifyBookChapterUpdate(d,b,chapter,u.id);}
    save(d);return send(res,200,{book:b});
  }


  if (req.method === 'GET' && p === '/api/library') {
    const entries=d.libraries.filter(x=>x.userId===u.id).map(x=>{const b=lumoraIndex(d).booksById.get(x.bookId); return b&&!b.deletedAt?{...publicBookSummary(b,d,u.id),addedAt:x.createdAt}:null}).filter(Boolean).sort((a,b)=>b.addedAt-a.addedAt);
    return send(res,200,{books:entries});
  }
  if (req.method === 'POST' && p.startsWith('/api/library/')) {
    const bookId=p.split('/').pop(); const b=d.books.find(x=>x.id===bookId&&!x.deletedAt);
    if(!b || b.visibility!=='public' || !accountVisible(d,b.userId,u)) return send(res,404,{error:'Book not found.'});
    if(b.userId===u.id) return send(res,400,{error:'You already own this book.'});
    if(!d.libraries.some(x=>x.userId===u.id&&x.bookId===bookId)) {
      d.libraries.push({id:id(),userId:u.id,bookId,createdAt:Date.now()});
      notify(d,b.userId,'library',u.id,`${u.name || '@'+u.username} added your book “${b.title}” to their library.`,'book',bookId);
      save(d);
    }
    return send(res,200,{ok:true,added:true});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/library/')) {
    const bookId=p.split('/').pop(); d.libraries=d.libraries.filter(x=>!(x.userId===u.id&&x.bookId===bookId)); save(d); return send(res,200,{ok:true});
  }


  if ((req.method==='POST'||req.method==='DELETE')&&p.startsWith('/api/likes/')) {
    const parts=p.split('/').filter(Boolean),targetType=parts[2],targetId=parts[3]; if(!['post','diary'].includes(targetType))return send(res,400,{error:'Unsupported like target.'});
    const arr=targetType==='post'?d.posts:d.diaries; const target=arr.find(x=>x.id===targetId&&!x.deletedAt); if(!target||!visibilityAllowed(d,target.visibility||'private',target.userId,u))return send(res,404,{error:'Content not found.'});
    const existing=d.likes.find(x=>x.userId===u.id&&x.targetType===targetType&&x.targetId===targetId);
    if(req.method==='POST'){if(!existing){d.likes.push({id:id(),userId:u.id,targetType,targetId,createdAt:Date.now()});notify(d,target.userId,'like',u.id,(u.name||'@'+u.username)+' liked your '+targetType+'.',targetType,targetId);save(d);}}
    else if(existing){d.likes=d.likes.filter(x=>x.id!==existing.id);save(d);}
    return send(res,200,{ok:true,liked:d.likes.some(x=>x.userId===u.id&&x.targetType===targetType&&x.targetId===targetId),likesCount:d.likes.filter(x=>x.targetType===targetType&&x.targetId===targetId).length});
  }

  if (req.method === 'POST' && p.startsWith('/api/reposts/')) { const postId=p.split('/').pop(); const post=d.posts.find(x=>x.id===postId&&!x.deletedAt&&x.visibility==='public'); if(!post)return send(res,404,{error:'Public post not found.'}); let repost=d.reposts.find(x=>x.userId===u.id&&x.postId===postId); if(!repost){repost={id:id(),userId:u.id,postId,createdAt:Date.now()};d.reposts.push(repost);if(post.userId!==u.id)notify(d,post.userId,'repost',u.id,(u.name||'@'+u.username)+' reposted your post.','post',postId);save(d);} return send(res,200,{ok:true,reposted:true,repost:publicRepost(repost,d,u.id)}); }
  if (req.method === 'DELETE' && p.startsWith('/api/reposts/')) { const postId=p.split('/').pop();d.reposts=d.reposts.filter(x=>!(x.userId===u.id&&x.postId===postId));save(d);return send(res,200,{ok:true,reposted:false}); }
  if (req.method === 'POST' && p.startsWith('/api/favorites/')) {
    const bookId=p.split('/').pop(); const b=d.books.find(x=>x.id===bookId&&!x.deletedAt);
    if(!b || b.visibility!=='public' || !accountVisible(d,b.userId,u)) return send(res,404,{error:'Book not found.'});
    if(!d.favorites.some(x=>x.userId===u.id&&x.bookId===bookId)){ d.favorites.push({id:id(),userId:u.id,bookId,createdAt:Date.now()}); save(d); }
    return send(res,200,{ok:true,favorited:true,stats:bookStats(d,b,u.id)});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/favorites/')) {
    const bookId=p.split('/').pop(); d.favorites=d.favorites.filter(x=>!(x.userId===u.id&&x.bookId===bookId)); save(d); const b=d.books.find(x=>x.id===bookId&&!x.deletedAt); return send(res,200,{ok:true,favorited:false,stats:b?bookStats(d,b,u.id):{reads:0,libraryAdds:0,favorites:0,favorited:false}});
  }

  if (req.method === 'POST' && p === '/api/highlights') {
    const x=await body(req);
    const target=targetAllowed(d,'chapter',x.chapterId,u);if(!target)return send(res,404,{error:'Chapter not found.'});
    const rawText=String(x.text||'').slice(0,1000); const chapterText=String(target.content||''); const start=x.start===undefined?chapterText.indexOf(rawText):Number(x.start); const end=x.end===undefined?(start>=0?start+rawText.length:null):Number(x.end); if(!rawText.trim() || start===null || start<0 || end<=start || end>chapterText.length) return send(res,400,{error:'Please select text from the chapter to highlight.'}); const h={id:id(),userId:u.id,chapterId:String(x.chapterId),text:rawText,note:String(x.note||'').slice(0,2000),start,end,createdAt:Date.now()};
    d.highlights.push(h);save(d);return send(res,201,{highlight:h});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/highlights/')) {
    const h=d.highlights.find(x=>x.id===p.split('/').pop()&&x.userId===u.id&&!x.deletedAt);if(!h)return send(res,404,{error:'Highlight not found.'});
    d.highlights=d.highlights.filter(x=>x.id!==h.id);save(d);return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && p === '/api/bookmarks') {
    const x=await body(req);const target=targetAllowed(d,'chapter',x.chapterId,u);if(!target)return send(res,404,{error:'Chapter not found.'});
    d.bookmarks=d.bookmarks.filter(b=>!(b.userId===u.id&&b.chapterId===x.chapterId));
    const b={id:id(),userId:u.id,chapterId:String(x.chapterId),position:x.position===undefined?0:Number(x.position),createdAt:Date.now()};
    d.bookmarks.push(b);save(d);return send(res,201,{bookmark:b});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/bookmarks/')) {
    const bid=p.split('/').pop();const b=d.bookmarks.find(x=>x.id===bid&&x.userId===u.id);if(!b)return send(res,404,{error:'Bookmark not found.'});
    d.bookmarks=d.bookmarks.filter(x=>x.id!==bid);save(d);return send(res,200,{ok:true});
  }

  return send(res,404,{error:'API route not found.'});
}

async function startServer() {
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.url === '/api/health') {
        return send(res, databaseReady ? 200 : 503, {
          ok: databaseReady,
          databaseReady,
          error: databaseInitError ? 'Database initialization is not ready.' : null
        });
      }
      if(req.url.startsWith('/api/')) {
        try {
          if(databaseInitPromise) await databaseInitPromise;
        } catch (e) {
          return send(res,503,{error:'Lumora is still starting. Please try again in a moment.',code:'STARTUP_DATABASE_UNAVAILABLE'});
        }
        return await api(req,res);
      }
      const pageUrl = new URL(req.url,`http://${req.headers.host}`);
      if(pageUrl.pathname === '/verify-email') return handleEmailVerificationLink(req, res, pageUrl);
      if(pageUrl.pathname === '/reset-password') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(passwordResetPage(pageUrl.searchParams.get('token') || '')); }
      const pathname=decodeURIComponent(pageUrl.pathname);
      const file=pathname==='/'?path.join(PUBLIC,'index.html'):path.join(PUBLIC,pathname);
      if(!file.startsWith(PUBLIC))return send(res,403,{error:'Forbidden'});
      if(!fs.existsSync(file)||fs.statSync(file).isDirectory())return send(res,404,{error:'Not found'});
      const ext=path.extname(file);const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
      res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream', ...(ext === '.html' ? {'Cache-Control':'no-store'} : {})});fs.createReadStream(file).pipe(res);
    }catch(e){console.error(e);send(res,500,{error:'Server error.'});}
  });
  server.listen(PORT,()=>console.log(`Lumora running at http://localhost:${PORT}`));

  databaseInitPromise=(async()=>{
    try {
      await initRemoteDatabase();

      // Mark the database ready as soon as the persistent state is loaded.
      // Maintenance sweeps must never hold the whole app on the startup screen.
      databaseReady=true;
      console.log('Lumora database ready.');

      // Run non-essential maintenance after the app is available.
      setImmediate(()=>{
        try { cleanSocial(db()); } catch (e) { console.error('Initial social normalization failed:', e.message); }
        try { expirePosts(db()); } catch (e) { console.error('Archive sweep failed:', e.message); }
      });
    } catch (e) {
      databaseInitError=e;
      console.error('Lumora database initialization failed:', e);
      throw e;
    }
  })();

  setInterval(()=>{if(databaseReady){try{cleanupTrash(db())}catch(e){console.error('Trash cleanup failed:',e.message)} }},60*60*1000);
  setInterval(()=>{if(databaseReady){try{expirePosts(db())}catch(e){console.error('Archive sweep failed:',e.message)} }},60*1000);
}
startServer().catch(e=>{ console.error('Lumora startup failed:', e); process.exit(1); });
process.on('SIGTERM', async()=>{ try{await remoteSaveQueue; await closeRemoteDatabase();}finally{process.exit(0);} });
process.on('SIGINT', async()=>{ try{await remoteSaveQueue; await closeRemoteDatabase();}finally{process.exit(0);} });
