require('dotenv').config();
var TelegramBot = require('node-telegram-bot-api');
var web3 = require('@solana/web3.js');
var fs = require('fs');
var path = require('path');
var walletUtils = require('./wallet');
var swapUtils = require('./swap');

var BOT_TOKEN = process.env.BOT_TOKEN;
var HELIUS_KEY = process.env.HELIUS_KEY;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is not set. Add it to your .env file.');
if (!HELIUS_KEY) throw new Error('HELIUS_KEY is not set. Add it to your .env file.');
var PUMP_PROGRAM_ID = new web3.PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
var MAX = 10;
var CACHE_TTL = 5 * 60 * 1000;
var QUEUE_MAX = 200;
var POLL_INTERVAL = 20000;
var DATA_FILE  = path.join(__dirname, 'data.json');
var PID_FILE   = path.join(__dirname, 'bot.pid');
var LOCKS_DIR  = path.join(__dirname, 'sig_locks');

// Ensure sig-locks directory exists and purge stale locks from previous runs
try { if (!fs.existsSync(LOCKS_DIR)) fs.mkdirSync(LOCKS_DIR); } catch(e) {}
try {
  var now10 = Date.now() - 600000;
  fs.readdirSync(LOCKS_DIR).forEach(function(f) {
    try {
      var fp = path.join(LOCKS_DIR, f);
      if (fs.statSync(fp).mtimeMs < now10) fs.unlinkSync(fp);
    } catch(e) {}
  });
} catch(e) {}

// --- Single-instance lock ---
// Kill any previous instance and spin-wait until it is actually dead
// before we start Telegram polling, so no two instances ever poll at once.
(function acquireLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      var oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 'SIGTERM');
          console.log('[Lock] Sent SIGTERM to PID ' + oldPid + ', waiting...');
        } catch(e) { /* already dead */ }
        // Spin-wait up to 2s for SIGTERM; then force-kill with SIGKILL
        var deadline = Date.now() + 2000;
        var dead = false;
        while (Date.now() < deadline) {
          try { process.kill(oldPid, 0); }
          catch(e) { dead = true; console.log('[Lock] Old PID ' + oldPid + ' is gone (SIGTERM)'); break; }
          var t = Date.now() + 100; while (Date.now() < t) {}
        }
        if (!dead) {
          try {
            process.kill(oldPid, 'SIGKILL');
            console.log('[Lock] Sent SIGKILL to PID ' + oldPid);
            // Wait another 1s for SIGKILL to take effect
            var kdeadline = Date.now() + 1000;
            while (Date.now() < kdeadline) {
              try { process.kill(oldPid, 0); }
              catch(e) { console.log('[Lock] Old PID ' + oldPid + ' is gone (SIGKILL)'); break; }
              var t2 = Date.now() + 100; while (Date.now() < t2) {}
            }
          } catch(e) { /* already dead */ }
        }
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch(e) { console.log('[Lock] Error: ' + e.message); }
})();
function releaseLock() { try { fs.unlinkSync(PID_FILE); } catch(e) {} }
process.on('exit', releaseLock);
process.on('SIGTERM', function() { releaseLock(); process.exit(0); });
process.on('SIGINT',  function() { releaseLock(); process.exit(0); });

// --- Persistence ---
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      var raw = fs.readFileSync(DATA_FILE, 'utf8');
      var d = JSON.parse(raw);
      return {
        users: d.users || {},
        watchingMints: d.watchingMints || {},
        claimsCount: d.claimsCount || {},
        autoBuy: d.autoBuy || {}
      };
    }
  } catch(e) {
    console.log('[Data] Load error: ' + e.message);
  }
  return { users: {}, watchingMints: {}, claimsCount: {}, autoBuy: {} };
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: users, watchingMints: watchingMints, claimsCount: claimsCount, autoBuy: autoBuyState }, null, 2));
  } catch(e) {
    console.log('[Data] Save error: ' + e.message);
  }
}

var saved = loadData();
var users = saved.users;
var watchingMints = saved.watchingMints;
var claimsCount = saved.claimsCount;
var autoBuyState = saved.autoBuy;   // uid -> { wallet, pinHash, autoLockMinutes, tokens{} }

// --- Runtime state (not persisted) ---
var tokenCache = {};
var lastSig = {};
var lastSigInit = {};
var messageQueue = [];
var isProcessing = false;
var messageTypes = {};
var wsConnections = {}; // mint -> subId  (all share globalConn's single WebSocket)
var sessions = {};          // uid -> unlockedAt (ms) — in-memory, reset on restart
var pendingActions = {};    // uid -> {type, ...}   — conversation state machine
var activeCountdowns = {};  // uid -> {timeout, sig, mint, cancelled}
var globalKillSwitch = false; // instant kill-all flag

var bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: true,
    params: { timeout: 10 }
  }
});

