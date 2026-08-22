// ==UserScript==
// @name         Steam 市场货币换算与挂刀比例
// @namespace    https://github.com/hitazuki/steam-balance-ratio-userscript
// @version      0.2.3
// @description  使用 Steam 自身的货币换算，在饰品挂单旁显示目标货币金额和税后挂刀比例。
// @author       hitazuki
// @license      MIT
// @homepageURL  https://github.com/hitazuki/steam-balance-ratio-userscript
// @supportURL   https://github.com/hitazuki/steam-balance-ratio-userscript/issues
// @compatible   chrome
// @compatible   edge
// @compatible   firefox
// @match        https://steamcommunity.com/market/listings/*/*
// @match        https://steamcommunity.com/market/
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_ID = "ssbr";
  const SETTINGS_KEY = `${SCRIPT_ID}:settings`;
  const CURRENCY_BY_ID = Object.freeze({
    1: "USD", 2: "GBP", 3: "EUR", 4: "CHF", 5: "RUB", 6: "PLN",
    7: "BRL", 8: "JPY", 9: "NOK", 10: "IDR", 11: "MYR", 12: "PHP",
    13: "SGD", 14: "THB", 15: "VND", 16: "KRW", 17: "TRY", 18: "UAH",
    19: "MXN", 20: "CAD", 21: "AUD", 22: "NZD", 23: "CNY", 24: "INR",
    25: "CLP", 26: "PEN", 27: "COP", 28: "ZAR", 29: "HKD", 30: "TWD",
    31: "SAR", 32: "AED", 33: "SEK", 34: "ARS", 35: "ILS", 36: "BYN",
    37: "KZT", 38: "KWD", 39: "QAR", 40: "CRC", 41: "UYU", 42: "BGN",
    43: "HRK", 44: "CZK", 45: "DKK", 46: "HUF", 47: "RON"
  });
  const ZERO_DECIMAL_CURRENCIES = new Set(["CLP", "JPY", "KRW", "VND"]);
  const TARGET_CURRENCIES = ["CNY", "USD", "EUR", "PHP", "HKD", "TWD", "SGD"];
  const CURRENCY_ID_BY_CODE = Object.freeze(Object.fromEntries(
    Object.entries(CURRENCY_BY_ID).map(([id, code]) => [code, Number(id)])
  ));
  const NO_LISTING_MESSAGES = new Set([
    "此物品不在货架上",
    "目前无人挂出此物品",
    "there are no listings currently available for this item",
    "there are no listings for this item",
    "this item is not currently listed"
  ]);

  function normalizeMessage(text) {
    return typeof text === "string"
      ? text.replace(/\s+/g, " ").trim().replace(/[。.!！]+$/, "").toLowerCase()
      : "";
  }

  function isNoListingMessage(text) {
    const normalized = normalizeMessage(text);
    return [...NO_LISTING_MESSAGES].some((message) => normalized.includes(message));
  }

  function currencyCodeFromId(id) {
    return CURRENCY_BY_ID[Number(id)] || null;
  }

  function parsePrice(text, currencyCode) {
    if (typeof text !== "string") return null;
    let value = text
      .replace(/[\u00a0\u202f\s']/g, "")
      .replace(/[^0-9.,-]/g, "");
    if (!value || value === "-") return null;

    const dot = value.lastIndexOf(".");
    const comma = value.lastIndexOf(",");
    const decimalDigits = ZERO_DECIMAL_CURRENCIES.has(currencyCode) ? 0 : 2;

    if (dot >= 0 && comma >= 0) {
      const decimalSeparator = dot > comma ? "." : ",";
      const groupingSeparator = decimalSeparator === "." ? "," : ".";
      value = value.split(groupingSeparator).join("");
      if (decimalSeparator === ",") value = value.replace(",", ".");
    } else {
      const separator = dot >= 0 ? "." : comma >= 0 ? "," : null;
      if (separator) {
        const digitsAfter = value.length - value.lastIndexOf(separator) - 1;
        if (decimalDigits > 0 && digitsAfter === decimalDigits) {
          value = value.split(separator).join(".");
        } else {
          value = value.split(separator).join("");
        }
      }
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function calculateQuote(convertedGross, convertedNet, buyPrice) {
    if (![convertedGross, convertedNet].every(
      (value) => Number.isFinite(value) && value >= 0
    )) {
      return null;
    }
    const ratio = Number.isFinite(buyPrice) && buyPrice > 0 && convertedNet > 0
      ? buyPrice / convertedNet * 100
      : null;
    return { convertedGross, convertedNet, ratio };
  }

  function calculateSteamRate(sourcePrice, targetPrice) {
    if (![sourcePrice, targetPrice].every(
      (value) => Number.isFinite(value) && value > 0
    )) return null;
    return targetPrice / sourcePrice;
  }

  function ratioClass(ratio) {
    if (!Number.isFinite(ratio)) return "missing";
    if (ratio <= 70) return "good";
    if (ratio <= 80) return "warn";
    return "bad";
  }

  function marketItemFromUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, "https://steamcommunity.com");
      const match = url.pathname.match(/^\/market\/listings\/(\d+)\/(.+)$/);
      if (!match) return null;
      return {
        appid: match[1],
        marketHashName: decodeURIComponent(match[2])
      };
    } catch (_) {
      return null;
    }
  }

  // Allow dependency-free Node tests to import the pure calculation helpers.
  if (typeof document === "undefined" && typeof module !== "undefined" && module.exports) {
    module.exports = {
      calculateQuote,
      calculateSteamRate,
      currencyCodeFromId,
      isNoListingMessage,
      marketItemFromUrl,
      parsePrice,
      ratioClass
    };
    return;
  }

  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  let renderTimer = null;
  let observer = null;
  const steamRates = new Map();
  const steamLowestQuotes = new Map();
  const rateStates = new Map();

  function loadSettings() {
    const saved = GM_getValue(SETTINGS_KEY, {});
    return {
      targetCurrency: TARGET_CURRENCIES.includes(saved.targetCurrency)
        ? saved.targetCurrency
        : "CNY",
      manualSourceCurrency: typeof saved.manualSourceCurrency === "string"
        ? saved.manualSourceCurrency
        : "USD"
    };
  }

  const settings = loadSettings();

  function saveSettings() {
    GM_setValue(SETTINGS_KEY, settings);
  }

  function marketItem() {
    return marketItemFromUrl(location.href);
  }

  function marketItemNameId() {
    const tickerId = Number(pageWindow.ItemActivityTicker?.m_llItemNameID);
    if (Number.isFinite(tickerId) && tickerId > 0) return String(tickerId);
    for (const script of document.scripts) {
      const match = script.textContent.match(/Market_LoadOrderSpread\(\s*(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  function marketItemFromRow(row) {
    const link = row.querySelector('a[href*="/market/listings/"]');
    return marketItemFromUrl(link?.href || "");
  }

  function rateItem() {
    return marketItem() || marketItemFromRow(document.querySelector(
      '#tabContentsMyActiveMarketListingsRows .market_listing_row, '
      + '#myListings .market_listing_row[id^="mylisting_"]'
    ) || document.body);
  }

  function buyPriceKey(targetCurrency, item = marketItem()) {
    if (!item) return null;
    return `${SCRIPT_ID}:buy:${item.appid}:${item.marketHashName}:${targetCurrency}`;
  }

  function detectCurrency() {
    const walletId = Number(pageWindow.g_rgWalletInfo?.wallet_currency);
    let code = null;
    if (Number.isInteger(walletId) && typeof pageWindow.GetCurrencyCode === "function") {
      try {
        const steamCode = pageWindow.GetCurrencyCode(walletId);
        if (typeof steamCode === "string" && /^[A-Za-z]{3}$/.test(steamCode)) {
          code = steamCode.toUpperCase();
        }
      } catch (_) {
        // Fall through to the stable Steam currency id mapping.
      }
    }
    code = code || currencyCodeFromId(walletId);
    if (code) return { code, detected: true, walletId };

    const queryId = Number(new URLSearchParams(location.search).get("currency"));
    code = currencyCodeFromId(queryId);
    if (code) return { code, detected: true, walletId: queryId };
    return { code: settings.manualSourceCurrency, detected: false, walletId: null };
  }

  function currentBuyPrice(target, item = marketItem()) {
    const key = buyPriceKey(target, item);
    if (!key) return null;
    const value = Number(GM_getValue(key, ""));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function sellerNetFromGross(gross) {
    if (!Number.isFinite(gross) || gross <= 0) return null;
    if (typeof pageWindow.CalculateFeeAmount !== "function") return null;
    const publisherFee = Number(
      pageWindow.g_rgWalletInfo?.wallet_publisher_fee_percent_default ?? 0.1
    );
    try {
      const grossMinor = Math.round(gross * 100);
      const fees = pageWindow.CalculateFeeAmount(grossMinor, publisherFee);
      if (!fees || !Number.isFinite(Number(fees.fees))) return null;
      const netMinor = grossMinor - Number(fees.fees);
      return netMinor > 0 ? netMinor / 100 : null;
    } catch (_) {
      return null;
    }
  }

  function formatMoney(value, currency) {
    if (!Number.isFinite(value)) return "—";
    try {
      return new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2
      }).format(value);
    } catch (_) {
      return `${currency} ${value.toFixed(2)}`;
    }
  }

  function rateKey(sourceCurrency, targetCurrency) {
    return `${sourceCurrency}/${targetCurrency}`;
  }

  function cachedRateKey(sourceCurrency, targetCurrency) {
    return `${SCRIPT_ID}:rate:${sourceCurrency}:${targetCurrency}`;
  }

  function cachedLowestKey(currencyCode, item) {
    return item
      ? `${SCRIPT_ID}:lowest:${currencyCode}:${item.appid}:${item.marketHashName}`
      : null;
  }

  function readCachedRate(sourceCurrency, targetCurrency) {
    if (sourceCurrency === targetCurrency) return 1;
    const saved = GM_getValue(cachedRateKey(sourceCurrency, targetCurrency), null);
    const rate = Number(saved?.rate);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }

  function readCachedLowest(currencyCode, item) {
    const storageKey = cachedLowestKey(currencyCode, item);
    if (!storageKey) return null;
    const saved = GM_getValue(storageKey, null);
    const gross = Number(saved?.gross);
    return Number.isFinite(gross) && gross > 0 ? gross : null;
  }

  function writeCachedLowest(currencyCode, item, gross) {
    const storageKey = cachedLowestKey(currencyCode, item);
    if (!storageKey || !Number.isFinite(gross) || gross <= 0) return;
    if (readCachedLowest(currencyCode, item) === gross) return;
    GM_setValue(storageKey, { gross, updatedAt: Date.now() });
  }

  function updateConversionHint(targetCurrency, text, isError = false) {
    const hint = document.getElementById(`${SCRIPT_ID}-hint`);
    const target = document.getElementById(`${SCRIPT_ID}-target`);
    if (!hint || target?.value !== targetCurrency) return;
    hint.textContent = text;
    hint.style.color = isError ? "#e35e5e" : "";
  }

  async function loadOrderBookLowest(currencyId, currencyCode) {
    const itemNameId = marketItemNameId();
    if (!itemNameId) return null;
    const url = new URL("/market/itemordershistogram", location.origin);
    url.searchParams.set("country", pageWindow.g_strCountryCode || "PH");
    url.searchParams.set("language", pageWindow.g_strLanguage || "schinese");
    url.searchParams.set("currency", String(currencyId));
    url.searchParams.set("item_nameid", itemNameId);
    url.searchParams.set("two_factor", "0");
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`订单深度 HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.success) return null;
    const formatted = parsePrice(data.lowest_sell_order_formatted || "", currencyCode);
    if (Number.isFinite(formatted) && formatted > 0) return formatted;
    const graphPrice = Number(data.sell_order_graph?.[0]?.[0]);
    return Number.isFinite(graphPrice) && graphPrice > 0 ? graphPrice : null;
  }

  async function loadSteamRate(targetCurrency, currency) {
    const key = rateKey(currency.code, targetCurrency);
    const existing = rateStates.get(key);
    const sameCurrency = currency.code === targetCurrency;
    const detailItem = marketItem();
    if (existing === "loading") return;
    if (existing === "ready" && (!detailItem || steamLowestQuotes.has(key))) return;
    if (sameCurrency) {
      steamRates.set(key, 1);
    } else if (!steamRates.has(key)) {
      const cachedRate = readCachedRate(currency.code, targetCurrency);
      if (cachedRate) steamRates.set(key, cachedRate);
    }
    const sourceCurrencyId = CURRENCY_ID_BY_CODE[currency.code];
    const targetCurrencyId = CURRENCY_ID_BY_CODE[targetCurrency];
    const item = rateItem();
    if (!sourceCurrencyId || !targetCurrencyId) {
      rateStates.set(key, "error");
      updateConversionHint(targetCurrency, "无法构造 Steam 货币换算请求", true);
      return;
    }
    if (!item) {
      rateStates.set(key, sameCurrency ? "ready" : "pending");
      updateConversionHint(
        targetCurrency,
        sameCurrency ? `Steam ${targetCurrency} 无需换算` : "正在等待已上架物品数据…"
      );
      renderRows(currency);
      return;
    }

    rateStates.set(key, "loading");
    updateConversionHint(targetCurrency, `正在获取 Steam 的 ${targetCurrency} 换算…`);
    renderRows(currency);
    try {
      const priceUrl = (currencyId) => {
        const url = new URL("/market/priceoverview/", location.origin);
        url.searchParams.set("appid", item.appid);
        url.searchParams.set("market_hash_name", item.marketHashName);
        url.searchParams.set("country", pageWindow.g_strCountryCode || "PH");
        url.searchParams.set("currency", String(currencyId));
        return url;
      };
      let sourceData;
      let targetData;
      if (sameCurrency) {
        const response = await fetch(priceUrl(sourceCurrencyId), { credentials: "include" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        sourceData = await response.json();
        targetData = sourceData;
      } else {
        const [sourceResponse, targetResponse] = await Promise.all([
          fetch(priceUrl(sourceCurrencyId), { credentials: "include" }),
          fetch(priceUrl(targetCurrencyId), { credentials: "include" })
        ]);
        if (!sourceResponse.ok || !targetResponse.ok) {
          throw new Error(`HTTP ${sourceResponse.status}/${targetResponse.status}`);
        }
        [sourceData, targetData] = await Promise.all([
          sourceResponse.json(),
          targetResponse.json()
        ]);
      }
      let sourcePrice = parsePrice(sourceData.lowest_price || "", currency.code);
      let targetPrice = parsePrice(targetData.lowest_price || "", targetCurrency);
      let quoteSource = "priceoverview";
      if (!sourcePrice || !targetPrice) {
        quoteSource = "orderbook";
        if (sameCurrency) {
          sourcePrice = await loadOrderBookLowest(sourceCurrencyId, currency.code);
          targetPrice = sourcePrice;
        } else {
          [sourcePrice, targetPrice] = await Promise.all([
            loadOrderBookLowest(sourceCurrencyId, currency.code),
            loadOrderBookLowest(targetCurrencyId, targetCurrency)
          ]);
        }
      }
      if (!sourcePrice || !targetPrice) throw new Error("Steam 未返回最低售价");
      const rate = calculateSteamRate(sourcePrice, targetPrice);
      if (!rate) throw new Error("Steam 换算率无效");
      steamRates.set(key, rate);
      GM_setValue(cachedRateKey(currency.code, targetCurrency), {
        rate,
        updatedAt: Date.now()
      });
      const sourceNet = sellerNetFromGross(sourcePrice);
      steamLowestQuotes.set(key, {
        itemKey: `${item.appid}:${item.marketHashName}`,
        sourceGross: sourcePrice,
        targetGross: targetPrice,
        targetNet: Number.isFinite(sourceNet) ? sourceNet * rate : null,
        quoteSource
      });
      writeCachedLowest(currency.code, item, sourcePrice);
      rateStates.set(key, "ready");
      updateConversionHint(
        targetCurrency,
        sameCurrency
          ? `Steam ${targetCurrency} 无需换算`
          : `Steam 换算：1 ${currency.code} ≈ ${rate.toFixed(6)} ${targetCurrency}`
      );
    } catch (error) {
      const cachedRate = steamRates.get(key);
      if (Number.isFinite(cachedRate) && cachedRate > 0) {
        rateStates.set(key, "ready");
        updateConversionHint(targetCurrency, "当前物品无报价，使用最近一次 Steam 换算率");
      } else {
        rateStates.set(key, "error");
        updateConversionHint(
          targetCurrency,
          `Steam 换算获取失败：${error.message || error}`,
          true
        );
      }
    }
    renderRows(currency);
  }

  function positiveAmountsFromElement(element, currencyCode) {
    if (!element) return [];
    const clone = element.cloneNode(true);
    clone.querySelectorAll(`.${SCRIPT_ID}-result`).forEach((node) => node.remove());
    const leaves = Array.from(clone.querySelectorAll("*")).filter(
      (node) => node.children.length === 0 && node.textContent.trim()
    );
    const texts = leaves.length
      ? leaves.map((node) => node.textContent.trim())
      : clone.textContent.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const amounts = [];
    for (const text of texts) {
      if (/^-/.test(text)) continue;
      const value = parsePrice(text, currencyCode);
      if (value === null || value <= 0) continue;
      if (amounts[amounts.length - 1] !== value) amounts.push(value);
    }
    return amounts;
  }

  function findPriceHost(row, currencyCode) {
    const standard = row.querySelector(".market_listing_their_price .market_table_value")
      || row.querySelector(".market_listing_their_price")
      || row.querySelector(".market_listing_my_price .market_table_value")
      || row.querySelector(".market_listing_my_price");
    if (standard) return standard;

    // Steam Inventory Helper can replace the original price spans and wrappers.
    // Find the smallest price-like container that still contains gross and net values.
    const candidates = Array.from(row.querySelectorAll(
      '[class*="price" i], [class*="profit" i], [class*="cost" i]'
    ));
    return candidates
      .filter((node) => positiveAmountsFromElement(node, currencyCode).length >= 2)
      .sort((left, right) => left.querySelectorAll("*").length - right.querySelectorAll("*").length)[0]
      || null;
  }

  function listingAmounts(row, currencyCode) {
    const host = findPriceHost(row, currencyCode);
    if (!host) return null;
    const grossElement = row.querySelector(".market_listing_price_with_fee");
    const netElement = row.querySelector(".market_listing_price_without_fee");
    const gross = grossElement ? parsePrice(grossElement.textContent, currencyCode) : null;
    const net = netElement ? parsePrice(netElement.textContent, currencyCode) : null;
    if (gross !== null && net !== null) return { gross, net, host };

    const fallback = positiveAmountsFromElement(host, currencyCode);
    if (fallback.length < 2) return null;
    return { gross: fallback[0], net: fallback[1], host };
  }

  function addStyles() {
    if (document.getElementById(`${SCRIPT_ID}-styles`)) return;
    const style = document.createElement("style");
    style.id = `${SCRIPT_ID}-styles`;
    style.textContent = `
      #${SCRIPT_ID}-toolbar {
        box-sizing: border-box; display: flex; align-items: end; flex-wrap: wrap;
        gap: 12px 16px; margin: 0 0 12px; padding: 14px 16px;
        color: #d6d7d8; background: #162637; border: 1px solid #263b50;
        font-family: Arial, Helvetica, sans-serif;
      }
      #${SCRIPT_ID}-toolbar .${SCRIPT_ID}-field { display: flex; flex-direction: column; gap: 5px; }
      #${SCRIPT_ID}-toolbar label { color: #8f98a0; font-size: 12px; }
      #${SCRIPT_ID}-toolbar input, #${SCRIPT_ID}-toolbar select {
        box-sizing: border-box; height: 34px; padding: 5px 9px; color: #fff;
        background: #101923; border: 1px solid #344c61; border-radius: 3px;
      }
      #${SCRIPT_ID}-toolbar input { width: 145px; }
      #${SCRIPT_ID}-toolbar select { min-width: 90px; }
      #${SCRIPT_ID}-toolbar .${SCRIPT_ID}-source {
        height: 34px; display: flex; align-items: center; padding: 0 10px;
        color: #66c0f4; background: #101923; border: 1px solid #344c61; border-radius: 3px;
      }
      #${SCRIPT_ID}-toolbar .${SCRIPT_ID}-hint { align-self: center; color: #8f98a0; font-size: 12px; }
      #searchResultsRows .market_listing_row,
      #tabContentsMyActiveMarketListingsRows .market_listing_row,
      #myListings .market_listing_row[id^="mylisting_"] { position: relative; }
      .${SCRIPT_ID}-result {
        box-sizing: border-box; position: absolute; z-index: 2; top: 50%; right: 350px;
        width: 190px; transform: translateY(-50%); display: grid;
        grid-template-columns: 48px minmax(0, 1fr); gap: 3px 8px; padding: 8px 10px;
        color: #8f98a0; background: rgba(15, 27, 39, 0.78);
        border-left: 2px solid #2a475e; border-radius: 3px;
        white-space: nowrap; font: 12px/1.35 Arial, Helvetica, sans-serif;
        pointer-events: none;
      }
      .${SCRIPT_ID}-result-title {
        grid-column: 1 / -1; margin-bottom: 1px; color: #8f98a0;
        font-size: 11px; letter-spacing: .04em;
      }
      .${SCRIPT_ID}-result-label { color: #71808d; }
      .${SCRIPT_ID}-result-value {
        min-width: 0; overflow: hidden; text-align: right; text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
      }
      .${SCRIPT_ID}-gross { color: #c7d5e0; }
      .${SCRIPT_ID}-net { color: #66c0f4; }
      .${SCRIPT_ID}-ratio { font-weight: 600; }
      .${SCRIPT_ID}-ratio.good { color: #8bc53f; }
      .${SCRIPT_ID}-ratio.warn { color: #e5b54b; }
      .${SCRIPT_ID}-ratio.bad { color: #e35e5e; }
      .${SCRIPT_ID}-ratio.missing { color: #8f98a0; }
      .${SCRIPT_ID}-result.${SCRIPT_ID}-message {
        grid-template-columns: 1fr; text-align: center;
      }
      .${SCRIPT_ID}-result.${SCRIPT_ID}-owned-result.${SCRIPT_ID}-message {
        grid-template-columns: 1fr;
      }
      #${SCRIPT_ID}-lowest-fallback {
        box-sizing: border-box; display: grid; grid-template-columns: 1fr auto;
        gap: 8px 18px; margin: 0 0 12px; padding: 16px 18px;
        color: #8f98a0; background: rgba(0, 0, 0, 0.2);
        border-left: 3px solid #66c0f4; font: 13px/1.4 Arial, Helvetica, sans-serif;
      }
      #${SCRIPT_ID}-lowest-fallback .${SCRIPT_ID}-fallback-title {
        color: #c7d5e0; font-size: 14px; font-weight: 600;
      }
      #${SCRIPT_ID}-lowest-fallback .${SCRIPT_ID}-fallback-values {
        display: flex; align-items: center; flex-wrap: wrap; gap: 8px 18px;
        font-variant-numeric: tabular-nums;
      }
      #${SCRIPT_ID}-lowest-fallback .${SCRIPT_ID}-fallback-note {
        grid-column: 1 / -1; color: #71808d; font-size: 11px;
      }
      .${SCRIPT_ID}-result.${SCRIPT_ID}-owned-result {
        position: absolute; top: 50%; right: calc(17% + 2px); width: 138px;
        max-width: none; margin: 0; padding: 4px 5px; transform: translateY(-50%);
        grid-template-columns: 14px minmax(0, 1fr) 14px minmax(0, 1fr);
        gap: 2px 3px; font-size: 10px; line-height: 1.25;
        pointer-events: auto;
      }
      .${SCRIPT_ID}-owned-result .${SCRIPT_ID}-result-title { display: none; }
      .${SCRIPT_ID}-owned-result .${SCRIPT_ID}-ratio {
        grid-column: auto; text-align: right;
      }
      .${SCRIPT_ID}-owned-buy {
        box-sizing: border-box; width: 100%; min-width: 0; height: 18px;
        padding: 0 4px; color: #fff; background: #0b141d;
        border: 1px solid #344c61; border-radius: 2px;
        font: 11px/18px Arial, Helvetica, sans-serif;
        font-variant-numeric: tabular-nums;
      }
      .${SCRIPT_ID}-owned-buy:focus {
        outline: none; border-color: #66c0f4;
      }
      @media (max-width: 760px) {
        #${SCRIPT_ID}-toolbar { align-items: stretch; }
        #${SCRIPT_ID}-toolbar .${SCRIPT_ID}-field { flex: 1 1 140px; }
        #${SCRIPT_ID}-toolbar input, #${SCRIPT_ID}-toolbar select { width: 100%; }
        .${SCRIPT_ID}-result {
          top: auto; right: auto; bottom: 6px; left: 136px; width: 250px;
          transform: none; grid-template-columns: 40px 1fr 40px 1fr;
          gap: 2px 6px; padding: 5px 8px;
        }
        .${SCRIPT_ID}-result-title { display: none; }
        .${SCRIPT_ID}-result.${SCRIPT_ID}-owned-result {
          position: absolute; right: calc(17% + 2px); left: auto; top: 50%;
          bottom: auto; width: 138px; margin: 0; transform: translateY(-50%);
        }
        .${SCRIPT_ID}-result .${SCRIPT_ID}-ratio-label { grid-column: 1; }
        .${SCRIPT_ID}-result .${SCRIPT_ID}-ratio { grid-column: 2 / -1; text-align: left; }
        #${SCRIPT_ID}-lowest-fallback { grid-template-columns: 1fr; }
        #${SCRIPT_ID}-lowest-fallback .${SCRIPT_ID}-fallback-note { grid-column: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  function createToolbar(currency) {
    const existing = document.getElementById(`${SCRIPT_ID}-toolbar`);
    if (existing) return existing;
    const results = document.getElementById("searchResults")
      || document.getElementById("searchResultsRows")?.parentElement
      || document.getElementById("myListings")
      || document.getElementById("tabContentsMyActiveMarketListings")?.parentElement;
    if (!results) return null;
    const currentItem = marketItem();

    const toolbar = document.createElement("div");
    toolbar.id = `${SCRIPT_ID}-toolbar`;
    toolbar.innerHTML = `
      <div class="${SCRIPT_ID}-field">
        <label>Steam 货币</label>
        <div class="${SCRIPT_ID}-source" title="${currency.detected ? "由 Steam 钱包货币编号自动识别" : "未检测到钱包货币，使用手动设置"}">
          ${currency.code}${currency.detected ? "（自动）" : "（手动）"}
        </div>
      </div>
      <div class="${SCRIPT_ID}-field">
        <label for="${SCRIPT_ID}-target">目标货币</label>
        <select id="${SCRIPT_ID}-target">
          ${TARGET_CURRENCIES.map((code) => `<option value="${code}">${code}</option>`).join("")}
        </select>
      </div>
      ${currentItem ? `
        <div class="${SCRIPT_ID}-field">
          <label for="${SCRIPT_ID}-buy">买入价（<span id="${SCRIPT_ID}-buy-code"></span>）</label>
          <input id="${SCRIPT_ID}-buy" type="number" min="0" step="0.01" inputmode="decimal" placeholder="填写总成本">
        </div>
      ` : ""}
      <div id="${SCRIPT_ID}-hint" class="${SCRIPT_ID}-hint"></div>
    `;
    if (results.id === "myListings") {
      results.parentElement.insertBefore(toolbar, results);
    } else {
      results.insertBefore(toolbar, results.firstChild);
    }

    const target = toolbar.querySelector(`#${SCRIPT_ID}-target`);
    const buy = toolbar.querySelector(`#${SCRIPT_ID}-buy`);
    target.value = settings.targetCurrency;

    function syncInputs() {
      const targetCode = target.value;
      const buyCode = toolbar.querySelector(`#${SCRIPT_ID}-buy-code`);
      if (buyCode) buyCode.textContent = targetCode;
      if (buy) buy.value = currentBuyPrice(targetCode, currentItem) ?? "";
      const state = rateStates.get(rateKey(currency.code, targetCode));
      toolbar.querySelector(`#${SCRIPT_ID}-hint`).textContent = state === "ready"
        ? currentItem
          ? `使用 Steam 自身的 ${targetCode} 换算`
          : `使用 Steam 自身的 ${targetCode} 换算；可在各物品卡片填写买入价`
        : `正在获取 Steam 的 ${targetCode} 换算…`;
    }

    target.addEventListener("change", () => {
      settings.targetCurrency = target.value;
      saveSettings();
      syncInputs();
      renderRows(currency);
      loadSteamRate(target.value, currency);
    });
    if (buy) {
      buy.addEventListener("input", () => {
        const value = Number(buy.value);
        const key = buyPriceKey(target.value, currentItem);
        if (key) GM_setValue(key, Number.isFinite(value) && value > 0 ? value : "");
        scheduleRender(currency);
      });
    }
    syncInputs();
    return toolbar;
  }

  function renderLowestFallback(currency, target, visibleListingCount) {
    const id = `${SCRIPT_ID}-lowest-fallback`;
    const existing = document.getElementById(id);
    const item = marketItem();
    const root = document.getElementById("searchResults")
      || document.getElementById("searchResultsRows")
      || document.body;
    const candidates = [...document.querySelectorAll(
      ".market_listing_table_message, div, p, span"
    )].filter((node) => isNoListingMessage(node.textContent))
      .sort((left, right) =>
        normalizeMessage(left.textContent).length
        - normalizeMessage(right.textContent).length
      );
    let messageBlock = candidates.find((node) =>
      node.classList?.contains("market_listing_table_message")
    ) || candidates[0] || null;

    if (messageBlock && root) {
      const messageText = normalizeMessage(messageBlock.textContent);
      while (
        messageBlock.parentElement
        && messageBlock.parentElement !== root
        && messageBlock.parentElement.id !== "searchResultsRows"
        && normalizeMessage(messageBlock.parentElement.textContent) === messageText
      ) {
        messageBlock = messageBlock.parentElement;
      }
    }

    const orderSpread = document.getElementById("market_commodity_order_spread");
    const fallbackParent = messageBlock?.parentElement || orderSpread;
    const fallbackAnchor = messageBlock || orderSpread?.firstElementChild || null;
    if (!item || !fallbackParent || visibleListingCount > 0) {
      existing?.remove();
      return;
    }

    const key = rateKey(currency.code, target);
    let lowest = steamLowestQuotes.get(key);
    if (!lowest || lowest.itemKey !== `${item.appid}:${item.marketHashName}`) {
      const sourceGross = readCachedLowest(currency.code, item);
      const rate = steamRates.get(key);
      const sourceNet = sellerNetFromGross(sourceGross);
      lowest = Number.isFinite(sourceGross) && sourceGross > 0
        && Number.isFinite(sourceNet) && sourceNet > 0
        && Number.isFinite(rate) && rate > 0
        ? {
          itemKey: `${item.appid}:${item.marketHashName}`,
          sourceGross,
          targetGross: sourceGross * rate,
          targetNet: sourceNet * rate,
          cached: true
        }
        : null;
      if (lowest) steamLowestQuotes.set(key, lowest);
    }
    if (!lowest) {
      existing?.remove();
      return;
    }

    const buyPrice = currentBuyPrice(target, item);
    const ratio = Number.isFinite(buyPrice) && buyPrice > 0
      && Number.isFinite(lowest.targetNet) && lowest.targetNet > 0
      ? buyPrice / lowest.targetNet * 100
      : null;
    const ratioText = Number.isFinite(ratio)
      ? `${ratio.toFixed(2)}%`
      : buyPrice
        ? "税后价不可用"
        : "未填买入价";
    const signature = JSON.stringify([
      lowest.targetGross, lowest.targetNet, buyPrice, target, ratio,
      lowest.cached, lowest.quoteSource
    ]);
    const fallback = existing || document.createElement("div");
    fallback.id = id;
    if (fallback.dataset.signature !== signature) {
      fallback.dataset.signature = signature;
      fallback.innerHTML = `
        <div class="${SCRIPT_ID}-fallback-title">Steam 市场最低售价参考</div>
        <div class="${SCRIPT_ID}-fallback-values">
          <span>含费最低 <strong class="${SCRIPT_ID}-gross">${formatMoney(lowest.targetGross, target)}</strong></span>
          <span>税后估算 <strong class="${SCRIPT_ID}-net">${formatMoney(lowest.targetNet, target)}</strong></span>
          <span>挂刀 <strong class="${SCRIPT_ID}-ratio ${ratioClass(ratio)}">${ratioText}</strong></span>
        </div>
        <div class="${SCRIPT_ID}-fallback-note">
          ${lowest.cached
            ? "最低售价来自已上架列表缓存；"
            : lowest.quoteSource === "orderbook"
              ? "最低售价来自 Steam 订单深度；"
              : "数据来自 Steam priceoverview；"}税后价按当前钱包手续费反推，卖单恢复后以实际挂单为准。
        </div>
      `;
    }
    if (
      fallback.parentElement !== fallbackParent
      || (fallbackAnchor && fallback.nextElementSibling !== fallbackAnchor)
    ) {
      fallbackParent.insertBefore(fallback, fallbackAnchor);
    }
  }

  function renderRows(currency) {
    const toolbar = document.getElementById(`${SCRIPT_ID}-toolbar`);
    if (!toolbar) return;
    const target = toolbar.querySelector(`#${SCRIPT_ID}-target`).value;
    const key = rateKey(currency.code, target);
    const rate = steamRates.get(key);
    const state = rateStates.get(key) || "loading";
    const visibleListingCount = [...document.querySelectorAll(
      "#searchResultsRows .market_listing_row"
    )].filter((row) =>
      row.getClientRects().length > 0 && listingAmounts(row, currency.code)
    ).length;

    document.querySelectorAll(
      "#searchResultsRows .market_listing_row, "
      + "#tabContentsMyActiveMarketListingsRows .market_listing_row, "
      + '#myListings .market_listing_row[id^="mylisting_"]'
    ).forEach((row) => {
      const amounts = listingAmounts(row, currency.code);
      if (!amounts) return;
      const { gross, net } = amounts;
      const owned = Boolean(row.closest(
        "#tabContentsMyActiveMarketListingsRows, #myListings"
      ));
      const rowItem = marketItemFromRow(row) || marketItem();
      if (owned && rowItem) {
        const minimum = row.querySelector(".market_listing_minimum--text")
          || row.querySelector(".market_listing_minimum");
        const minimumPrice = parsePrice(minimum?.textContent || "", currency.code);
        writeCachedLowest(currency.code, rowItem, minimumPrice);
      }
      const buyPrice = currentBuyPrice(target, rowItem);
      const resultHost = row;
      let result = row.querySelector(`.${SCRIPT_ID}-result`);
      if (!result) {
        result = document.createElement("div");
        result.className = `${SCRIPT_ID}-result`;
        resultHost.appendChild(result);
      } else if (result.parentElement !== resultHost) {
        resultHost.appendChild(result);
      }
      result.classList.toggle(`${SCRIPT_ID}-owned-result`, owned);

      const quote = Number.isFinite(rate)
        ? calculateQuote(gross * rate, net * rate, buyPrice)
        : null;
      const signature = JSON.stringify([gross, net, rate, buyPrice, target, state]);
      if (result.dataset.signature === signature) return;
      result.dataset.signature = signature;

      if (!quote) {
        result.classList.add(`${SCRIPT_ID}-message`);
        const message = state === "error"
          ? "Steam 换算获取失败"
          : state === "ready"
            ? "Steam 换算数据不可用"
            : "正在获取 Steam 换算…";
        result.innerHTML = `
          <span class="${SCRIPT_ID}-result-title">${target} 折合</span>
          <span class="${SCRIPT_ID}-ratio missing">${message}</span>
        `;
        return;
      }
      result.classList.remove(`${SCRIPT_ID}-message`);
      const ratioText = Number.isFinite(quote.ratio)
        ? `${quote.ratio.toFixed(2)}%`
        : "—";
      if (owned) {
        result.innerHTML = `
          <span class="${SCRIPT_ID}-result-label" title="买家含费价">含</span>
          <span class="${SCRIPT_ID}-result-value ${SCRIPT_ID}-gross">${formatMoney(quote.convertedGross, target)}</span>
          <span class="${SCRIPT_ID}-result-label" title="卖家到账价">到</span>
          <span class="${SCRIPT_ID}-result-value ${SCRIPT_ID}-net">${formatMoney(quote.convertedNet, target)}</span>
          <span class="${SCRIPT_ID}-result-label" title="买入成本">买</span>
          <input class="${SCRIPT_ID}-owned-buy" type="number" min="0" step="0.01" inputmode="decimal" aria-label="${target} 买入价">
          <span class="${SCRIPT_ID}-result-label" title="挂刀比例">刀</span>
          <span class="${SCRIPT_ID}-result-value ${SCRIPT_ID}-ratio ${ratioClass(quote.ratio)}">${ratioText}</span>
        `;
        const buyInput = result.querySelector(`.${SCRIPT_ID}-owned-buy`);
        const priceKey = buyPriceKey(target, rowItem);
        buyInput.value = buyPrice ?? "";
        buyInput.placeholder = priceKey ? "填写" : "无法识别";
        buyInput.disabled = !priceKey;
        buyInput.addEventListener("click", (event) => event.stopPropagation());
        buyInput.addEventListener("keydown", (event) => {
          event.stopPropagation();
          if (event.key === "Enter") buyInput.blur();
        });
        buyInput.addEventListener("change", () => {
          if (!priceKey) return;
          const value = Number(buyInput.value);
          GM_setValue(priceKey, Number.isFinite(value) && value > 0 ? value : "");
          scheduleRender(currency);
        });
      } else {
        result.innerHTML = `
          <span class="${SCRIPT_ID}-result-title">${target} 折合</span>
          <span class="${SCRIPT_ID}-result-label">含费</span>
          <span class="${SCRIPT_ID}-result-value ${SCRIPT_ID}-gross">${formatMoney(quote.convertedGross, target)}</span>
          <span class="${SCRIPT_ID}-result-label">到账</span>
          <span class="${SCRIPT_ID}-result-value ${SCRIPT_ID}-net">${formatMoney(quote.convertedNet, target)}</span>
          <span class="${SCRIPT_ID}-result-label ${SCRIPT_ID}-ratio-label">挂刀</span>
          <span class="${SCRIPT_ID}-result-value ${SCRIPT_ID}-ratio ${ratioClass(quote.ratio)}">${ratioText}</span>
        `;
      }
    });
    renderLowestFallback(currency, target, visibleListingCount);
  }

  function scheduleRender(currency) {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => renderRows(currency), 80);
  }

  function init() {
    addStyles();
    const currency = detectCurrency();
    settings.manualSourceCurrency = currency.code;
    saveSettings();

    const tryMount = () => {
      const toolbar = createToolbar(currency);
      renderRows(currency);
      if (toolbar) {
        const target = toolbar.querySelector(`#${SCRIPT_ID}-target`).value;
        loadSteamRate(target, currency);
      }
    };
    tryMount();
    observer = new MutationObserver(() => {
      if (!document.getElementById(`${SCRIPT_ID}-toolbar`)) tryMount();
      scheduleRender(currency);
      const target = document.getElementById(`${SCRIPT_ID}-target`)?.value;
      if (target) loadSteamRate(target, currency);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
