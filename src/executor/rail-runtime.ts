import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { keccak256, type Hex } from 'viem';
import { StoreCore as Store } from '../audit/store-core.js';
import { Counterparties, CounterpartySchema } from '../counterparty/profiles.js';
import { PaymentIntentV2Schema } from '../intent/routing.js';
import { decimal, minor, type PaymentIntent } from '../intent/schema.js';
import { fingerprint } from '../intent/fingerprint.js';
import { RouteQuoteSchema, type QuoteContext, type RailExecution, type RailExecutionBackend, type RailId, type RouteQuote } from '../rails/adapter.js';
import type { TestnetExecutor } from '../rails/testnet.js';
import { RouteFailure, WalletBusy } from './state.js';
import { MODEL_FX } from '../rails/pricing.js';

type Native = { executor: TestnetExecutor; address: Hex; balanceMinor: () => Promise<number>; returnExecutor?: TestnetExecutor; returnAddress?: Hex };
type Op = { id: string; operation_key: string; fingerprint: string; rail: RailId; state: string; context: string; quote: string; source: string; raw: Hex | null; hash: Hex | null; return_raw: Hex | null; return_hash: Hex | null; payout_done: number; reason: string | null; created_at: string };
const ContextSchema = z.object({ intent: PaymentIntentV2Schema, payer: CounterpartySchema, recipient: CounterpartySchema, now: z.iso.datetime() });
export class RailRuntime implements RailExecutionBackend {
  authorize?: (paymentId: string, context: QuoteContext, quote: RouteQuote) => void;
  readonly failures = new Map<RailId, 'before-submit' | 'unknown-after-submit' | 'fx-exposure'>();
  constructor(readonly store: Store, readonly profiles: Counterparties, readonly payerId: string, readonly native: Native, private readonly clock: () => Date = () => new Date(), seedUsd = 10000) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS test_rail_accounts(account TEXT NOT NULL, currency TEXT NOT NULL, balance_minor INTEGER NOT NULL CHECK(balance_minor >= 0), PRIMARY KEY(account,currency));
      CREATE TABLE IF NOT EXISTS test_rail_holds(payment_id TEXT PRIMARY KEY, source TEXT NOT NULL, amount_minor INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rail_operations(id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, rail TEXT NOT NULL, state TEXT NOT NULL, context TEXT NOT NULL, quote TEXT NOT NULL, source TEXT NOT NULL, raw TEXT, hash TEXT, return_raw TEXT, return_hash TEXT, payout_done INTEGER NOT NULL DEFAULT 0, reason TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS test_rail_journal(id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), created_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS journal_no_update BEFORE UPDATE ON test_rail_journal BEGIN SELECT RAISE(ABORT,'journal is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS journal_no_delete BEFORE DELETE ON test_rail_journal BEGIN SELECT RAISE(ABORT,'journal is append-only'); END;
    `);
    const payer = profiles.get(payerId);
    store.transaction(() => {
      this.seed(this.source('ledger', { payer } as QuoteContext), 'USD', seedUsd);
      this.seed(this.source('ach-mock', { payer } as QuoteContext), 'USD', seedUsd);
      for (const currency of ['USD', 'MXN', 'EUR']) this.seed('test:fx-treasury', currency, 100000000);
    });
  }
  private now() { return this.clock().toISOString(); }
  private seed(account: string, currency: string, amount: number) {
    const result = this.store.db.prepare('INSERT OR IGNORE INTO test_rail_accounts VALUES(?,?,?)').run(account, currency, amount);
    if (result.changes && amount) this.store.audit(null, 'test_balance_initialized', 'owner:setup', { account, currency, amount: decimal(amount), simulated: true }, this.now());
  }
  balance(account: string, currency = 'USD') {
    return (this.store.db.prepare('SELECT balance_minor FROM test_rail_accounts WHERE account = ? AND currency = ?').get(account, currency) as { balance_minor: number } | undefined)?.balance_minor ?? 0;
  }
  private source(rail: RailId, c: QuoteContext) {
    if (rail === 'usdc-base-sepolia') return `chain:84532:${this.native.address.toLowerCase()}:USDC`;
    if (rail === 'ledger') return `ledger:${c.payer.internal_account ?? c.payer.id}`;
    return `bank:${c.payer.bank_accounts.find((a) => a.currency === 'USD' && a.status === 'open')?.reference ?? c.payer.id}`;
  }
  private held(source: string, exclude = '') {
    return (this.store.db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM test_rail_holds WHERE source = ? AND state = 'active' AND payment_id != ?").get(source, exclude) as { n: number }).n;
  }
  async sourceBalance(rail: RailId, c: QuoteContext) {
    if (c.payer.id !== this.payerId) throw new Error('Funding source does not belong to this agent');
    if (rail === 'usdc-base-sepolia') {
      if (c.payer.stablecoin_wallets[0]?.address.toLowerCase() !== this.native.address.toLowerCase()) return 0;
      await this.native.executor.assertTestnet();
      return this.native.balanceMinor();
    }
    if (rail === 'ledger' && !c.payer.internal_account) return 0;
    if (rail !== 'ledger' && !c.payer.bank_accounts.some((a) => a.currency === 'USD' && a.status === 'open')) return 0;
    return this.balance(this.source(rail, c));
  }
  async liquidity(rail: RailId, c: QuoteContext) {
    let available = Math.max(0, await this.sourceBalance(rail, c) - this.held(this.source(rail, c)));
    if (c.intent.destination_currency !== 'USD') {
      const fx = Number(BigInt(this.balance('test:fx-treasury', c.intent.destination_currency)) * 10000n / MODEL_FX[c.intent.destination_currency]);
      available = Math.min(available, fx);
    }
    return decimal(available);
  }
  reserve(paymentId: string, rail: RailId, c: QuoteContext, quote: RouteQuote, sourceSnapshot: number) {
    const source = this.source(rail, c), amount = minor(quote.total_all_in_cost.amount);
    if (rail !== 'usdc-base-sepolia') sourceSnapshot = this.balance(source);
    if (sourceSnapshot - this.held(source, paymentId) < amount) throw new Error('Insufficient available test funds');
    const old = this.store.db.prepare('SELECT * FROM test_rail_holds WHERE payment_id = ?').get(paymentId) as { state: string } | undefined;
    if (old?.state === 'consumed') throw new Error('Funds have already left this reservation');
    this.store.db.prepare("INSERT INTO test_rail_holds VALUES(?,?,?,'active') ON CONFLICT(payment_id) DO UPDATE SET source=excluded.source,amount_minor=excluded.amount_minor,state='active'").run(paymentId, source, amount);
  }
  release(paymentId: string) { this.store.db.prepare("UPDATE test_rail_holds SET state = 'released' WHERE payment_id = ? AND state = 'active'").run(paymentId); }
  private consume(paymentId: string) { this.store.db.prepare("UPDATE test_rail_holds SET state = 'consumed' WHERE payment_id = ?").run(paymentId); }
  private transfer(operation: string, source: string, destination: string, currency: string, amount: number) {
    if (!amount) return;
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid transfer units');
    this.seed(destination, currency, 0);
    const debit = this.store.db.prepare('UPDATE test_rail_accounts SET balance_minor = balance_minor - ? WHERE account = ? AND currency = ? AND balance_minor >= ?').run(amount, source, currency, amount);
    if (!debit.changes) throw new Error('Test account has insufficient funds');
    this.store.db.prepare('UPDATE test_rail_accounts SET balance_minor = balance_minor + ? WHERE account = ? AND currency = ?').run(amount, destination, currency);
    this.store.db.prepare('INSERT INTO test_rail_journal(operation_id,source,destination,currency,amount_minor,created_at) VALUES(?,?,?,?,?,?)').run(operation, source, destination, currency, amount, this.now());
  }
  private get(id: string, rail?: RailId) {
    const op = this.store.db.prepare('SELECT * FROM rail_operations WHERE id = ?').get(id) as Op | undefined;
    if (!op || (rail && op.rail !== rail)) throw new Error('Rail operation not found');
    return op;
  }
  private context(op: Op) { return ContextSchema.parse(JSON.parse(op.context)); }
  private quote(op: Op) { return RouteQuoteSchema.parse(JSON.parse(op.quote)); }
  private paymentId(op: Op) { return op.operation_key.split(':')[0]!; }
  private receipt(op: Op): RailExecution {
    const q = this.quote(op);
    const noOutflow = op.state === 'failed-safe';
    const reverted = op.state === 'failed-reverted';
    return {
      id: op.id, status: op.state === 'returned' ? 'returned' : op.state.startsWith('failed') || ['uncertain','return-uncertain'].includes(op.state) ? 'failed' : op.state === 'settled' ? 'settled' : 'pending',
      irreversible: !reverted && op.rail === 'usdc-base-sepolia' && !!op.raw,
      recipient_usable: !!op.payout_done,
      funds_may_have_left: !noOutflow && !reverted && (op.rail === 'usdc-base-sepolia' ? !!op.raw || op.state === 'uncertain' : !['preparing', 'failed-safe'].includes(op.state)),
      fx_exposure: !noOutflow && !reverted && op.state !== 'returned' && this.context(op).intent.destination_currency !== 'USD',
      destination_rejected: op.state === 'failed-destination',
      ...(op.reason ? { reason: op.reason } : {}),
      charged_fee_usd: noOutflow ? '0.00' : reverted ? q.fees_usd.find((f) => f.kind === 'network')?.amount ?? '0.00' : q.total_fee_usd,
      ...(op.state === 'returned' ? { refunded_usd: q.principal_usd } : {}),
      ...(op.hash ? { transaction_hash: op.hash } : {}), return_pending: ['returning','return-preparing'].includes(op.state),
    };
  }
  async initialize() {
    await this.native.executor.assertTestnet();
    this.store.db.prepare("UPDATE rail_operations SET state = 'uncertain', reason = 'Interrupted preparation; owner investigation required, no automatic replacement' WHERE state = 'preparing'").run();
    this.store.db.prepare("UPDATE rail_operations SET state = 'return-uncertain', reason = 'Interrupted return preparation; owner investigation required' WHERE state = 'return-preparing'").run();
  }
  private safeError(id: string, reason: string): never { throw new RouteFailure(reason, { id, status: 'failed', irreversible: false, recipient_usable: false, funds_may_have_left: false, fx_exposure: false, charged_fee_usd: '0.00', reason }); }
  async execute(rail: RailId, key: string, context: QuoteContext, quote: RouteQuote): Promise<RailExecution> {
    ContextSchema.parse(context); RouteQuoteSchema.parse(quote);
    if (quote.rail !== rail || context.payer.id !== this.payerId || context.intent.payer !== context.payer.id || context.intent.recipient !== context.recipient.id || quote.recipient_amount.currency !== context.intent.destination_currency || minor(quote.recipient_amount.amount) !== minor(context.intent.amount)) throw new Error('Execution does not match the authorized intent');
    if (quote.destination_form === 'wallet' && (quote.recipient_amount.currency !== 'USD' || minor(quote.principal_usd) !== minor(context.intent.amount))) throw new Error('Wallet principal does not match requested delivery');
    const digest = fingerprint({ context: { intent: context.intent, payer: context.payer, recipient: context.recipient }, quote });
    const existing = this.store.db.prepare('SELECT * FROM rail_operations WHERE operation_key = ?').get(key) as Op | undefined;
    if (existing) { if (existing.fingerprint !== digest || existing.rail !== rail) throw new Error('Rail operation idempotency conflict'); return this.status(rail, existing.id); }
    const paymentId = key.split(':')[0]!;
    const id = randomUUID();
    const inserted = this.store.transaction(() => {
      const duplicate = this.store.db.prepare('SELECT * FROM rail_operations WHERE operation_key = ?').get(key) as Op | undefined;
      if (duplicate) { if (duplicate.fingerprint !== digest || duplicate.rail !== rail) throw new Error('Rail operation idempotency conflict'); return false; }
      const hold = this.store.db.prepare("SELECT * FROM test_rail_holds WHERE payment_id = ? AND state = 'active'").get(paymentId) as { source: string; amount_minor: number } | undefined;
      if (!hold || hold.source !== this.source(rail, context) || hold.amount_minor !== minor(quote.total_all_in_cost.amount)) this.safeError(id, 'Funding reservation does not match this execution');
      if (rail === 'usdc-base-sepolia' && (this.store.db.prepare("SELECT id FROM rail_operations WHERE rail = 'usdc-base-sepolia' AND state IN ('preparing','submitted','uncertain','returning','return-preparing','return-uncertain') LIMIT 1").get() || this.store.db.prepare("SELECT id FROM payments WHERE status IN ('preparing','submitted','uncertain') LIMIT 1").get())) throw new WalletBusy('Testnet wallet has an unresolved operation');
      this.authorize?.(paymentId, context, quote);
      this.store.db.prepare("INSERT INTO rail_operations(id,operation_key,fingerprint,rail,state,context,quote,source,created_at) VALUES(?,?,?,?,'preparing',?,?,?,?)").run(id, key, digest, rail, JSON.stringify(context), JSON.stringify(quote), this.source(rail, context), this.now());
      return true;
    });
    if (!inserted) { const duplicate = this.store.db.prepare('SELECT * FROM rail_operations WHERE operation_key = ?').get(key) as Op; return this.status(rail, duplicate.id); }
    const failure = this.failures.get(rail);
    if (failure === 'before-submit') {
      this.store.db.prepare("UPDATE rail_operations SET state = 'failed-safe', reason = 'Simulated provider failure before submission' WHERE id = ?").run(id);
      return this.receipt(this.get(id));
    }
    if (rail === 'usdc-base-sepolia') {
      let signed;
      try {
        await this.native.executor.assertTestnet();
        signed = await this.native.executor.prepare(this.transferIntent(context, quote, this.native.address, false));
        if (keccak256(signed.raw) !== signed.hash) throw new Error('Signed transaction hash mismatch');
      } catch {
        this.store.db.prepare("UPDATE rail_operations SET state = 'failed-safe', reason = 'USDC preparation failed before submission' WHERE id = ?").run(id);
        return this.receipt(this.get(id));
      }
      try { this.store.transaction(() => {
        if (this.get(id).state !== 'preparing') throw new Error('Execution claim lost; refusing broadcast');
        this.authorize?.(paymentId, context, quote);
        this.store.db.prepare("UPDATE rail_operations SET state = 'submitted', raw = ?, hash = ? WHERE id = ?").run(signed.raw, signed.hash, id);
        this.store.db.prepare('UPDATE payments SET transaction_hash = ? WHERE id = ?').run(signed.hash, paymentId);
        this.store.audit(paymentId, 'transaction_persisted', 'system', { transaction_hash: signed.hash }, this.now());
      }); } catch { this.store.db.prepare("UPDATE rail_operations SET state = 'failed-safe', reason = 'Authorization changed before submission' WHERE id = ? AND state = 'preparing'").run(id); return this.receipt(this.get(id)); }
      return this.status(rail, id);
    }
    this.store.transaction(() => {
      const op = this.get(id), q = this.quote(op);
      this.authorize?.(paymentId, context, quote);
      this.transfer(id, op.source, 'test:fees', 'USD', minor(q.total_fee_usd));
      this.transfer(id, op.source, rail === 'ledger' ? `ledger:${context.recipient.internal_account}` : `test:escrow:${id}`, 'USD', minor(q.principal_usd));
      this.consume(paymentId);
      this.store.db.prepare('UPDATE rail_operations SET state = ?, payout_done = ? WHERE id = ?').run(rail === 'ledger' ? 'settled' : 'pending', rail === 'ledger' ? 1 : 0, id);
    });
    if (failure === 'unknown-after-submit' || failure === 'fx-exposure') {
      this.store.db.prepare("UPDATE rail_operations SET state = 'uncertain', reason = ? WHERE id = ?").run(failure === 'fx-exposure' ? 'Simulated open FX exposure' : 'Simulated unknown outcome after submission', id);
    }
    return this.receipt(this.get(id));
  }
  private transferIntent(c: QuoteContext, q: RouteQuote, destination: Hex, returning: boolean): PaymentIntent {
    const target = returning ? destination : c.recipient.stablecoin_wallets[0]!.address;
    return { idempotency_key: c.intent.idempotency_key, payer: c.intent.payer, recipient: { id: returning ? c.payer.id : c.recipient.id, name: returning ? c.payer.name : c.recipient.name, address: target }, amount: q.principal_usd, purpose: returning ? 'Return original test funds' : c.intent.purpose };
  }
  private bankOpen(op: Op) {
    const c = this.context(op), q = this.quote(op);
    const original = c.recipient.bank_accounts.find((a) => a.currency === q.recipient_amount.currency && a.status === 'open');
    let current;
    try { current = this.profiles.get(c.recipient.id); } catch { return false; }
    return current.kyb_status === 'verified' && !!original && current.bank_accounts.some((a) => a.id === original.id && a.reference === original.reference && a.currency === original.currency && a.country === original.country && a.status === 'open');
  }
  private payout(op: Op) {
    const c = this.context(op), q = this.quote(op);
    const bank = c.recipient.bank_accounts.find((a) => a.currency === q.recipient_amount.currency && a.status === 'open')!;
    const escrow = `test:escrow:${op.id}`, recipient = `bank:${bank.reference}`;
    // USDC's fiat leg is explicitly simulated; use the test FX treasury, never a bank API.
    const source = op.rail === 'usdc-base-sepolia' ? 'test:fx-treasury' : escrow;
    if (q.recipient_amount.currency === 'USD') this.transfer(op.id, source, recipient, 'USD', minor(q.recipient_amount.amount));
    else {
      if (op.rail !== 'usdc-base-sepolia') this.transfer(op.id, escrow, 'test:fx-treasury', 'USD', minor(q.principal_usd));
      this.transfer(op.id, 'test:fx-treasury', recipient, q.recipient_amount.currency, minor(q.recipient_amount.amount));
    }
    this.store.db.prepare('UPDATE rail_operations SET payout_done = 1 WHERE id = ?').run(op.id);
  }
  async status(rail: RailId, id: string): Promise<RailExecution> {
    let op = this.get(id, rail), q = this.quote(op);
    if (op.state === 'returning') return this.reverse(rail, id);
    if (rail === 'usdc-base-sepolia' && op.state === 'submitted') {
      try {
        await this.native.executor.assertTestnet();
        const receipt = await this.native.executor.receipt(op.hash!);
        if (receipt === 'pending') { const hash = await this.native.executor.broadcast(op.raw!); if (hash !== op.hash) throw new Error('Unexpected transaction hash'); }
        else this.store.transaction(() => {
          this.store.db.prepare('UPDATE rail_operations SET state = ?, reason = ?, payout_done = ? WHERE id = ?').run(receipt === 'success' ? 'settled' : 'failed-reverted', receipt === 'success' ? null : 'Testnet transaction reverted; principal did not transfer', receipt === 'success' && q.destination_form === 'wallet' ? 1 : 0, id);
          this.consume(this.paymentId(op));
        });
      } catch { /* Unknown RPC result: retain original raw bytes/hash and do not create a replacement. */ }
      op = this.get(id);
    }
    if (rail !== 'ledger' && (op.state === 'pending' || op.state === 'settled') && !op.payout_done) {
      this.store.transaction(() => {
        op = this.get(id); q = this.quote(op);
        const settled = rail === 'usdc-base-sepolia' ? op.state === 'settled' : Date.parse(this.now()) >= Date.parse(q.expected_available_at) - 3600000;
        if (!settled) return;
        if (!this.bankOpen(op)) { this.store.db.prepare("UPDATE rail_operations SET state = 'failed-destination', reason = 'Destination rejected the bank payout' WHERE id = ?").run(id); return; }
        this.store.db.prepare("UPDATE rail_operations SET state = 'settled' WHERE id = ?").run(id);
        if (Date.parse(this.now()) >= Date.parse(q.expected_available_at)) this.payout(op);
      });
    }
    return this.receipt(this.get(id));
  }
  async reverse(rail: RailId, id: string): Promise<RailExecution> {
    let op = this.get(id, rail); const c = this.context(op), q = this.quote(op);
    if (op.state === 'returned') return this.receipt(op);
    if (op.state === 'preparing' || op.state === 'uncertain' || op.state === 'return-uncertain') throw new Error('Cannot return funds while their location is unknown');
    if (['failed-safe','failed-reverted'].includes(op.state)) throw new Error('No principal left on this operation; it cannot be returned');
    if (op.state === 'failed-return') return this.receipt(op);
    if (rail !== 'usdc-base-sepolia') {
      this.store.transaction(() => {
        op = this.get(id);
        if (op.state === 'returned') return;
        const escrow = `test:escrow:${id}`;
        if (rail === 'ledger') this.transfer(id, `ledger:${c.recipient.internal_account}`, op.source, 'USD', minor(q.principal_usd));
        else {
          if (op.payout_done) {
            const bank = c.recipient.bank_accounts.find((a) => a.currency === q.recipient_amount.currency)!;
            const recipient = `bank:${bank.reference}`;
            if (q.recipient_amount.currency === 'USD') this.transfer(id, recipient, escrow, 'USD', minor(q.principal_usd));
            else { this.transfer(id, recipient, 'test:fx-treasury', q.recipient_amount.currency, minor(q.recipient_amount.amount)); this.transfer(id, 'test:fx-treasury', escrow, 'USD', minor(q.principal_usd)); }
          }
          this.transfer(id, escrow, op.source, 'USD', minor(q.principal_usd));
        }
        this.store.db.prepare("UPDATE rail_operations SET state = 'returned' WHERE id = ?").run(id);
      });
      return this.receipt(this.get(id));
    }
    if (!['settled','failed-destination','returning','return-preparing'].includes(op.state)) throw new Error('USDC forward settlement must be confirmed before requesting a return');
    if (!this.native.returnExecutor || this.native.returnAddress?.toLowerCase() !== c.recipient.stablecoin_wallets[0]?.address.toLowerCase()) throw new Error('USDC return needs cooperation from the original recipient; no matching test return signer is configured');
    if (!op.return_raw) {
      if (op.state === 'return-preparing') return { ...this.receipt(op), status: 'pending', return_pending: true };
      const previousState = op.state;
      const claimed = this.store.transaction(() => {
        if (this.get(id).return_raw || this.get(id).state === 'return-preparing') return false;
        if (this.store.db.prepare("SELECT id FROM rail_operations WHERE id != ? AND state IN ('returning','return-preparing','return-uncertain') LIMIT 1").get(id)) throw new Error('Return wallet is busy or has an unresolved operation');
        this.store.db.prepare("UPDATE rail_operations SET state = 'return-preparing' WHERE id = ?").run(id);
        return true;
      });
      if (!claimed) return { ...this.receipt(this.get(id)), status: 'pending', return_pending: true };
      let signed;
      try { await this.native.returnExecutor.assertTestnet(); signed = await this.native.returnExecutor.prepare(this.transferIntent(c, q, this.native.address, true)); }
      catch { this.store.db.prepare('UPDATE rail_operations SET state = ? WHERE id = ?').run(previousState, id); throw new Error('Testnet return preparation failed; check original recipient gas funds'); }
      if (keccak256(signed.raw) !== signed.hash) throw new Error('Return hash mismatch');
      this.store.transaction(() => {
        if (this.get(id).return_raw) return;
        if (this.get(id).state !== 'return-preparing') throw new Error('Return claim lost; refusing broadcast');
        this.store.db.prepare("UPDATE rail_operations SET state = 'returning', return_raw = ?, return_hash = ? WHERE id = ?").run(signed.raw, signed.hash, id);
        this.store.audit(this.paymentId(op), 'return_transaction_persisted', 'system', { transaction_hash: signed.hash, testnet: true }, this.now());
      });
      op = this.get(id);
    }
    try {
      const receipt = await this.native.returnExecutor.receipt(op.return_hash!);
      if (receipt === 'pending') { const hash = await this.native.returnExecutor.broadcast(op.return_raw!); if (hash !== op.return_hash) throw new Error('Unexpected return hash'); }
      else if (receipt === 'success') this.store.transaction(() => {
        const current = this.get(id);
        if (current.state === 'returned') return;
        if (q.destination_form === 'bank' && current.payout_done) {
          const bank = c.recipient.bank_accounts.find((a) => a.currency === q.recipient_amount.currency)!;
          this.transfer(id, `bank:${bank.reference}`, 'test:fx-treasury', q.recipient_amount.currency, minor(q.recipient_amount.amount));
        }
        this.store.db.prepare("UPDATE rail_operations SET state = 'returned' WHERE id = ?").run(id);
      });
      else this.store.db.prepare("UPDATE rail_operations SET state = 'failed-return', reason = 'Return transaction reverted; funds have not returned to the payer' WHERE id = ?").run(id);
    } catch { return { ...this.receipt(this.get(id)), status: 'pending', return_pending: true }; }
    return this.receipt(this.get(id));
  }
}
