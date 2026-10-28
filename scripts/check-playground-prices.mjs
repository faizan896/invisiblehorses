// Refresh only the ECB reference snapshot. Fees remain explicit provider assumptions.
import { writeFile } from "node:fs/promises";
const source = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`ECB returned ${response.status}`);
const xml = await response.text();
const date = xml.match(/time=['"]([\d-]+)['"]/)?.[1];
const rates = Object.fromEntries(
  [...xml.matchAll(/currency=['"]([A-Z]+)['"] rate=['"]([\d.]+)['"]/g)].map(
    (x) => [x[1], Number(x[2])],
  ),
);
if (
  !date ||
  !Number.isFinite(rates.USD) ||
  !Number.isFinite(rates.MXN) ||
  rates.USD <= 0 ||
  rates.MXN <= 0
)
  throw new Error("ECB reference response is incomplete");
const snapshot = {
  date,
  mxn: Number((rates.MXN / rates.USD).toFixed(6)),
  eur: Number((1 / rates.USD).toFixed(6)),
  source,
};
await writeFile(
  new URL("../packages/payroute/playground/reference.json", import.meta.url),
  JSON.stringify(snapshot, null, 2) + "\n",
);
console.log(
  `ECB reference refreshed for ${date}. Review all public rules before updating the prices-last-checked date in model.ts.`,
);