// Single shared connection — all WebSocket subscriptions ride on one socket (no 429 rate-limits)
var globalConn = new web3.Connection(
  'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY,
  { commitment: 'confirmed', wsEndpoint: 'wss://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY }
);

// Handle polling errors gracefully — don't crash on 409/network hiccup
bot.on('polling_error', function(err) {
  if (err && err.message && err.message.includes('409')) {
    console.log('[Bot] 409 conflict — another instance may be running. Retrying...');
  } else {
    console.log('[Bot] Polling error: ' + (err && err.message));
  }
});

bot.setMyCommands([
  {command: 'start',       description: 'Start the bot'},
  {command: 'track',       description: 'Track a token — /track <CA>'},
  {command: 'list',        description: 'See your tracked tokens'},
  {command: 'wallet',      description: 'Manage your trading wallet'},
  {command: 'export',      description: 'Export wallet private key'},
  {command: 'unlock',      description: 'Unlock session for auto-buy'},
  {command: 'autobuy',     description: 'Configure auto-buy per token'},
  {command: 'killswitch',  description: 'Disable all auto-buy instantly'},
  {command: 'help',        description: 'How to use this bot'}
]);

// --- Cleanup intervals ---
setInterval(function() {
  var now = Date.now();
  Object.keys(tokenCache).forEach(function(k) {
    if (!tokenCache[k] || now - tokenCache[k].timestamp > CACHE_TTL) delete tokenCache[k];
  });
  // Evict sig lock files older than 10 minutes
  try {
    fs.readdirSync(LOCKS_DIR).forEach(function(f) {
      try {
        var fp = path.join(LOCKS_DIR, f);
        if (fs.statSync(fp).mtimeMs < now - 600000) fs.unlinkSync(fp);
      } catch(e) {}
    });
  } catch(e) {}
  if (messageQueue.length > QUEUE_MAX) messageQueue = messageQueue.slice(-QUEUE_MAX);
  var mtKeys = Object.keys(messageTypes);
  if (mtKeys.length > 1000) mtKeys.slice(0, mtKeys.length - 1000).forEach(function(k) { delete messageTypes[k]; });
}, 300000);

// --- Polling loop ---
setInterval(function() {
  var mints = Object.keys(watchingMints);
  if (mints.length === 0) return;
  mints.forEach(function(mint) {
    var info = watchingMints[mint];
    if (!info) return;
    pollMint(mint, info.ticker);
  });
}, POLL_INTERVAL);

function getBondingCurve(mint) {
  try {
    var mintPubkey = new web3.PublicKey(mint);
    var seeds = [Buffer.from('bonding-curve'), mintPubkey.toBuffer()];
    return web3.PublicKey.findProgramAddressSync(seeds, PUMP_PROGRAM_ID)[0];
  } catch(e) {
    return null;
  }
}

// Real-time WebSocket listener — all subscriptions share globalConn (one WebSocket, no 429s)
function startWatching(mint, ticker) {
  if (wsConnections[mint] != null) return;
  try {
    var pub = new web3.PublicKey(mint);
    var subId = globalConn.onLogs(pub, function(result) {
      if (result.err) return;
      var isClaim = (result.logs || []).some(function(l) {
        return l && (
          l.includes('CollectCreatorFee') ||
          l.includes('collectCreatorFee') ||
          l.includes('Distribute_creator_fees') ||
          l.includes('DistributeCreatorFees') ||
          l.includes('distribute_creator_fees') ||
          l.includes('Transfer_Creator_fees_to_pump') ||
          l.includes('transfer_creator_fees_to_pump')
        );
      });
      if (!isClaim) return;
      console.log('[WS CLAIM] mint:' + mint.slice(0, 20) + '... sig:' + result.signature.slice(0, 20) + '...');
      fireAlert(mint, ticker, result.signature);
    }, 'confirmed');
    wsConnections[mint] = subId;
    console.log('[Watch] Subscribed WS to ' + mint.slice(0, 20) + '...');
  } catch(e) {
    console.log('[Watch] Error: ' + e.message);
  }
}

function stopWatching(mint) {
  if (wsConnections[mint] == null) return;
  try {
    globalConn.removeOnLogsListener(wsConnections[mint]).catch(function() {});
  } catch(e) {}
  delete wsConnections[mint];
}

function pollMint(mint, ticker) {
  // Poll the bonding curve PDA — that's where CollectCreatorFee txs appear
  var pub = getBondingCurve(mint);
  if (!pub) return;

  globalConn.getSignaturesForAddress(pub, {limit: 10})
    .then(function(sigs) {
      if (!sigs || sigs.length === 0) return;

      if (!lastSigInit[mint]) {
        lastSigInit[mint] = true;
        lastSig[mint] = sigs[0].signature;
        console.log('[Poll] Initialized ' + mint + ' lastSig=' + sigs[0].signature.slice(0, 20) + '...');
        return;
      }

      var newSigs = [];
      for (var i = 0; i < sigs.length; i++) {
        if (sigs[i].signature === lastSig[mint]) break;
        newSigs.push(sigs[i]);
      }

      if (newSigs.length === 0) return;

      lastSig[mint] = sigs[0].signature;

      newSigs.forEach(function(sigInfo) {
        if (sigInfo.err) return;
        globalConn.getParsedTransaction(sigInfo.signature, {maxSupportedTransactionVersion: 0})
          .then(function(tx) {
            if (!tx || !tx.meta) return;
            var logs = tx.meta.logMessages || [];
            var isClaim = logs.some(function(l) {
              return l && (
                l.includes('CollectCreatorFee') ||
                l.includes('collectCreatorFee') ||
                l.includes('Distribute_creator_fees') ||
                l.includes('DistributeCreatorFees') ||
                l.includes('distribute_creator_fees') ||
                l.includes('Transfer_Creator_fees_to_pump') ||
                l.includes('transfer_creator_fees_to_pump')
              );
            });
            if (!isClaim) return;
            console.log('[POLL CLAIM] mint:' + mint.slice(0,20) + '... sig:' + sigInfo.signature.slice(0,20) + '...');
            fireAlert(mint, ticker, sigInfo.signature);
          })
          .catch(function() {});
      });
    })
    .catch(function(e) { console.log('[Poll] Error ' + mint + ': ' + e.message); });
}

// --- Helpers ---
function clean(str) {
  if (!str) return '';
  return str.replace(/[<>&"]/g, function(c) {
    return {'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;'}[c];
  });
}

function normalizeImageUrl(url) {
  if (!url) return null;
  if (url.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + url.slice(7);
  if (url.includes('/ipfs/')) return 'https://ipfs.io/ipfs/' + url.split('/ipfs/')[1].split('?')[0];
  if (url.startsWith('https://')) return url;
  return null;
}

function formatAge(createdAt) {
  if (!createdAt) return 'N/A';
  var created = createdAt > 1e12 ? createdAt : createdAt * 1000;
  var diff = Math.floor((Date.now() - created) / 1000);
  if (diff < 0 || diff > 31536000) return 'N/A';
  if (diff < 60) return diff + 's';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

function getClaimTier(solAmount) {
  if (!solAmount) return '';
  var amt = parseFloat(solAmount);
  if (amt >= 5) return '🚨 STRONG (5+ SOL)\n';
  if (amt >= 2) return '⚠️ MEDIUM (2-5 SOL)\n';
  return '💤 WEAK (&lt;2 SOL)\n';
}

function formatNum(num) {
  if (!num) return 'N/A';
  if (num >= 1000000) return '$' + (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return '$' + (num / 1000).toFixed(1) + 'K';
  return '$' + num.toFixed(0);
}

function getClaimedAmount(sig) {
  return fetch('https://api.helius.xyz/v0/transactions/?api-key=' + HELIUS_KEY, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({transactions: [sig]})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (!data || !data[0]) return null;
    var tx = data[0];
    // Use the largest positive balance change — that's the creator receiving the fee.
    // Summing all nativeTransfers overcounts (includes rent, network fees, etc.)
    var maxGain = 0;
    (tx.accountData || []).forEach(function(a) {
      if (a.nativeBalanceChange > maxGain) maxGain = a.nativeBalanceChange;
    });
    if (maxGain > 0) return (maxGain / 1e9).toFixed(4);
    // Fallback: largest single nativeTransfer
    var maxTransfer = 0;
    (tx.nativeTransfers || []).forEach(function(t) { if (t.amount > maxTransfer) maxTransfer = t.amount; });
    return maxTransfer > 0 ? (maxTransfer / 1e9).toFixed(4) : null;
  })
  .catch(function() { return null; });
}

function fetchMetadata(metadataUri) {
  if (!metadataUri) return Promise.resolve(null);
  var url = normalizeImageUrl(metadataUri) || metadataUri;
  return fetch(url)
    .then(function(r) { return r.ok ? r.json() : null; })
    .catch(function() { return null; });
}

// Helius DAS — reliable on-chain image source, works for any pump.fun token
function getAssetFromHelius(mint) {
  return fetch('https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ jsonrpc: '2.0', id: 'getAsset', method: 'getAsset', params: { id: mint } })
  })
  .then(function(r) { return r.ok ? r.json() : null; })
  .then(function(data) { return (data && data.result) ? data.result : null; })
  .catch(function() { return null; });
}

// GMGN bundle scanner — returns % of supply bundled at launch or null
function getBundlePercent(ca) {
  return fetch('https://gmgn.ai/defi/quotation/v1/tokens/token_security_launchpad?chain=sol&address=' + ca, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://gmgn.ai/'
    }
  })
  .then(function(r) {
    if (!r.ok) { console.log('[Bundle] HTTP ' + r.status + ' from GMGN for ' + ca.slice(0,16)); return null; }
    return r.json();
  })
  .then(function(json) {
    if (!json) return null;
    // Log first time we get a response so we can see the actual field names
    console.log('[Bundle] GMGN keys for ' + ca.slice(0,16) + ': ' + Object.keys(json.data || json).join(', '));
    var d = json.data || json;
    // Try every plausible field name
    var ratio = d.bundled_supply_ratio || d.bundle_supply_ratio || d.bundled_ratio ||
                d.creator_bundle_pct   || d.bundle_pct         || null;
    if (ratio != null) return (parseFloat(ratio) * 100).toFixed(1);
    var pct = d.bundle_percentage || d.bundled_percentage || d.bundlePercentage || null;
    if (pct != null) return parseFloat(pct).toFixed(1);
    return null;
  })
  .catch(function(e) { console.log('[Bundle] Error: ' + e.message); return null; });
}

function getCachedTokenData(ca) {
  if (tokenCache[ca] && Date.now() - tokenCache[ca].timestamp < CACHE_TTL) {
    return Promise.resolve(tokenCache[ca].data);
  }
  return getTokenData(ca).then(function(data) {
    if (data) tokenCache[ca] = {data: data, timestamp: Date.now()};
    return data;
  });
}

