const IMAGE_HOSTS = new Set(["menu-img.mcd.cn", "img.mcd.cn", "cms-cdn.mcd.cn"]);

export function officialImageUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.port || !IMAGE_HOSTS.has(url.hostname)) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

export function storeMapUrl(store) {
  if (!store || typeof store.storeName !== "string" || !store.storeName.trim()) return null;
  const address = typeof store.address === "string" ? store.address.trim() : "";
  const url = new URL("https://uri.amap.com/search");
  url.searchParams.set("keyword", `${store.storeName.trim()} ${address}`.trim());
  if (typeof store.city === "string" && store.city.trim()) url.searchParams.set("city", store.city.trim());
  url.searchParams.set("view", "map");
  url.searchParams.set("src", "mcd-bagdesk");
  url.searchParams.set("callnative", "0");
  return url.href;
}
