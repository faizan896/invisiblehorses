import { readFileSync } from 'node:fs';
import { Counterparties as Profiles } from 'payroute/counterparty/profiles';
export { CounterpartySchema, type Counterparty } from 'payroute/counterparty/profiles';
export class Counterparties extends Profiles {
  static load(path: string) { return Profiles.from(() => JSON.parse(readFileSync(path, 'utf8')) as unknown); }
}