function getTokenData(ca) {
  var pumpReq = fetch('https://frontend-api.pump.fun/coins/' + ca)
    .then(function(r) { return r.ok ? r.json() : null; })
    .catch(function() { return null; });

  var pumpV2Req = fetch('https://frontend-api-v2.pump.fun/coins/' + ca)
    .then(function(r) { return r.ok ? r.json() : null; })
    .catch(function() { return null; });

  var dexReq = fetch('https://api.dexscreener.com/latest/dex/tokens/' + ca)
    .then(function(r) { return r.ok ? r.json() : null; })
    .catch(function() { return null; });

  var assetReq = getAssetFromHelius(ca);
  var bundleReq = getBundlePercent(ca);

  return Promise.all([pumpReq, pumpV2Req, dexReq, assetReq, bundleReq]).then(function(results) {
    var pump = results[0];
    var pumpV2 = results[1];
    var dex = results[2];
    var asset = results[3];
    var bundlePct = results[4];
    var pair = dex && dex.pairs && dex.pairs.length > 0 ? dex.pairs[0] : null;

    var pumpData = {};
    if (pump) Object.keys(pump).forEach(function(k) { if (pump[k]) pumpData[k] = pump[k]; });
    if (pumpV2) Object.keys(pumpV2).forEach(function(k) { if (!pumpData[k] && pumpV2[k]) pumpData[k] = pumpV2[k]; });

    // Use Helius cached json_uri as fallback when pump.fun API doesn't return metadata_uri
    var metadataUri = pumpData.metadata_uri
      || (asset && asset.content && asset.content.json_uri ? asset.content.json_uri : null);
    var metaReq = metadataUri ? fetchMetadata(metadataUri) : Promise.resolve(null);

    return metaReq.then(function(meta) {
      var ticker = clean(pumpData.symbol || (meta && meta.symbol) || (pair && pair.baseToken && pair.baseToken.symbol) || 'UNKNOWN');
      var name = clean(pumpData.name || (meta && meta.name) || (pair && pair.baseToken && pair.baseToken.name) || ticker);

      // Helius asset image is most reliable for non-dex-paid coins (no DexScreener data)
      var heliusImg = asset && asset.content && asset.content.links && asset.content.links.image
        ? asset.content.links.image : null;
      var rawPfp = (pair && pair.info && pair.info.imageUrl)
        || (meta && meta.image)
        || pumpData.image_uri
        || heliusImg
        || null;
      var pfp = normalizeImageUrl(rawPfp);

      var mc = pair ? formatNum(pair.fdv) : 'N/A';
      var vol = pair ? formatNum(pair.volume && pair.volume.h24) : 'N/A';
      // Try pump.fun timestamp first, fall back to DexScreener pairCreatedAt
      var createdAt = pumpData.created_timestamp || (pair && pair.pairCreatedAt) || null;
      var creator = pumpData.creator || null;

      var dexPaid = false;
      if (pair) {
        if (pair.boosts && pair.boosts.active > 0) dexPaid = true;
        if (!dexPaid && pair.profile && pair.profile.header) dexPaid = true;
        if (!dexPaid && pair.labels && pair.labels.length > 0) dexPaid = true;
        if (!dexPaid && pair.info && pair.info.imageUrl &&
          ((pair.info.socials && pair.info.socials.length > 0) ||
           (pair.info.websites && pair.info.websites.length > 0))) dexPaid = true;
      }

      // Normalize a social handle/URL to a full URL
      function normTwitter(v) {
        if (!v || !v.trim()) return null;
        v = v.trim();
        if (v.startsWith('http://') || v.startsWith('https://')) return v;
        var handle = v.replace(/^@/, '');
        return 'https://x.com/' + handle;
      }
      function normTelegram(v) {
        if (!v || !v.trim()) return null;
        v = v.trim();
        if (v.startsWith('http://') || v.startsWith('https://')) return v;
        var handle = v.replace(/^@/, '');
        return 'https://t.me/' + handle;
      }
      function normWebsite(v) {
        if (!v || !v.trim()) return null;
        v = v.trim();
        if (v.startsWith('http://') || v.startsWith('https://')) return v;
        return 'https://' + v;
      }

      var rawTwitter = (pumpData.twitter && pumpData.twitter.trim() !== '' ? pumpData.twitter : null) || (meta && meta.twitter) || null;
      var rawWebsite = (pumpData.website && pumpData.website.trim() !== '' ? pumpData.website : null) || (meta && meta.website) || null;
      var rawTelegram = (pumpData.telegram && pumpData.telegram.trim() !== '' ? pumpData.telegram : null) || (meta && meta.telegram) || null;

      // Helius external_url is often the project website for non-dex-paid coins
      var heliusExtUrl = asset && asset.content && asset.content.links && asset.content.links.external_url
        ? asset.content.links.external_url : null;

      if (pair && pair.info) {
        if (pair.info.socials) {
          pair.info.socials.forEach(function(s) {
            if (s.type === 'twitter' && !rawTwitter) rawTwitter = s.url;
            if (s.type === 'telegram' && !rawTelegram) rawTelegram = s.url;
          });
        }
        if (!rawWebsite && pair.info.websites && pair.info.websites[0]) rawWebsite = pair.info.websites[0].url;
      }

      if (!rawWebsite && heliusExtUrl) rawWebsite = heliusExtUrl;

      var twitter = normTwitter(rawTwitter);
      var website = normWebsite(rawWebsite);
      var telegram = normTelegram(rawTelegram);

      console.log('[Token]', ticker, '| pfp:', pfp ? 'yes' : 'no', '| dexPaid:', dexPaid, '| age:', formatAge(createdAt), '| tw:', twitter ? 'yes' : 'no', '| tg:', telegram ? 'yes' : 'no', '| bundle:', bundlePct != null ? bundlePct + '%' : 'N/A');
      return { ticker, name, pfp, mc, vol, dexPaid, website, twitter, telegram, createdAt, creator, bundlePct };
    });
  });
}

// --- Message builders ---
function buildSocials(data) {
  var parts = [];
  if (data.twitter) parts.push('<a href="' + data.twitter + '">X</a>');
  if (data.website) parts.push('<a href="' + data.website + '">Web</a>');
  if (data.telegram) parts.push('<a href="' + data.telegram + '">TG</a>');
  return parts.length > 0 ? parts.join(' | ') : 'None';
}

function buildText(ca, data, header) {
  var dex = data.dexPaid ? '🟢' : '🔴';
  var bundle = data.bundlePct != null ? data.bundlePct + '%' : 'N/A';
  return header +
    '<a href="https://pump.fun/coin/' + ca + '"><b>$' + data.ticker + '</b></a> — ' + data.name + '\n' +
    '<code>' + ca + '</code>\n\n' +
    '📊 <b>Stats</b>\n' +
    '├ MC: ' + data.mc + '\n' +
    '├ Vol: ' + data.vol + '\n' +
    '├ Age: ' + formatAge(data.createdAt) + '\n' +
    '├ Dex: ' + dex + '\n' +
    '└ Bundle: ' + bundle + '\n\n' +
    '🔗 <b>Socials</b>\n' +
    '└ ' + buildSocials(data);
}

function buildAlertText(ca, data, solAmount, claimNum) {
  var dex = data.dexPaid ? '🟢' : '🔴';
  var bundle = data.bundlePct != null ? data.bundlePct + '%' : 'N/A';
  var tier = getClaimTier(solAmount);
  var amtLine = '💰 <b>' + (solAmount ? solAmount + ' SOL claimed' : 'Amount unknown') + '</b>\n';
  var claimLine = claimNum > 1 ? '📍 Claim #' + claimNum + '\n' : '';
  return '🚨 <b>FEE CLAIM ALERT</b>\n\n' +
    tier + amtLine + claimLine + '\n' +
    '<a href="https://pump.fun/coin/' + ca + '"><b>$' + data.ticker + '</b></a> — ' + data.name + '\n' +
    '<code>' + ca + '</code>\n\n' +
    '📊 <b>Stats</b>\n' +
    '├ MC: ' + data.mc + '\n' +
    '├ Vol: ' + data.vol + '\n' +
    '├ Age: ' + formatAge(data.createdAt) + '\n' +
    '├ Dex: ' + dex + '\n' +
    '└ Bundle: ' + bundle + '\n\n' +
    '🔗 <b>Socials</b>\n' +
    '└ ' + buildSocials(data);
}

function buildKeyboard(ca, sig) {
  var keyboard = [
    [
      {text: 'AXI', url: 'https://axiom.trade/t/' + ca},
      {text: 'TRO', url: 'https://t.me/solana_trojanbot?start=' + ca},
      {text: 'BLO', url: 'https://t.me/BloomSolana_bot?start=' + ca},
      {text: 'PHO', url: 'https://photon-sol.tinyastro.io/en/lp/' + ca}
    ],
    [
      {text: 'OKX', url: 'https://www.okx.com/web3/dex-swap#inputChain=501&inputCurrency=SOL&outputChain=501&outputCurrency=' + ca},
      {text: 'NEO', url: 'https://bullx.io/terminal?chainId=1399811149&address=' + ca},
      {text: 'TRM', url: 'https://padre.trade/token/' + ca},
      {text: 'DEX', url: 'https://dexscreener.com/solana/' + ca}
    ],
    [{text: '🔄 Refresh', callback_data: 'refresh:' + ca}]
  ];
  if (sig) keyboard[2].push({text: '🔍 Solscan', url: 'https://solscan.io/tx/' + sig});
  return {inline_keyboard: keyboard};
}

// --- Message queue ---
function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;
  isProcessing = true;
  var item = messageQueue.shift();
  var promise;

  if (item.type === 'photo') {
    promise = bot.sendPhoto(item.chatId, item.pfp, {
      caption: item.text,
      parse_mode: 'HTML',
      reply_markup: item.markup
    }).then(function(sent) {
      messageTypes[String(item.chatId) + ':' + sent.message_id] = 'photo';
    }).catch(function(err) {
      console.log('[Queue] Photo failed: ' + err.message);
      return bot.sendMessage(item.chatId, item.text, {
        parse_mode: 'HTML',
        reply_markup: item.markup,
        disable_web_page_preview: true
      }).then(function(sent) {
        messageTypes[String(item.chatId) + ':' + sent.message_id] = 'text';
      });
    });
  } else {
    promise = bot.sendMessage(item.chatId, item.text, {
      parse_mode: 'HTML',
      reply_markup: item.markup,
      disable_web_page_preview: true
    }).then(function(sent) {
      messageTypes[String(item.chatId) + ':' + sent.message_id] = 'text';
    });
  }

  promise
    .catch(function(e) { console.log('[Queue] Error: ' + e.message); })
    .then(function() {
      isProcessing = false;
      setTimeout(processQueue, 150);
    });
}

