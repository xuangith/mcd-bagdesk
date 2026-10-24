import { RoomError } from "./room.mjs";

function coordinate(text) {
  if (typeof text !== "string" || !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(text)) {
    throw new RoomError("LOCATION_FORMAT", "地图服务未返回有效坐标。", 502);
  }
  const [longitude, latitude] = text.split(",").map(Number);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 ||
      Math.abs(latitude) > 90 || (longitude === 0 && latitude === 0)) {
    throw new RoomError("LOCATION_FORMAT", "地图服务坐标超出有效范围。", 502);
  }
  return { longitude, latitude };
}

export function straightDistance(a, b) {
  const rad = (degrees) => degrees * Math.PI / 180;
  const deltaLat = rad(b.latitude - a.latitude), deltaLon = rad(b.longitude - a.longitude);
  const value = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(deltaLon / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, value)), Math.sqrt(Math.max(0, 1 - value))));
}

export function createLocator({ key, request = fetch } = {}) {
  if (!key) return null;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new RoomError("MAP_KEY_FORMAT", "地图服务Key格式无效，请检查服务端配置。", 500);
  }
  const call = async (path, parameters) => {
    const url = new URL(`https://restapi.amap.com/v3/${path}`);
    url.search = new URLSearchParams({ ...parameters, key, output: "JSON" }).toString();
    try {
      const response = await request(url.href, { redirect: "error", signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error();
      const text = await response.text();
      if (text.length > 1_000_000) throw new Error();
      const data = JSON.parse(text);
      if (data.status !== "1") throw new Error();
      return data;
    } catch {
      // Provider errors may contain the full request URL and key; never echo them.
      throw new RoomError("MAP_UNAVAILABLE", "地图服务暂不可用，请检查Key或改用收藏餐厅、地标查询。", 502);
    }
  };
  return {
    async nearby(directory, input) {
      if (input.consent !== true || !Number.isFinite(input.longitude) || !Number.isFinite(input.latitude) ||
          Math.abs(input.longitude) > 180 || Math.abs(input.latitude) > 90 ||
          !Number.isFinite(input.accuracy) || input.accuracy < 0 || input.accuracy > 5000) {
        throw new RoomError("LOCATION_REQUIRED", "需要本次授权的有效位置；定位范围过大时请改用附近地标。", 400);
      }
      const gps = `${input.longitude.toFixed(6)},${input.latitude.toFixed(6)}`;
      const conversion = await call("assistant/coordinate/convert", { locations: gps, coordsys: "gps" });
      const origin = coordinate(conversion.locations);
      const reverse = await call("geocode/regeo", {
        location: `${origin.longitude.toFixed(6)},${origin.latitude.toFixed(6)}`, extensions: "base",
      });
      const address = reverse.regeocode;
      const parts = address?.addressComponent;
      const city = typeof parts?.city === "string" && parts.city ? parts.city : parts?.province;
      const keyword = address?.formatted_address;
      if (typeof city !== "string" || !city || typeof keyword !== "string" || !keyword || keyword.length > 80) {
        throw new RoomError("LOCATION_ADDRESS", "未能识别可查询的城市和附近地点，请改用地标查询。", 502);
      }
      const stores = await directory.search(city, keyword);
      const measured = [];
      for (const store of stores.slice(0, 10)) {
        let distanceMeters = null;
        try {
          const geocode = await call("geocode/geo", {
            address: `${store.storeName} ${store.address}`.trim(), city,
          });
          const hit = geocode.geocodes?.length === 1 ? geocode.geocodes[0] : null;
          if (hit && ["兴趣点", "门牌号", "门址", "住宅区", "公交地铁站点"].includes(hit.level)) {
            distanceMeters = straightDistance(origin, coordinate(hit.location));
          }
        } catch {
          // Missing store coordinates are an explicit unknown, not zero metres.
        }
        const next = {
          ...store, distanceMeters,
          distanceLabel: distanceMeters === null ? "门店坐标未确认，距离待核实" :
            `距授权位置直线约 ${distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} 公里` : `${Math.round(distanceMeters / 10) * 10} 米`}`,
          distanceBasis: "authorized-position-straight-line",
        };
        directory.stores.set(next.selectionKey, next);
        measured.push(next);
      }
      measured.sort((a, b) => Number(b.businessStatus) - Number(a.businessStatus) ||
        (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
      return {
        stores: measured,
        location: {
          city, area: typeof parts.district === "string" ? parts.district : "",
          accuracyMeters: Math.ceil(input.accuracy),
          distanceNote: "直线距离参考，不是步行或驾车路线；位置仅用于本次查店。",
        },
      };
    },
  };
}
