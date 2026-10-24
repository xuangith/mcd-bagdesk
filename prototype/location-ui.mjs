export async function requestBrowserPosition() {
  if (!window.isSecureContext || !navigator.geolocation) {
    throw new Error("当前浏览器地址不支持安全定位。请在点餐员电脑的 localhost 页面打开，或选择收藏餐厅。");
  }
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    (position) => resolve({
      consent: true, latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
    }),
    (error) => reject(new Error(error.code === 1
      ? "你没有授权位置访问。可以继续选择收藏餐厅或已有配送地址。"
      : "未能取得当前位置，请选择附近地标或稍后再试。")),
    { enableHighAccuracy: false, maximumAge: 0, timeout: 10000 },
  ));
}
