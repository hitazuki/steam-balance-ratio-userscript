# Steam 市场货币换算与挂刀比例

`steam-balance-ratio.user.js` 是一个无后端依赖的油猴脚本，只在浏览器版 Steam
饰品详情页运行。它通过 Steam 市场 `priceoverview` 接口分别读取钱包货币与目标货币
下的最低售价，由 Steam 返回值计算换算率，再换算每条挂单的买家含费价与卖家税后
到账价。用户只需用目标货币填写买入价，不需要手填汇率。

## 安装

1. 在 Chrome、Edge 或 Firefox 安装 Tampermonkey。
2. 打开 [Greasy Fork 脚本页面](https://greasyfork.org/zh-CN/scripts/592475-steam-%E5%B8%82%E5%9C%BA%E8%B4%A7%E5%B8%81%E6%8D%A2%E7%AE%97%E4%B8%8E%E6%8C%82%E5%88%80%E6%AF%94%E4%BE%8B)
   并点击“安装此脚本”；也可以从 [GitHub Raw 地址](https://raw.githubusercontent.com/hitazuki/steam-balance-ratio-userscript/main/steam-balance-ratio.user.js)
   直接安装。
3. 登录浏览器版 Steam，打开形如
   `https://steamcommunity.com/market/listings/730/...` 的饰品页面。

脚本优先通过 Steam 的 `g_rgWalletInfo.wallet_currency` 识别钱包货币。菲律宾比索的
Steam 货币编号是 `12`，脚本会显示为 ISO 代码 `PHP`，不会根据页面中可能显示成 `P`
的符号进行猜测。

## 使用

- 选择目标货币，例如 `CNY`。
- 用目标货币填写该饰品的买入总成本。

每条挂单下方会显示含费折合价、税后到账折合价和挂刀比例：

```text
挂刀比例 = 买入价 / Steam 税后到账折合价 × 100%
```

目标货币全局保存在 Tampermonkey 本地存储中；买入价按
`appid + market_hash_name + 目标货币` 分别保存。脚本不请求第三方平台，不读取或保存
Steam Cookie、会话令牌和钱包余额。

当前版本只处理页面挂单列表，不修改求购区、历史图表或 Steam 客户端内置页面。

## 本地验证

项目不需要安装 npm 依赖，使用 Node.js 直接检查：

```bash
node --check steam-balance-ratio.user.js
node tests/steam-balance-ratio.test.cjs
```

## 发布

每次修改脚本后递增头部的 `@version`，通过测试并推送 `main`。Greasy Fork 可以直接
同步上述 Raw 地址。通过 Greasy Fork 安装的版本由 Greasy Fork 自身管理更新地址。

## 许可证

[MIT](LICENSE)
