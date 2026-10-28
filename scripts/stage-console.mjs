import { cpSync, mkdirSync, rmSync } from "node:fs";
const target = new URL("../public/app/", import.meta.url);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(new URL("../console/dist/", import.meta.url), target, {
  recursive: true,
});
cpSync(
  new URL("../console/landing.html", import.meta.url),
  new URL("../public/index.html", import.meta.url),
);
console.log(
  "Console staged at public/app/ and product page at public/index.html",
);
