'use strict';
var crypto = require('crypto');
var web3 = require('@solana/web3.js');

function hashPin(pin) {
  return crypto.createHash('sha256').update('pumpfeebot:' + pin).digest('hex');
}

function deriveKey(pin, saltHex) {
  return crypto.pbkdf2Sync(String(pin), Buffer.from(saltHex, 'hex'), 100000, 32, 'sha256');
}

function encryptKey(secretKeyBytes, pin) {
  var saltBuf = crypto.randomBytes(16);
  var key = deriveKey(pin, saltBuf.toString('hex'));
  var iv = crypto.randomBytes(12);
  var cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  var enc = Buffer.concat([cipher.update(Buffer.from(secretKeyBytes)), cipher.final()]);
  return {
    salt: saltBuf.toString('hex'),
    iv:   iv.toString('hex'),
    tag:  cipher.getAuthTag().toString('hex'),
    data: enc.toString('hex')
  };
}

function decryptKey(stored, pin) {
  try {
    var key = deriveKey(pin, stored.salt);
    var decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(stored.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(stored.data, 'hex')), decipher.final()]);
  } catch(e) {
    return null;
  }
}

function createWallet(pin) {
  var kp = web3.Keypair.generate();
  return { publicKey: kp.publicKey.toString(), encrypted: encryptKey(kp.secretKey, pin) };
}

function loadKeypair(walletData, pin) {
  var bytes = decryptKey(walletData.encrypted, pin);
  if (!bytes) return null;
  try { return web3.Keypair.fromSecretKey(new Uint8Array(bytes)); } catch(e) { return null; }
}

function reEncryptKey(walletData, oldPin, newPin) {
  var bytes = decryptKey(walletData.encrypted, oldPin);
  if (!bytes) return null;
  return encryptKey(bytes, newPin);
}

module.exports = { hashPin, createWallet, loadKeypair, reEncryptKey };