function queueCard(chatId, ca, data, text, sig) {
  if (messageQueue.length >= QUEUE_MAX) messageQueue.shift();
  var markup = buildKeyboard(ca, sig);
  messageQueue.push(data.pfp
    ? {type: 'photo', chatId: chatId, pfp: data.pfp, text: text, markup: markup}
    : {type: 'text', chatId: chatId, text: text, markup: markup}
  );
  processQueue();
}

// --- Commands ---
bot.onText(/\/start/, function(msg) {
  bot.sendMessage(msg.chat.id,
    '<b>PumpFee Alert Bot</b> 🚨\n\n' +
    'Get instant alerts when fees are claimed on any Pump.fun token.\n\n' +
    '<b>How to use:</b>\n' +
    '1. Paste any Pump.fun token CA\n' +
    '2. Bot tracks it 24/7\n' +
    '3. Get pinged the moment fees are claimed\n\n' +
    '<b>Commands:</b>\n' +
    '/track &lt;CA&gt; — track a token\n' +
    '/list — see tracked tokens\n' +
    '/help — how to use',
    {parse_mode: 'HTML'}
  );
});

bot.onText(/\/help/, function(msg) {
  bot.sendMessage(msg.chat.id,
    '<b>How to use PumpFee Bot:</b>\n\n' +
    '• Paste any Pump.fun CA directly in chat\n' +
    '• Or use /track &lt;CA&gt;\n' +
    '• Use /list to see what you\'re tracking\n' +
    '• Tap ❌ Remove to stop tracking\n' +
    '• Tap 🔄 Refresh to update stats\n\n' +
    '<b>Claim tiers:</b>\n' +
    '🚨 Strong — 5+ SOL\n' +
    '⚠️ Medium — 2 to 5 SOL\n' +
    '💤 Weak — under 2 SOL\n\n' +
    '<b>Auto-Buy:</b>\n' +
    '/wallet — create &amp; manage trading wallet\n' +
    '/export — export private key (Phantom/Solflare)\n' +
    '/unlock — unlock session with PIN\n' +
    '/autobuy — configure per-token auto-buy\n' +
    '/killswitch — disable all auto-buy instantly\n\n' +
    '<b>How Auto-Buy works:</b>\n' +
    '1. Create wallet → fund it with SOL\n' +
    '2. /unlock with your PIN\n' +
    '3. /autobuy → pick token → enable + set amount\n' +
    '4. When fees are claimed → 15s countdown fires\n' +
    '5. Cancel or let it execute via Jupiter\n\n' +
    '<b>Max 10 tokens per user.</b>',
    {parse_mode: 'HTML'}
  );
});

bot.onText(/\/list/, function(msg) {
  var chatId = msg.chat.id;
  var uid = String(chatId);
  var tokens = users[uid] || [];
  if (tokens.length === 0) {
    return bot.sendMessage(chatId, 'You\'re not tracking any tokens yet.\n\nPaste a Pump.fun CA to start.');
  }
  // Chain all sends sequentially so Remove All is guaranteed to appear last
  var chain = bot.sendMessage(chatId, '<b>Tracked tokens (' + tokens.length + '/10):</b>', {parse_mode: 'HTML'});
  tokens.forEach(function(t) {
    chain = chain.then(function() {
      var claims = claimsCount[t.mint] ? ' · ' + claimsCount[t.mint] + ' claim(s)' : '';
      var ready = lastSigInit[t.mint] ? ' ✅' : ' ⏳';
      var text = '<a href="https://pump.fun/coin/' + t.mint + '"><b>$' + t.ticker + '</b></a>' +
        claims + ready + '\n<code>' + t.mint + '</code>';
      var btns = {inline_keyboard: [[{text: '❌ Remove', callback_data: 'remove:' + t.mint}]]};
      return bot.sendMessage(chatId, text, {parse_mode: 'HTML', reply_markup: btns, disable_web_page_preview: true});
    });
  });
  chain.then(function() {
    return bot.sendMessage(chatId, '─────────────────', {
      reply_markup: {inline_keyboard: [[{text: '🗑 Remove All', callback_data: 'removeall'}]]}
    });
  });
});

