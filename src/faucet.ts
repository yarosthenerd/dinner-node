import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';

const FAUCET = 'https://agents.devnads.com/v1/faucet';

async function fund(address: string) {
  const res = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: 10143, address }),
  });
  const body = (await res.text()) || '(empty response)';
  console.log(`${res.ok ? '✅' : '❌'} ${address} -> ${body}`);
}

async function main() {
  const targets: string[] = [];
  if (process.argv[2]) {
    targets.push(process.argv[2]);
  } else {
    for (const k of ['GUEST_PK', 'PROVIDER_PK']) {
      if (process.env[k]) targets.push(privateKeyToAccount(process.env[k] as `0x${string}`).address);
    }
  }
  if (targets.length === 0) {
    console.error('Usage: npm run faucet -- 0xADDR  (or set GUEST_PK / PROVIDER_PK in .env)');
    process.exit(1);
  }
  for (const t of targets) await fund(t);
}

main();
