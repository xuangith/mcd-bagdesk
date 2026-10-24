import { h } from "./render.mjs";
import { officialImageUrl } from "./place-media.mjs";

export function menuPhoto(item, eager = false) {
  const url = officialImageUrl(item.imageUrl);
  const fallback = h("span", { class: "menu-photo-fallback" }, "暂无官方图片");
  const frame = h("div", { class: "menu-photo" }, fallback);
  if (!url) return frame;
  const image = h("img", {
    src: url, alt: item.name, width: 320, height: 240,
    loading: eager ? "eager" : "lazy", decoding: "async", referrerpolicy: "no-referrer",
  });
  const loaded = () => { fallback.hidden = true; frame.classList.add("is-loaded"); };
  image.addEventListener("load", loaded, { once: true });
  image.addEventListener("error", () => {
    image.remove();
    fallback.textContent = "图片暂时无法加载";
    fallback.hidden = false;
    frame.classList.remove("is-loaded");
  }, { once: true });
  frame.append(image);
  if (image.complete && image.naturalWidth > 0) loaded();
  return frame;
}