// --- Callback queries ---
bot.on('callback_query', function(query) {
  var uid = String(query.message.chat.id);
  var data = query.data;
  var chatId = query.message.chat.id;
  var msgId = query.message.message_id;
  var msgKey = String(chatId) + ':' + msgId;

  if (data === 'removeall') {
    var myTokens = (users[uid] || []).slice();
    users[uid] = [];
    myTokens.forEach(function(t) {
      var stillTracked = Object.keys(users).some(function(u) {
        return users[u] && users[u].find(function(x) { return x.mint === t.mint; });
      });
      if (!stillTracked) {
        stopWatching(t.mint);
        delete watchingMints[t.mint];
        delete lastSig[t.mint];
        delete lastSigInit[t.mint];
        delete claimsCount[t.mint];
        delete tokenCache[t.mint];
      }
    });
    saveData();
    bot.answerCallbackQuery(query.id, {text: '✅ All tokens removed!'});
    bot.editMessageReplyMarkup({inline_keyboard: []}, {chat_id: chatId, message_id: msgId}).catch(function() {});
    return;
  }

  if (data.startsWith('remove:')) {
    var ca = data.replace('remove:', '');
    if (users[uid]) users[uid] = users[uid].filter(function(t) { return t.mint !== ca; });
    var stillTracked = Object.keys(users).some(function(u) {
      return users[u] && users[u].find(function(t) { return t.mint === ca; });
    });
    if (!stillTracked) {
      stopWatching(ca);
      delete watchingMints[ca];
      delete lastSig[ca];
      delete lastSigInit[ca];
      delete claimsCount[ca];
      delete tokenCache[ca];
    }
    saveData();
    bot.answerCallbackQuery(query.id, {text: '✅ Removed!'});
    bot.editMessageReplyMarkup({inline_keyboard: []}, {chat_id: chatId, message_id: msgId}).catch(function() {});
    return;
  }

  if (data.startsWith('refresh:')) {
    var ca = data.replace('refresh:', '');
    bot.answerCallbackQuery(query.id, {text: '🔄 Refreshing...'});
    tokenCache[ca] = null;

    getCachedTokenData(ca).then(function(tokenData) {
      if (!tokenData) return;
      var text = buildText(ca, tokenData, '🔄 <b>Refreshed</b>\n\n');
      var markup = buildKeyboard(ca, null);
      var isPhoto = messageTypes[msgKey] === 'photo';

      if (isPhoto) {
        bot.editMessageCaption(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: markup
        }).catch(function(err) {
          console.log('[Refresh] Caption edit failed: ' + err.message);
          bot.sendMessage(chatId, text, {
            parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true
          }).then(function(sent) {
            messageTypes[String(chatId) + ':' + sent.message_id] = 'text';
          });
        });
      } else {
        bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: markup, disable_web_page_preview: true
        }).catch(function(err) {
          console.log('[Refresh] Text edit failed: ' + err.message);
          bot.sendMessage(chatId, text, {
            parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true
          }).then(function(sent) {
            messageTypes[String(chatId) + ':' + sent.message_id] = 'text';
          });
        });
      }
    }).catch(function(e) { console.log('[Refresh] Error: ' + e.message); });
    return;
  }

  // ---- Wallet callbacks ----
  if (data === 'wallet:create') {
    bot.answerCallbackQuery(query.id);
    var st = autoBuyState[uid];
    if (st && st.wallet) {
      return bot.sendMessage(chatId, '⚠️ You already have a wallet. Use /wallet to manage it.', {parse_mode: 'HTML'});
    }
    pendingActions[uid] = {type: 'wallet_create_pin1'};
    bot.sendMessage(chatId,
      '🔑 Choose a <b>4-digit PIN</b> to encrypt your wallet.\n\n' +
      '⚠️ <b>Delete your PIN message after sending it.</b>\n\nEnter PIN:',
      {parse_mode: 'HTML'});
    return;
  }

  if (data === 'wallet:export') {
    bot.answerCallbackQuery(query.id);
    askPin(chatId, uid, 'wallet_export_pin');
    return;
  }

  if (data === 'wallet:changepin') {
    bot.answerCallbackQuery(query.id);
    askPin(chatId, uid, 'wallet_changepin_old');
    return;
  }

  // ---- Auto-buy list (back button) ----
  if (data === 'ab:main') {
    bot.answerCallbackQuery(query.id);
    var tokens = users[uid] || [];
    if (tokens.length === 0) {
      return bot.editMessageText('❌ No tracked tokens.', {chat_id: chatId, message_id: msgId}).catch(function() {});
    }
    var rows = buildAutoBuyList(uid);
    var session = isSessionUnlocked(uid) ? '🔓 Unlocked' : '🔒 Locked';
    bot.editMessageText('🤖 <b>Auto-Buy Settings</b>\n\nSession: ' + session + '\n\nSelect a token to configure:', {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: {inline_keyboard: rows}
    }).catch(function() {});
    return;
  }

  // ---- Auto-buy token settings page ----
  if (data.startsWith('ab:token:')) {
    var mint = data.slice(9);
    var tokenObj = (users[uid] || []).find(function(t) { return t.mint === mint; });
    var ticker = tokenObj ? tokenObj.ticker : mint.slice(0, 8) + '...';
    bot.answerCallbackQuery(query.id);
    ensureTokenCfg(uid, mint);
    var settingsText = buildAutoBuySettingsText(uid, mint, ticker);
    var settingsKb = buildAutoBuySettingsKeyboard(uid, mint);
    bot.editMessageText(settingsText, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: settingsKb
    }).catch(function() {
      bot.sendMessage(chatId, settingsText, {parse_mode: 'HTML', reply_markup: settingsKb});
    });
    return;
  }

  // ---- Toggle enable/disable ----
  if (data.startsWith('ab:toggle:')) {
    var mint = data.slice(10);
    var cfg = ensureTokenCfg(uid, mint);
    var tokenObj = (users[uid] || []).find(function(t) { return t.mint === mint; });
    var ticker = tokenObj ? tokenObj.ticker : mint.slice(0, 8);
    var st = autoBuyState[uid];
    if (!st || !st.wallet) {
      bot.answerCallbackQuery(query.id, {text: '❌ Set up your wallet first with /wallet'});
      return;
    }
    if (!cfg.enabled && cfg.hasBought) {
      bot.answerCallbackQuery(query.id, {text: '⚠️ Reset "Has Bought" first to re-enable.'});
      return;
    }
    cfg.enabled = !cfg.enabled;
    saveData();
    bot.answerCallbackQuery(query.id, {text: cfg.enabled ? '✅ Auto-buy enabled' : '❌ Auto-buy disabled'});
    var settingsText = buildAutoBuySettingsText(uid, mint, ticker);
    var settingsKb = buildAutoBuySettingsKeyboard(uid, mint);
    bot.editMessageText(settingsText, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: settingsKb
    }).catch(function() {});
    return;
  }

  // ---- Set a setting value (opens conversation) ----
  if (data.startsWith('ab:set:')) {
    var parts = data.slice(7).split(':');
    var field = parts[0];
    var mint = parts.slice(1).join(':');
    var tokenObj = (users[uid] || []).find(function(t) { return t.mint === mint; });
    var ticker = tokenObj ? tokenObj.ticker : mint.slice(0, 8);
    var prompts = {
      buyAmount:   'Enter buy amount in SOL (e.g. <code>0.1</code>):',
      minClaim:    'Enter minimum claim in SOL to trigger (e.g. <code>0.5</code>). Enter <code>0</code> for any claim:',
      slippage:    'Enter slippage % (e.g. <code>1</code> for 1%):',
      priorityFee: 'Enter priority fee in SOL (e.g. <code>0.0005</code>):'
    };
    bot.answerCallbackQuery(query.id);
    pendingActions[uid] = {type: 'ab_set', field: field, mint: mint, ticker: ticker, msgId: msgId};
    bot.sendMessage(chatId, '⚙️ ' + (prompts[field] || 'Enter value:'), {parse_mode: 'HTML'});
    return;
  }

  // ---- Reset hasBought ----
  if (data.startsWith('ab:resetbought:')) {
    var mint = data.slice(15);
    var tokenObj = (users[uid] || []).find(function(t) { return t.mint === mint; });
    var ticker = tokenObj ? tokenObj.ticker : mint.slice(0, 8);
    var cfg = ensureTokenCfg(uid, mint);
    cfg.hasBought = false;
    cfg.lastProcessedClaimTx = null;
    saveData();
    bot.answerCallbackQuery(query.id, {text: '🔄 Reset — auto-buy can fire again on next claim.'});
    var settingsText = buildAutoBuySettingsText(uid, mint, ticker);
    var settingsKb = buildAutoBuySettingsKeyboard(uid, mint);
    bot.editMessageText(settingsText, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: settingsKb
    }).catch(function() {});
    return;
  }

  // ---- Cancel active countdown ----
  if (data.startsWith('ab_cancel:')) {
    var targetUid = data.slice(10);
    if (targetUid !== uid) { bot.answerCallbackQuery(query.id, {text: '❌ Not your countdown.'}); return; }
    if (!activeCountdowns[uid]) {
      bot.answerCallbackQuery(query.id, {text: 'No active countdown.'});
      return;
    }
    clearTimeout(activeCountdowns[uid].timeout);
    activeCountdowns[uid].cancelled = true;
    delete activeCountdowns[uid];
    bot.answerCallbackQuery(query.id, {text: '✅ Auto-buy cancelled!'});
    bot.editMessageText('❌ <b>Auto-buy cancelled.</b>', {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: {inline_keyboard: []}
    }).catch(function() {});
    return;
  }
});

// --- Track token ---
function trackToken(uid, ca, chatId) {
  if (!users[uid]) users[uid] = [];
  if (users[uid].length >= MAX) {
    return bot.sendMessage(chatId, '⚠️ You\'ve hit the 10 token limit.\n\nUse /list and tap ❌ Remove to free up a slot.');
  }
  if (users[uid].find(function(t) { return t.mint === ca; })) {
    return bot.sendMessage(chatId, '⚠️ Already tracking this token.');
  }
  bot.sendMessage(chatId, '🔍 Looking up token...');
  getCachedTokenData(ca).then(function(data) {
    if (!data) return bot.sendMessage(chatId, '❌ Could not find token. Check the CA and try again.');
    users[uid].push({mint: ca, ticker: data.ticker});
    watchingMints[ca] = {ticker: data.ticker};
    saveData();
    var text = buildText(ca, data, '✅ <b>Now Tracking</b>\n\n');
    queueCard(chatId, ca, data, text, null);
    startWatching(ca, data.ticker);  // real-time WebSocket
    pollMint(ca, data.ticker);       // 20s backup
  }).catch(function(e) {
    console.log('[Track] Error: ' + e.message);
    bot.sendMessage(chatId, '❌ Could not find token. Check the CA and try again.');
  });
}

bot.onText(/\/track (.+)/, function(msg, match) {
  trackToken(String(msg.chat.id), match[1].trim(), msg.chat.id);
});

bot.on('message', function(msg) {
  var text = msg.text || '';
  var uid = String(msg.chat.id);
  if (text.startsWith('/')) {
    // Any command cancels a pending action
    if (pendingActions[uid]) delete pendingActions[uid];
    return;
  }
  // Pending conversation action takes priority over CA detection
  if (pendingActions[uid]) {
    handlePendingAction(uid, msg.chat.id, text.trim());
    return;
  }
  var ca = text.trim();
  if (ca.length >= 32 && ca.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(ca)) {
    trackToken(uid, ca, msg.chat.id);
  }
});

// --- Fire alert to all users tracking this mint ---
function fireAlert(mint, ticker, sig) {
  // Cross-process dedup: fs.openSync('wx') is an atomic POSIX exclusive-create.
  // If another process (or this one) already claimed this sig, it throws EEXIST.
  var lockFile = path.join(LOCKS_DIR, sig.slice(0, 64).replace(/[^a-zA-Z0-9]/g, '_') + '.lock');
  try {
    var fd = fs.openSync(lockFile, 'wx');
    fs.closeSync(fd);
  } catch(e) {
    // Another instance (or this process's WS+poll) already fired for this sig
    console.log('[Alert] Dedup skip sig:' + sig.slice(0, 20) + '... (' + (e.code || e.message) + ')');
    return;
  }

  // Increment claim counter here (single authoritative place)
  claimsCount[mint] = (claimsCount[mint] || 0) + 1;
  saveData();
  var claimNum = claimsCount[mint];
  console.log('[Alert] Firing for mint:' + mint.slice(0,20) + '... sig:' + sig.slice(0,20) + '... #' + claimNum);

  tokenCache[mint] = null;
  Promise.all([getCachedTokenData(mint), getClaimedAmount(sig)])
    .then(function(results) {
      var data = results[0];
      var solAmount = results[1];
      if (!data) return;
      var text = buildAlertText(mint, data, solAmount, claimNum);
      Object.keys(users).forEach(function(uid) {
        if (users[uid] && users[uid].find(function(t) { return t.mint === mint; })) {
          queueCard(uid, mint, data, text, sig);
        }
      });
      // Trigger auto-buy checks for all eligible users
      checkAutoBuyForMint(mint, ticker, sig, solAmount, data);
    })
    .catch(function(e) { console.log('[Alert] Error: ' + e.message); });
}

