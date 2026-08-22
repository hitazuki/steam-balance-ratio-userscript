// ==UserScript==
// @name         Steam 市场货币换算与挂刀比例
// @namespace    https://github.com/hitazuki/steam-balance-ratio-userscript
// @version      0.2.0
// @description  使用 Steam 自身的货币换算，在饰品挂单旁显示目标货币金额和税后挂刀比例。
// @author       hitazuki
// @license      MIT
// @homepageURL  https://github.com/hitazuki/steam-balance-ratio-userscript
// @supportURL   https://github.com/hitazuki/steam-balance-ratio-userscript/issues
// @compatible   chrome
// @compatible   edge
// @compatible   firefox
// @match        https://steamcommunity.com/market/listings/*/*
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

  // Allow dependency-free Node tests to import the pure calculation helpers.
  if (typeof document === "undefined" && typeof module !== "undefined" && module.exports) {
    module.exports = {
      calculateQuote,
      calculateSteamRate,
      currencyCodeFromId,
      parsePrice,
      ratioClass
    };
    return;
  }

  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  let renderTimer = null;
  let observer = null;
  const steamRates = new Map();
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

  function itemKey() {
    const match = location.pathname.match(/^\/market\/listings\/(\d+)\/(.+)$/);
    if (!match) return location.pathname;
    return `${match[1]}:${decodeURIComponent(match[2])}`;
  }

  function marketItem() {
    const match = location.pathname.match(/^\/market\/listings\/(\d+)\/(.+)$/);
    if (!match) return null;
    return { appid: match[1], marketHashName: decodeURIComponent(match[2]) };
  }

  function buyPriceKey(targetCurrency) {
    return `${SCRIPT_ID}:buy:${itemKey()}:${targetCurrency}`;
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

  function currentBuyPrice(target) {
    const value = Number(GM_getValue(buyPriceKey(target), ""));
    return Number.isFinite(value) && value > 0 ? value : null;
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

  function updateConversionHint(targetCurrency, text, isError = false) {
    const hint = document.getElementById(`${SCRIPT_ID}-hint`);
    const target = document.getElementById(`${SCRIPT_ID}-target`);
    if (!hint || target?.value !== targetCurrency) return;
    hint.textContent = text;
    hint.style.color = isError ? "#e35e5e" : "";
  }

  async function loadSteamRate(targetCurrency, currency) {
    const key = rateKey(currency.code, targetCurrency);
    const existing = rateStates.get(key);
    if (existing === "loading" || existing === "ready") return;
    if (currency.code === targetCurrency) {
      steamRates.set(key, 1);
      rateStates.set(key, "ready");
      updateConversionHint(targetCurrency, `Steam ${targetCurrency} 无需换算`);
      renderRows(currency);
      return;
    }
    const sourceCurrencyId = CURRENCY_ID_BY_CODE[currency.code];
    const targetCurrencyId = CURRENCY_ID_BY_CODE[targetCurrency];
    const item = marketItem();
    if (!sourceCurrencyId || !targetCurrencyId || !item) {
      rateStates.set(key, "error");
      updateConversionHint(targetCurrency, "无法构造 Steam 货币换算请求", true);
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
      const [sourceResponse, targetResponse] = await Promise.all([
        fetch(priceUrl(sourceCurrencyId), { credentials: "include" }),
        fetch(priceUrl(targetCurrencyId), { credentials: "include" })
      ]);
      if (!sourceResponse.ok || !targetResponse.ok) {
        throw new Error(`HTTP ${sourceResponse.status}/${targetResponse.status}`);
      }
      const [sourceData, targetData] = await Promise.all([
        sourceResponse.json(),
        targetResponse.json()
      ]);
      const sourcePrice = parsePrice(sourceData.lowest_price || "", currency.code);
      const targetPrice = parsePrice(targetData.lowest_price || "", targetCurrency);
      if (!sourceData.success || !targetData.success || !sourcePrice || !targetPrice) {
        throw new Error("Steam 未返回最低售价");
      }
      const rate = calculateSteamRate(sourcePrice, targetPrice);
      if (!rate) throw new Error("Steam 换算率无效");
      steamRates.set(key, rate);
      rateStates.set(key, "ready");
      updateConversionHint(
        targetCurrency,
        `Steam 换算：1 ${currency.code} ≈ ${rate.toFixed(6)} ${targetCurrency}`
      );
    } catch (error) {
      rateStates.set(key, "error");
      updateConversionHint(
        targetCurrency,
        `Steam 换算获取失败：${error.message || error}`,
        true
      );
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
      || row.querySelector(".market_listing_their_price");
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
      .${SCRIPT_ID}-result { margin-top: 4px; white-space: nowrap; font-size: 12px; line-height: 1.45; }
      .${SCRIPT_ID}-gross { color: #8f98a0; }
      .${SCRIPT_ID}-net { color: #66c0f4; }
      .${SCRIPT_ID}-ratio { font-weight: 600; }
      .${SCRIPT_ID}-ratio.good { color: #8bc53f; }
      .${SCRIPT_ID}-ratio.warn { color: #e5b54b; }
      .${SCRIPT_ID}-ratio.bad { color: #e35e5e; }
      .${SCRIPT_ID}-ratio.missing { color: #8f98a0; }
      @media (max-width: 760px) {
        #${SCRIPT_ID}-toolbar { align-items: stretch; }
        #${SCRIPT_ID}-toolbar .${SCRIPT_ID}-field { flex: 1 1 140px; }
        #${SCRIPT_ID}-toolbar input, #${SCRIPT_ID}-toolbar select { width: 100%; }
      }
    `;
    document.head.appendChild(style);
  }

  function createToolbar(currency) {
    const existing = document.getElementById(`${SCRIPT_ID}-toolbar`);
    if (existing) return existing;
    const results = document.getElementById("searchResults")
      || document.getElementById("searchResultsRows")?.parentElement;
    if (!results) return null;

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
      <div class="${SCRIPT_ID}-field">
        <label for="${SCRIPT_ID}-buy">买入价（<span id="${SCRIPT_ID}-buy-code"></span>）</label>
        <input id="${SCRIPT_ID}-buy" type="number" min="0" step="0.01" inputmode="decimal" placeholder="填写总成本">
      </div>
      <div id="${SCRIPT_ID}-hint" class="${SCRIPT_ID}-hint"></div>
    `;
    results.insertBefore(toolbar, results.firstChild);

    const target = toolbar.querySelector(`#${SCRIPT_ID}-target`);
    const buy = toolbar.querySelector(`#${SCRIPT_ID}-buy`);
    target.value = settings.targetCurrency;

    function syncInputs() {
      const targetCode = target.value;
      toolbar.querySelector(`#${SCRIPT_ID}-buy-code`).textContent = targetCode;
      buy.value = currentBuyPrice(targetCode) ?? "";
      const state = rateStates.get(rateKey(currency.code, targetCode));
      toolbar.querySelector(`#${SCRIPT_ID}-hint`).textContent = state === "ready"
        ? `使用 Steam 自身的 ${targetCode} 换算`
        : `正在获取 Steam 的 ${targetCode} 换算…`;
    }

    target.addEventListener("change", () => {
      settings.targetCurrency = target.value;
      saveSettings();
      syncInputs();
      renderRows(currency);
      loadSteamRate(target.value, currency);
    });
    buy.addEventListener("input", () => {
      const value = Number(buy.value);
      GM_setValue(buyPriceKey(target.value), Number.isFinite(value) && value > 0 ? value : "");
      scheduleRender(currency);
    });
    syncInputs();
    return toolbar;
  }

  function renderRows(currency) {
    const toolbar = document.getElementById(`${SCRIPT_ID}-toolbar`);
    if (!toolbar) return;
    const target = toolbar.querySelector(`#${SCRIPT_ID}-target`).value;
    const buyPrice = currentBuyPrice(target);
    const key = rateKey(currency.code, target);
    const rate = steamRates.get(key);
    const state = rateStates.get(key) || "loading";

    document.querySelectorAll("#searchResultsRows .market_listing_row").forEach((row) => {
      const amounts = listingAmounts(row, currency.code);
      if (!amounts) return;
      const { gross, net, host } = amounts;
      let result = host.querySelector(`.${SCRIPT_ID}-result`);
      if (!result) {
        result = document.createElement("div");
        result.className = `${SCRIPT_ID}-result`;
        host.appendChild(result);
      }

      const quote = Number.isFinite(rate)
        ? calculateQuote(gross * rate, net * rate, buyPrice)
        : null;
      const signature = JSON.stringify([gross, net, rate, buyPrice, target, state]);
      if (result.dataset.signature === signature) return;
      result.dataset.signature = signature;

      if (!quote) {
        const message = state === "error"
          ? "Steam 换算获取失败"
          : state === "ready"
            ? "Steam 换算数据不可用"
            : "正在获取 Steam 换算…";
        result.innerHTML = `<span class="${SCRIPT_ID}-ratio missing">${message}</span>`;
        return;
      }
      const ratioText = Number.isFinite(quote.ratio) ? `${quote.ratio.toFixed(2)}%` : "—";
      result.innerHTML = `
        <div class="${SCRIPT_ID}-gross">含费折合 ${formatMoney(quote.convertedGross, target)}</div>
        <div class="${SCRIPT_ID}-net">到账折合 ${formatMoney(quote.convertedNet, target)}</div>
        <div class="${SCRIPT_ID}-ratio ${ratioClass(quote.ratio)}">挂刀比例 ${ratioText}</div>
      `;
    });
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
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
