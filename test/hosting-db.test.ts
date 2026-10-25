import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Store } from '../src/audit/store.js';
import { fixture, intent, complete, agentId } from './support.js';

const restore = await import(new URL('../scripts/restore-hosted-db.mjs', import.meta.url).href);
const dirs: string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function path(){const dir=mkdtempSync(join(tmpdir(),'railgate-hosting-'));dirs.push(dir);return dir;}
describe('durable database bootstrap',()=>{
  it('retains historical IDs, fingerprints, hashes and accounting across the cutover snapshot',async()=>{
    const dir=path(), f=fixture(join(dir,'source.sqlite'));const p=await f.service.request(intent(),agentId);await complete(f);
    const backup=join(dir,'backup.sqlite');await f.store.db.backup(backup);const raw=readFileSync(backup);const before=f.store.get(p.id)!;f.store.close();
    const target=join(dir,'volume/database.sqlite');
    const settings={path:target,snapshot:gzipSync(raw).toString('base64'),sha256:createHash('sha256').update(raw).digest('hex'),allowBootstrap:true};
    expect(restore.restoreHostedDatabase(settings)).toBe('restored');expect(statSync(target).mode&0o777).toBe(0o600);
    const hosted=new Store(target);expect(hosted.get(p.id)).toMatchObject({fingerprint:before.fingerprint,transaction_hash:before.transaction_hash,status:'completed'});
    hosted.audit(p.id,'post_cutover','owner',{},'2026-10-25T13:00:00Z');hosted.close();
    expect(restore.restoreHostedDatabase(settings)).toBe('existing');const again=new Store(target);expect(JSON.stringify(again.events())).toContain('post_cutover');again.close();
  });
  it('refuses a missing volume after bootstrap is disabled, even when old snapshot settings remain',()=>{
    expect(()=>restore.restoreHostedDatabase({path:join(path(),'lost.sqlite'),snapshot:'old',sha256:'0'.repeat(64)})).toThrow('automatic restoration');
  });
  it('rejects a corrupted or mismatched snapshot and never replaces an existing invalid database',()=>{
    const target=join(path(),'state.sqlite');
    expect(()=>restore.restoreHostedDatabase({path:target,snapshot:gzipSync(Buffer.from('not sqlite')).toString('base64'),sha256:'0'.repeat(64),allowBootstrap:true})).toThrow('verification');
    writeFileSync(target,'corrupt');expect(()=>restore.restoreHostedDatabase({path:target,allowBootstrap:true})).toThrow();expect(readFileSync(target,'utf8')).toBe('corrupt');
  });
  it('requires an explicit snapshot before creating a new hosted database',()=>{
    expect(()=>restore.restoreHostedDatabase({path:join(path(),'empty.sqlite'),allowBootstrap:true})).toThrow('refusing an empty payment history');
  });
  it('refuses an oversized environment snapshot before creating any payment state',()=>{
    expect(()=>restore.restoreHostedDatabase({path:join(path(),'too-large.sqlite'),snapshot:'A'.repeat(100000),sha256:'0'.repeat(64),allowBootstrap:true})).toThrow('oversized');
  });
});