// ============================================================
// AUTO-BUY HELPERS
// ============================================================

function isSessionUnlocked(uid) {
  if (!sessions[uid]) return false;
  var st = autoBuyState[uid];
  var lockMins = (st && st.autoLockMinutes) || 30;
  return (Date.now() - sessions[uid]) < lockMins * 60000;
}

function getWalletBalance(publicKey) {
  try {
    return globalConn.getBalance(new web3.PublicKey(publicKey))
      .then(function(lamps) { return lamps / 1e9; })
      .catch(function() { return null; });
  } catch(e) { return Promise.resolve(null); }
}

function ensureAutoBuyUser(uid) {
  if (!autoBuyState[uid]) autoBuyState[uid] = { autoLockMinutes: 30, tokens: {} };
  if (!autoBuyState[uid].tokens) autoBuyState[uid].tokens = {};
  return autoBuyState[uid];
}

function getTokenCfg(uid, mint) {
  var st = autoBuyState[uid];
  if (!st || !st.tokens) return null;
  return st.tokens[mint] || null;
}

function ensureTokenCfg(uid, mint) {
  ensureAutoBuyUser(uid);
  if (!autoBuyState[uid].tokens[mint]) {
    autoBuyState[uid].tokens[mint] = {
      enabled: false, buyAmount: 0.1, minClaim: 0,
      slippage: 1, priorityFee: 0.0005, hasBought: false, lastProcessedClaimTx: null
    };
  }
  return autoBuyState[uid].tokens[mint];
}

// ============================================================
// AUTO-BUY TRIGGER (called from fireAlert)
// ============================================================

function checkAutoBuyForMint(mint, ticker, sig, solAmount, data) {
  if (globalKillSwitch) return;
  var claimSol = solAmount ? parseFloat(solAmount) : 0;

  Object.keys(autoBuyState).forEach(function(uid) {
    var st = autoBuyState[uid];
    if (!st || !st.wallet) return;
    if (!users[uid] || !users[uid].find(function(t) { return t.mint === mint; })) return;

    var cfg = getTokenCfg(uid, mint);
    if (!cfg || !cfg.enabled) return;
    if (cfg.hasBought) return;
    if (cfg.lastProcessedClaimTx === sig) return;
    if (activeCountdowns[uid]) {
      console.log('[AutoBuy] User ' + uid + ' already has countdown — skip');
      return;
    }
    if (!isSessionUnlocked(uid)) {
      bot.sendMessage(parseInt(uid),
        '🔒 <b>Auto-Buy Paused</b>\n\nClaim detected on <b>$' + ticker + '</b> but your session is locked.\n\nUse /unlock to enable auto-buy.',
        {parse_mode: 'HTML'});
      return;
    }
    var minClaim = parseFloat(cfg.minClaim) || 0;
    if (claimSol < minClaim) {
      console.log('[AutoBuy] User ' + uid + ' minClaim not met: ' + claimSol + ' < ' + minClaim);
      return;
    }
    startAutoBuyCountdown(uid, parseInt(uid), mint, ticker, sig, solAmount, cfg, data);
  });
}

function startAutoBuyCountdown(uid, chatId, mint, ticker, sig, solAmount, cfg, data) {
  var buyAmount = parseFloat(cfg.buyAmount) || 0.1;
  var text = '🤖 <b>AUTO-BUY TRIGGERED</b>\n\n' +
    '🪙 Token: <b>$' + ticker + '</b>\n' +
    '💰 Claim: <b>' + (solAmount || '?') + ' SOL</b>\n' +
    '🛒 Buy: <b>' + buyAmount + ' SOL</b>\n\n' +
    '⏱ Executing in <b>15 seconds</b> — tap Cancel to abort.';

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {inline_keyboard: [[{text: '❌ Cancel Auto-Buy', callback_data: 'ab_cancel:' + uid}]]}
  }).then(function(sent) {
    activeCountdowns[uid] = { sig: sig, mint: mint, cancelled: false, msgId: sent.message_id, chatId: chatId };

    activeCountdowns[uid].timeout = setTimeout(function() {
      if (!activeCountdowns[uid] || activeCountdowns[uid].cancelled) return;
      var countdown = activeCountdowns[uid];
      delete activeCountdowns[uid];
      executeAutoBuy(uid, chatId, mint, ticker, sig, cfg, data, countdown.msgId);
    }, 15000);
  }).catch(function(e) { console.log('[AutoBuy] Countdown msg error: ' + e.message); });
}

function executeAutoBuy(uid, chatId, mint, ticker, sig, cfg, data, countdownMsgId) {
  var st = autoBuyState[uid];
  if (!st || !st.wallet) return;
  if (!isSessionUnlocked(uid)) {
    bot.sendMessage(chatId, '🔒 Session expired before execution. Unlock and try again.', {parse_mode: 'HTML'});
    return;
  }
  var buyAmount = parseFloat(cfg.buyAmount) || 0.1;
  var pin = st._cachedPin; // Set temporarily during unlock, cleared after use

  // We need the keypair. If we have a cached decrypted keypair in-memory use it, otherwise can't execute.
  var keypair = st._keypair;
  if (!keypair) {
    bot.sendMessage(chatId, '⚠️ Session keypair lost (bot may have restarted). Please /unlock again.', {parse_mode: 'HTML'});
    return;
  }

  // Edit countdown message to show "executing"
  bot.editMessageText('⚙️ <b>Executing auto-buy for $' + ticker + '…</b>', {
    chat_id: chatId, message_id: countdownMsgId, parse_mode: 'HTML',
    reply_markup: {inline_keyboard: []}
  }).catch(function() {});

  // Balance check
  getWalletBalance(st.wallet.publicKey).then(function(balance) {
    if (balance === null || balance < buyAmount) {
      bot.sendMessage(chatId,
        '❌ <b>Auto-Buy Skipped</b>\n\nInsufficient balance.\n' +
        'Wallet: <b>' + (balance !== null ? balance.toFixed(4) : '?') + ' SOL</b>\n' +
        'Required: <b>' + buyAmount + ' SOL</b>',
        {parse_mode: 'HTML'});
      return;
    }

    // Mark lastProcessedClaimTx immediately to prevent duplicate execution
    cfg.lastProcessedClaimTx = sig;
    saveData();

    swapUtils.executeSwap(globalConn, keypair, mint, buyAmount, cfg.slippage, cfg.priorityFee)
      .then(function(txSig) {
        // Success — mark as bought and disable auto-buy for this token
        cfg.hasBought = true;
        cfg.enabled = false;
        saveData();
        console.log('[AutoBuy] Success! User ' + uid + ' bought ' + buyAmount + ' SOL of ' + ticker + ' tx:' + txSig.slice(0,20));
        bot.sendMessage(chatId,
          '✅ <b>Auto-Buy Executed!</b>\n\n' +
          '🪙 <b>$' + ticker + '</b>\n' +
          '💸 Bought: <b>' + buyAmount + ' SOL</b>\n' +
          '🔗 <a href="https://solscan.io/tx/' + txSig + '">View on Solscan</a>\n\n' +
          '🔒 Auto-buy disabled for this token (first claim rule).',
          {parse_mode: 'HTML', disable_web_page_preview: true});
      })
      .catch(function(err) {
        console.log('[AutoBuy] Swap failed: ' + err.message);
        // Don't set hasBought — allow retry on next claim
        cfg.lastProcessedClaimTx = null;
        saveData();
        bot.sendMessage(chatId,
          '❌ <b>Auto-Buy Failed</b>\n\n' +
          '🪙 <b>$' + ticker + '</b>\n' +
          '📋 Error: <code>' + clean(err.message.slice(0, 200)) + '</code>\n\n' +
          'Auto-buy remains enabled for next claim.',
          {parse_mode: 'HTML'});
      });
  });
}

// ============================================================
// AUTO-BUY SETTINGS UI
// ============================================================

