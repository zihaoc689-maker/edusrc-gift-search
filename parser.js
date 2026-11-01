const ORIGIN = "https://src.sjtu.edu.cn";
const MAX_ID = 100000;

function clean(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function documentFrom(html) {
  if (typeof html !== "string" || !html.trim()) {
    throw new Error("页面内容为空，无法解析礼品信息。");
  }
  // This detached document is only read. Never insert remote nodes into the UI.
  // The extension CSP blocks image/frame loading from parsed remote markup.
  return new DOMParser().parseFromString(html, "text/html");
}

function numericField(text, label, { integer = false, unit = "" } = {}) {
  const value = clean(text);
  const digits = integer ? "([0-9]+)" : "([0-9]+(?:\\.[0-9]+)?)";
  const match = value.match(new RegExp(`^${digits}\\s*(?:${unit})?$`, "u"));
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isSafeInteger(number))) {
    throw new Error(`礼品页面的“${label}”不是有效的非负数字，页面结构可能已变化。`);
  }
  return number;
}

export function giftUrl(id) {
  if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_ID) {
    throw new Error(`礼品 ID 必须是 1 到 ${MAX_ID} 的整数。`);
  }
  return `${ORIGIN}/gift/${id}/`;
}

export function getGiftId(input) {
  try {
    const url = new URL(input, `${ORIGIN}/`);
    if (url.origin !== ORIGIN || url.username || url.password) return null;
    const match = url.pathname.match(/^\/gift\/([1-9][0-9]*)\/?$/u);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id <= MAX_ID ? id : null;
  } catch {
    return null;
  }
}

export function parseDetail(html, id, checkedAt = new Date().toISOString()) {
  const url = giftUrl(id);
  const document = documentFrom(html);
  const fields = new Map();
  for (const row of document.querySelectorAll(".main-content .am-g")) {
    const children = Array.from(row.children);
    const label = children.find(child => child.classList.contains("am-u-sm-2"));
    const value = children.find(child => child.classList.contains("am-u-sm-10"));
    if (!label || !value) continue;
    const key = clean(label.textContent).replace(/[：:]$/u, "").trim();
    fields.set(key, clean(value.textContent));
  }
  const name = fields.get("名称");
  if (!name || !fields.has("剩余数量") || !fields.has("价格")) {
    throw new Error("未找到礼品名称、剩余数量或价格；可能遇到登录页、验证页，或页面结构已变化。");
  }
  const stock = numericField(fields.get("剩余数量"), "剩余数量", { integer: true, unit: "个" });
  const price = numericField(fields.get("价格"), "价格", { unit: "金币" });
  const description = [
    fields.get("描述"),
    fields.get("兑换限制") ? `兑换限制：${fields.get("兑换限制")}` : "",
  ].filter(Boolean).join("\n");
  return {
    id,
    name,
    stock,
    price,
    description,
    source: fields.get("来源") || "",
    certificate: /证书/u.test(name),
    checkedAt,
    url,
  };
}

export function parseListing(html, baseUrl) {
  const base = new URL(baseUrl, `${ORIGIN}/gift/`);
  if (base.origin !== ORIGIN || !/^\/gift\/?$/u.test(base.pathname)) {
    throw new Error("礼品列表地址必须是教育漏洞报告平台的 /gift/ 页面。");
  }
  const document = documentFrom(html);
  const listing = document.querySelector(".main-content .am-thumbnails");
  if (!listing) {
    throw new Error("未找到礼品列表；可能遇到登录页、验证页，或页面结构已变化。");
  }
  const checkedAt = new Date().toISOString();
  const giftsById = new Map();
  for (const card of listing.querySelectorAll(".pic")) {
    const links = Array.from(card.querySelectorAll(".pic-caption a[href]"));
    let nameLink;
    let id;
    for (const link of links) {
      try {
        const candidateId = getGiftId(new URL(link.getAttribute("href"), base));
        if (candidateId !== null) {
          nameLink = link;
          id = candidateId;
          break;
        }
      } catch {
        // Skip malformed links without dropping other valid cards.
      }
    }
    if (!nameLink) continue;
    const name = clean(nameLink.textContent);
    const stockText = links.map(link => clean(link.textContent)).find(value => /^剩余数量\s*[：:]/u.test(value));
    const priceText = links.map(link => clean(link.textContent)).find(value => /^价格\s*[：:]/u.test(value));
    if (!name || stockText === undefined || priceText === undefined) {
      throw new Error("礼品列表缺少名称、剩余数量或价格，页面结构可能已变化。");
    }
    const stock = numericField(stockText.replace(/^剩余数量\s*[：:]\s*/u, ""), "剩余数量", { integer: true, unit: "个" });
    const price = numericField(priceText.replace(/^价格\s*[：:]\s*/u, ""), "价格", { unit: "金币" });
    giftsById.set(id, {
      id, name, stock, price, description: "", source: "",
      certificate: /证书/u.test(name), checkedAt, url: giftUrl(id),
    });
  }
  const type = base.searchParams.get("gift_type") || "certificate";
  const order = base.searchParams.get("order");
  const pages = new Set();
  for (const link of document.querySelectorAll(".am-pagination a[href]")) {
    try {
      const target = new URL(link.getAttribute("href"), base);
      if (target.origin !== ORIGIN || target.username || target.password || !/^\/gift\/?$/u.test(target.pathname)) continue;
      const page = target.searchParams.get("page");
      if (!page || !/^[1-9][0-9]*$/u.test(page) || Number(page) > 100000) continue;
      const canonical = new URL(`${ORIGIN}/gift/`);
      canonical.searchParams.set("page", page);
      canonical.searchParams.set("gift_type", type);
      if (order !== null && /^[012]$/u.test(order)) canonical.searchParams.set("order", order);
      pages.add(canonical.href);
    } catch {
      // A malformed or unrelated href is never a scan target.
    }
  }
  const gifts = Array.from(giftsById.values());
  return { gifts, maxId: gifts.reduce((max, gift) => Math.max(max, gift.id), 0), pages: Array.from(pages) };
}
