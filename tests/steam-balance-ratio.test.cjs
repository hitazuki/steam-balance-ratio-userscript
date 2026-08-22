"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const script = require(path.resolve(
  __dirname,
  "../steam-balance-ratio.user.js"
));

assert.equal(script.currencyCodeFromId(12), "PHP");
assert.equal(script.currencyCodeFromId(5), "RUB");
assert.equal(script.currencyCodeFromId(999), null);

assert.deepEqual(
  script.marketItemFromUrl(
    "https://steamcommunity.com/market/listings/730/Fracture%20Case"
  ),
  { appid: "730", marketHashName: "Fracture Case" }
);
assert.equal(script.marketItemFromUrl("https://steamcommunity.com/market/"), null);

assert.equal(script.parsePrice("P3757.93", "PHP"), 3757.93);
assert.equal(script.parsePrice("₱3,757.93", "PHP"), 3757.93);
assert.equal(script.parsePrice("3.757,93 €", "EUR"), 3757.93);
assert.equal(script.parsePrice("¥ 3,758", "JPY"), 3758);
assert.equal(script.parsePrice("-193.28 (-6%)", "PHP"), null);
assert.equal(script.parsePrice("not a price", "PHP"), null);

const quote = script.calculateQuote(341.97, 297.37, 267);
assert.equal(quote.convertedGross.toFixed(2), "341.97");
assert.equal(quote.convertedNet.toFixed(2), "297.37");
assert.equal(quote.ratio.toFixed(2), "89.79");

assert.equal(script.calculateQuote(null, 8.7, 5), null);
assert.equal(script.calculateQuote(10, 8.7, null).ratio, null);

const steamRate = script.calculateSteamRate(3757.93, 413);
assert.equal(steamRate.toFixed(8), "0.10990093");
const steamQuote = script.calculateQuote(
  3757.93 * steamRate,
  3267.78 * steamRate,
  267
);
assert.equal(steamQuote.convertedGross.toFixed(2), "413.00");
assert.equal(steamQuote.convertedNet.toFixed(2), "359.13");
assert.equal(steamQuote.ratio.toFixed(2), "74.35");

assert.equal(script.ratioClass(70), "good");
assert.equal(script.ratioClass(75), "warn");
assert.equal(script.ratioClass(81), "bad");
assert.equal(script.ratioClass(null), "missing");

console.log("steam-balance-ratio userscript tests passed");