function buildAutoBuyList(uid) {
  var tokens = users[uid] || [];
  if (tokens.length === 0) return null;
  var rows = [];
  tokens.forEach(function(t) {
    var cfg = getTokenCfg(uid, t.mint);
    var on = cfg && cfg.enabled;
    var bought = cfg && cfg.hasBought ? ' 🏁' : '';
    rows.push([{text: (on ? '✅' : '❌') + ' $' + t.ticker + bought, callback_data: 'ab:token:' + t.mint}]);
  });
  return rows;
}

function buildAutoBuySettingsText(uid, mint, ticker) {
  var cfg = ensureTokenCfg(uid, mint);
  var st = autoBuyState[uid];
  var walletBal = st && st.wallet ? '(checking...)' : '—';
  var session = isSessionUnlocked(uid) ? '🔓 Unlocked' : '🔒 Locked (use /unlock)';
  var minDisplay = (parseFloat(cfg.minClaim) || 0) === 0 ? 'Any claim' : cfg.minClaim + ' SOL minimum';
  return '🤖 <b>Auto-Buy: $' + ticker + '</b>\n\n' +
    'Session: ' + session + '\n' +
    'Status: <b>' + (cfg.enabled ? '✅ Enabled' : '❌ Disabled') + '</b>\n' +
    'Has Bought: <b>' + (cfg.hasBought ? 'Yes 🏁' : 'No') + '</b>\n\n' +
    '⚙️ <b>Settings</b>\n' +
    '├ Buy Amount: <b>' + cfg.buyAmount + ' SOL</b>\n' +
    '├ Min Claim: <b>' + minDisplay + '</b>\n' +
    '├ Slippage: <b>' + cfg.slippage + '%</b>\n' +
    '└ Priority Fee: <b>' + cfg.priorityFee + ' SOL</b>';
}

function buildAutoBuySettingsKeyboard(uid, mint) {
  var cfg = getTokenCfg(uid, mint) || {};
  return {inline_keyboard: [
    [{text: cfg.enabled ? '🔴 Disable' : '🟢 Enable', callback_data: 'ab:toggle:' + mint}],
    [{text: '💰 Buy Amount', callback_data: 'ab:set:buyAmount:' + mint},
     {text: '📉 Min Claim',  callback_data: 'ab:set:minClaim:' + mint}],
    [{text: '⚡ Slippage',   callback_data: 'ab:set:slippage:' + mint},
     {text: '🚀 Priority',   callback_data: 'ab:set:priorityFee:' + mint}],
    [{text: '🔄 Reset "Has Bought"', callback_data: 'ab:resetbought:' + mint}],
    [{text: '« Back', callback_data: 'ab:main'}]
  ]};
}

// ============================================================
// PENDING ACTION HANDLER (conversation state machine)
// ============================================================

function askPin(chatId, uid, type, extra) {
  pendingActions[uid] = Object.assign({type: type}, extra || {});
  bot.sendMessage(chatId,
    '🔑 Enter your <b>4-digit PIN</b>:\n<i>(Delete this message after typing for security)</i>',
    {parse_mode: 'HTML'});
}

function handlePendingAction(uid, chatId, text) {
  var action = pendingActions[uid];
  if (!action) return;

  // PIN validation helper
  function isValidPin(p) { return /^\d{4}$/.test(p); }

  if (action.type === 'wallet_create_pin1') {
    if (!isValidPin(text)) {
      return bot.sendMessage(chatId, '⚠️ PIN must be exactly 4 digits. Try again:');
    }
    pendingActions[uid] = {type: 'wallet_create_pin2', pin1: text};
    bot.sendMessage(chatId, '🔑 Confirm your PIN — enter it again:');
    return;
  }

  if (action.type === 'wallet_create_pin2') {
    if (!isValidPin(text)) {
      return bot.sendMessage(chatId, '⚠️ PIN must be exactly 4 digits. Try again:');
    }
    if (text !== action.pin1) {
      delete pendingActions[uid];
      return bot.sendMessage(chatId, '❌ PINs do not match. Use /wallet to try again.');
    }
    delete pendingActions[uid];
    try {
      var newWallet = walletUtils.createWallet(text);
      var st = ensureAutoBuyUser(uid);
      st.wallet = newWallet;
      st.pinHash = walletUtils.hashPin(text);
      st._keypair = walletUtils.loadKeypair(newWallet, text); // cache in-memory
      sessions[uid] = Date.now(); // auto-unlock on wallet creation
      saveData();
      bot.sendMessage(chatId,
        '✅ <b>Wallet Created!</b>\n\n' +
        '⚠️ <b>WARNING: This is a trading wallet only. Do NOT send large funds.</b>\n\n' +
        '📬 <b>Your address:</b>\n<code>' + newWallet.publicKey + '</code>\n\n' +
        '🔓 Session unlocked. You can now configure auto-buy with /autobuy.',
        {parse_mode: 'HTML'});
    } catch(e) {
      bot.sendMessage(chatId, '❌ Wallet creation failed: ' + e.message);
    }
    return;
  }

  if (action.type === 'wallet_changepin_old') {
    var st = autoBuyState[uid];
    if (!st || !st.wallet) { delete pendingActions[uid]; return; }
    if (!isValidPin(text) || walletUtils.hashPin(text) !== st.pinHash) {
      delete pendingActions[uid];
      return bot.sendMessage(chatId, '❌ Wrong PIN. Use /wallet to try again.');
    }
    pendingActions[uid] = {type: 'wallet_changepin_new1', oldPin: text};
    bot.sendMessage(chatId, '🔑 Enter your NEW 4-digit PIN:');
    return;
  }

  if (action.type === 'wallet_changepin_new1') {
    if (!isValidPin(text)) return bot.sendMessage(chatId, '⚠️ PIN must be exactly 4 digits. Try again:');
    pendingActions[uid] = {type: 'wallet_changepin_new2', oldPin: action.oldPin, newPin1: text};
    bot.sendMessage(chatId, '🔑 Confirm new PIN:');
    return;
  }

  if (action.type === 'wallet_changepin_new2') {
    if (text !== action.newPin1) {
      delete pendingActions[uid];
      return bot.sendMessage(chatId, '❌ PINs do not match. Use /wallet to try again.');
    }
    var st = autoBuyState[uid];
    var newEnc = walletUtils.reEncryptKey(st.wallet, action.oldPin, text);
    if (!newEnc) { delete pendingActions[uid]; return bot.sendMessage(chatId, '❌ Failed to re-encrypt. Old PIN may be wrong.'); }
    delete pendingActions[uid];
    st.wallet.encrypted = newEnc;
    st.pinHash = walletUtils.hashPin(text);
    st._keypair = walletUtils.loadKeypair(st.wallet, text);
    sessions[uid] = Date.now();
    saveData();
    bot.sendMessage(chatId, '✅ PIN changed. Session unlocked.', {parse_mode: 'HTML'});
    return;
  }

  if (action.type === 'wallet_export_pin') {
    var st = autoBuyState[uid];
    delete pendingActions[uid];
    if (!st || !st.wallet) {
      return bot.sendMessage(chatId, '❌ No wallet found. Use /wallet to create one.');
    }
    if (!isValidPin(text) || walletUtils.hashPin(text) !== st.pinHash) {
      return bot.sendMessage(chatId, '❌ Wrong PIN. Try again with /export.');
    }
    var kp = walletUtils.loadKeypair(st.wallet, text);
    if (!kp) return bot.sendMessage(chatId, '❌ Decryption failed. Try again with /export.');

    // Format 1: JSON byte array (Phantom, Solflare, Backpack, solana-keygen)
    var keyArr = JSON.stringify(Array.from(kp.secretKey));

    // Format 2: Base58-encoded 64-byte keypair (some wallets and CLIs)
    var bs58;
    try { bs58 = require('bs58'); } catch(e) { bs58 = null; }
    var keyB58 = bs58 ? bs58.encode(kp.secretKey) : '(bs58 unavailable)';

    var msg =
      '🔑 <b>Private Key — DELETE THIS MESSAGE IMMEDIATELY</b>\n\n' +
      '⚠️ Anyone who sees this can drain your wallet.\n\n' +
      '<b>Format 1 — JSON Array</b>\n' +
      '<i>(Phantom → Import → Private Key, Solflare, Backpack, solana-keygen)</i>\n' +
      '<code>' + keyArr + '</code>\n\n' +
      '<b>Format 2 — Base58</b>\n' +
      '<i>(Some CLIs and tools)</i>\n' +
      '<code>' + keyB58 + '</code>\n\n' +
      '🗑 <b>This message auto-deletes in 60 seconds.</b>';

    bot.sendMessage(chatId, msg, {parse_mode: 'HTML'})
      .then(function(sent) {
        setTimeout(function() {
          bot.deleteMessage(chatId, sent.message_id).catch(function() {});
        }, 60000);
      });
    return;
  }

  if (action.type === 'unlock_pin') {
    var st = autoBuyState[uid];
    delete pendingActions[uid];
    if (!st || !st.wallet) return bot.sendMessage(chatId, '❌ No wallet found. Use /wallet to create one.');
    if (!isValidPin(text) || walletUtils.hashPin(text) !== st.pinHash) {
      return bot.sendMessage(chatId, '❌ Wrong PIN. Try /unlock again.');
    }
    var kp = walletUtils.loadKeypair(st.wallet, text);
    if (!kp) return bot.sendMessage(chatId, '❌ Decryption failed. Try /unlock again.');
    st._keypair = kp;
    sessions[uid] = Date.now();
    var lockMins = st.autoLockMinutes || 30;
    bot.sendMessage(chatId,
      '🔓 <b>Session Unlocked!</b>\n\nAuto-buy will execute for ' + lockMins + ' min.\nUse /autobuy to configure tokens.',
      {parse_mode: 'HTML'});
    return;
  }

  if (action.type === 'ab_set') {
    var val = parseFloat(text);
    delete pendingActions[uid];
    if (isNaN(val) || val < 0) {
      return bot.sendMessage(chatId, '⚠️ Invalid number. Settings unchanged.');
    }
    var cfg = ensureTokenCfg(uid, action.mint);
    var field = action.field;
    if (field === 'buyAmount') {
      if (val <= 0 || val > 100) return bot.sendMessage(chatId, '⚠️ Buy amount must be > 0 and ≤ 100 SOL.');
      cfg.buyAmount = val;
    } else if (field === 'minClaim') {
      cfg.minClaim = val;
    } else if (field === 'slippage') {
      if (val < 0.1 || val > 50) return bot.sendMessage(chatId, '⚠️ Slippage must be between 0.1% and 50%.');
      cfg.slippage = val;
    } else if (field === 'priorityFee') {
      if (val < 0) return bot.sendMessage(chatId, '⚠️ Priority fee must be ≥ 0.');
      cfg.priorityFee = val;
    }
    saveData();
    // Edit the settings message to show updated values
    var settingsText = buildAutoBuySettingsText(uid, action.mint, action.ticker);
    var settingsKb = buildAutoBuySettingsKeyboard(uid, action.mint);
    if (action.msgId) {
      bot.editMessageText(settingsText, {
        chat_id: chatId, message_id: action.msgId, parse_mode: 'HTML', reply_markup: settingsKb
      }).catch(function() {
        bot.sendMessage(chatId, settingsText, {parse_mode: 'HTML', reply_markup: settingsKb});
      });
    } else {
      bot.sendMessage(chatId, settingsText, {parse_mode: 'HTML', reply_markup: settingsKb});
    }
    return;
  }

  if (action.type === 'set_autolock') {
    var val = parseInt(text);
    delete pendingActions[uid];
    if (isNaN(val) || val < 1 || val > 1440) {
      return bot.sendMessage(chatId, '⚠️ Auto-lock must be between 1 and 1440 minutes.');
    }
    var st = ensureAutoBuyUser(uid);
    st.autoLockMinutes = val;
    saveData();
    bot.sendMessage(chatId, '✅ Auto-lock set to <b>' + val + ' minutes</b>.', {parse_mode: 'HTML'});
    return;
  }
}

