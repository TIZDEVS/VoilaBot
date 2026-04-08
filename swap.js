'use strict';
var web3 = require('@solana/web3.js');

var SOL_MINT      = 'So11111111111111111111111111111111111111112';
var JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
var JUPITER_SWAP  = 'https://quote-api.jup.ag/v6/swap';

function getQuote(outputMint, amountLamports, slippageBps) {
  var url = JUPITER_QUOTE +
    '?inputMint=' + SOL_MINT +
    '&outputMint=' + encodeURIComponent(outputMint) +
    '&amount=' + Math.floor(amountLamports) +
    '&slippageBps=' + Math.floor(slippageBps);
  return fetch(url, { headers: { Accept: 'application/json' } })
    .then(function(r) {
      if (!r.ok) return r.text().then(function(t) { throw new Error('Quote HTTP ' + r.status + ': ' + t.slice(0, 120)); });
      return r.json();
    });
}

function buildSwapTx(quoteResponse, userPublicKey, priorityFeeLamports) {
  return fetch(JUPITER_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      quoteResponse: quoteResponse,
      userPublicKey: userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Math.floor(priorityFeeLamports) || 5000
    })
  }).then(function(r) {
    if (!r.ok) return r.text().then(function(t) { throw new Error('Swap TX HTTP ' + r.status + ': ' + t.slice(0, 120)); });
    return r.json();
  });
}

// Returns Promise<txSignature string>
function executeSwap(connection, keypair, outputMint, amountSol, slippagePct, priorityFeeSol) {
  var lamports     = Math.floor(amountSol * 1e9);
  var slippageBps  = Math.floor((slippagePct || 1) * 100);
  var priorityLamp = Math.floor((priorityFeeSol || 0.0005) * 1e9);
  console.log('[Swap] ' + amountSol + ' SOL → ' + outputMint.slice(0, 20) + '... slip=' + slippagePct + '%');
  return getQuote(outputMint, lamports, slippageBps)
    .then(function(quote) {
      console.log('[Swap] Quote outAmount=' + quote.outAmount);
      return buildSwapTx(quote, keypair.publicKey.toString(), priorityLamp);
    })
    .then(function(swapData) {
      if (!swapData || !swapData.swapTransaction) throw new Error('No swapTransaction in Jupiter response');
      var tx = web3.VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      tx.sign([keypair]);
      return connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' });
    });
}

module.exports = { executeSwap };
