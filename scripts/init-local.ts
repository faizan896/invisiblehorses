import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

if (existsSync('.env')) {
  console.log('Existing .env preserved. Set missing values there; no credentials were changed.');
} else {
  const payerKey = generatePrivateKey(); const recipientKey = generatePrivateKey();
  const agentToken = randomBytes(32).toString('hex');
  let text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const [placeholder, value] of [
    ['replace_with_testnet_only_private_key', payerKey],
    ['replace_with_random_secret_at_least_32_characters', randomBytes(32).toString('hex')],
    ['replace_with_different_random_owner_secret', randomBytes(32).toString('hex')],
    ['replace_with_different_random_agent_secret', agentToken],
    ['replace_with_same_value_as_AGENT_API_TOKEN', agentToken],
    ['replace_with_private_random_topic', `railgate-${randomBytes(24).toString('hex')}`],
    ['replace_with_testnet_recipient_address', privateKeyToAccount(recipientKey).address],
  ]) text = text.replace(placeholder!, value!);
  text += `\n# Testnet demo recipient recovery key. Never share or fund on mainnet.\nDEMO_RECIPIENT_PRIVATE_KEY=${recipientKey}\n`;
  writeFileSync('.env', text, { flag: 'wx', mode: 0o600 });
  console.log('Created ignored .env with dedicated TESTNET wallets and independent random local secrets.');
  console.log('Fund this Base Sepolia payer with faucet test USDC and Sepolia ETH:', privateKeyToAccount(payerKey).address);
  console.log('Set PUBLIC_BASE_URL and subscribe to the ntfy server/topic in .env. Secret values were not printed.');
}