// ============================================================
// WALLET COMMAND
// ============================================================

bot.onText(/\/wallet/, function(msg) {
  var chatId = msg.chat.id;
  var uid = String(chatId);
  var st = autoBuyState[uid];
  if (!st || !st.wallet) {
    bot.sendMessage(chatId,
      '💼 <b>Trading Wallet</b>\n\n' +
      '⚠️ <b>Use a dedicated trading wallet — NOT your main wallet.</b>\n' +
      'The bot holds your private key encrypted with your PIN.\n\n' +
      'Tap below to create your trading wallet.',
      {parse_mode: 'HTML', reply_markup: {inline_keyboard: [[{text: '🔑 Create Wallet', callback_data: 'wallet:create'}]]}});
  } else {
    var session = isSessionUnlocked(uid) ? '🔓 Session unlocked' : '🔒 Session locked';
    bot.sendMessage(chatId,
      '💼 <b>Trading Wallet</b>\n\n' +
      '📬 <b>Address:</b>\n<code>' + st.wallet.publicKey + '</code>\n\n' +
      session + '\n\n' +
      '⚠️ Do NOT use as main wallet. Only fund with trading SOL.',
      {parse_mode: 'HTML', reply_markup: {inline_keyboard: [
        [{text: '🔑 Export Private Key', callback_data: 'wallet:export'}],
        [{text: '🔒 Change PIN', callback_data: 'wallet:changepin'}]
      ]}});
  }
});

// ============================================================
// UNLOCK COMMAND
// ============================================================

bot.onText(/\/unlock/, function(msg) {
  var chatId = msg.chat.id;
  var uid = String(chatId);
  var st = autoBuyState[uid];
  if (!st || !st.wallet) {
    return bot.sendMessage(chatId, '❌ No wallet set up. Use /wallet first.', {parse_mode: 'HTML'});
  }
  if (isSessionUnlocked(uid)) {
    var lockMins = st.autoLockMinutes || 30;
    var remaining = Math.ceil(lockMins - (Date.now() - sessions[uid]) / 60000);
    return bot.sendMessage(chatId, '🔓 Session already unlocked — <b>' + remaining + ' min</b> remaining.', {parse_mode: 'HTML'});
  }
  askPin(chatId, uid, 'unlock_pin');
});

// ============================================================
// EXPORT COMMAND
// ============================================================

bot.onText(/\/export/, function(msg) {
  var chatId = msg.chat.id;
  var uid = String(chatId);
  var st = autoBuyState[uid];
  if (!st || !st.wallet) {
    return bot.sendMessage(chatId,
      '❌ No wallet found.\n\nCreate one first with /wallet.',
      {parse_mode: 'HTML'});
  }
  bot.sendMessage(chatId,
    '🔑 <b>Export Private Key</b>\n\n' +
    '⚠️ Your key will appear in this chat.\n' +
    '<b>Delete both the PIN message and the key message immediately after copying.</b>\n\n' +
    'Enter your <b>4-digit PIN</b> to continue:',
    {parse_mode: 'HTML'});
  pendingActions[uid] = {type: 'wallet_export_pin'};
});

// ============================================================
// AUTOBUY COMMAND
// ============================================================

bot.onText(/\/autobuy/, function(msg) {
  var chatId = msg.chat.id;
  var uid = String(chatId);
  var st = autoBuyState[uid];
  if (!st || !st.wallet) {
    return bot.sendMessage(chatId, '❌ Set up your wallet first with /wallet.', {parse_mode: 'HTML'});
  }
  var tokens = users[uid] || [];
  if (tokens.length === 0) {
    return bot.sendMessage(chatId, '❌ You\'re not tracking any tokens. Add some with /track.');
  }
  var rows = buildAutoBuyList(uid);
  var session = isSessionUnlocked(uid) ? '🔓 Unlocked' : '🔒 Locked';
  bot.sendMessage(chatId,
    '🤖 <b>Auto-Buy Settings</b>\n\nSession: ' + session + '\n\nSelect a token to configure:',
    {parse_mode: 'HTML', reply_markup: {inline_keyboard: rows}});
});

// ============================================================
// KILLSWITCH COMMAND
// ============================================================

bot.onText(/\/killswitch/, function(msg) {
  var chatId = msg.chat.id;
  var uid = String(chatId);
  // Cancel this user's active countdown
  var cancelled = 0;
  if (activeCountdowns[uid]) {
    clearTimeout(activeCountdowns[uid].timeout);
    activeCountdowns[uid].cancelled = true;
    delete activeCountdowns[uid];
    cancelled++;
  }
  // Disable all auto-buy for this user
  var st = autoBuyState[uid];
  if (st && st.tokens) {
    Object.keys(st.tokens).forEach(function(mint) {
      if (st.tokens[mint]) st.tokens[mint].enabled = false;
    });
    saveData();
  }
  bot.sendMessage(chatId,
    '🛑 <b>Kill Switch Activated</b>\n\n' +
    'All auto-buy disabled.' + (cancelled ? '\nActive countdown cancelled.' : ''),
    {parse_mode: 'HTML'});
});

console.log('[Bot] Started — polling mint addresses for fee claims');
console.log('[Bot] Loaded ' + Object.keys(watchingMints).length + ' tracked token(s) from disk');

// Reconnect WebSocket watchers for all mints that were persisted
Object.keys(watchingMints).forEach(function(mint) {
  var info = watchingMints[mint];
  if (info) startWatching(mint, info.ticker);
});
