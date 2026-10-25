import { describe, expect, it } from 'vitest';
import { durableExecutor } from '../src/workers/factory.js';
import type { DurableStorage } from '../src/workers/sqlite.js';
import { MockTestnetExecutor } from '../examples/support/mock.js';
import { intent } from './support.js';

describe('physical persistence before native outflow',()=>{
  it('does not broadcast if durable storage rejects the signed-state flush',async()=>{
    const executor=new MockTestnetExecutor(),signed=await executor.prepare(intent());
    const storage={sync:async()=>{throw new Error('Simulated disk failure');}} as unknown as DurableStorage;
    await expect(durableExecutor(executor,storage).broadcast(signed.raw)).rejects.toThrow('disk failure');
    expect(executor.broadcasts.size).toBe(0);
  });
  it('waits for the persistence promise to complete before the broadcast can start',async()=>{
    const executor=new MockTestnetExecutor(),signed=await executor.prepare(intent());let finish!:()=>void;
    const storage={sync:()=>new Promise<void>((resolve)=>{finish=resolve;})} as unknown as DurableStorage;
    const pending=durableExecutor(executor,storage).broadcast(signed.raw);
    expect(executor.broadcasts.size).toBe(0);finish();await pending;expect(executor.broadcasts.size).toBe(1);
  });
});
