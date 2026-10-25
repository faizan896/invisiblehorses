import { describe, expect, it } from 'vitest';

const launcher = await import(new URL('../scripts/mcp-launch.mjs', import.meta.url).href);
const settings = { RAILGATE_API_URL: 'http://127.0.0.1:3000', RAILGATE_AGENT_TOKEN: 'synthetic-agent-token-not-a-real-credential' };
describe('limited MCP launcher credentials', () => {
  it('drops owner, wallet, signing and unrelated credentials from the child environment', () => {
    const env = launcher.childEnvironment(settings, { PATH: '/bin', HTTPS_PROXY: 'http://proxy.example.test:80', OWNER_API_TOKEN: 'owner', RAILGATE_PRIVATE_KEY: 'wallet', APPROVAL_SECRET: 'signing', NTFY_TOPIC: 'private-topic', GH_TOKEN: 'github', NODE_OPTIONS: '--require untrusted' });
    expect(env).toEqual({ ...settings, PATH: '/bin', HTTPS_PROXY: 'http://proxy.example.test:80' });
  });
  it('rejects owner settings in the limited configuration file', () => {
    expect(() => launcher.ClientSettings.parse({ ...settings, OWNER_API_TOKEN: 'owner' })).toThrow();
  });
  it.each(['http://remote.example.test', 'https://user:pass@example.test', 'https://example.test/?token=secret', 'file:///tmp/secret', 'https://example.test/api'])('rejects an unsafe API origin: %s', (url) => {
    expect(() => launcher.ClientSettings.parse({ ...settings, RAILGATE_API_URL: url })).toThrow();
  });
});
