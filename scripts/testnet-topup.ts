/**
 * Move testnet NEAR from the vendor account back into the vault.
 *
 * The vault holds the contract's code (about 300 KB), and a NEAR account must keep
 * `storage_usage * storage_byte_cost` locked - so roughly 3 NEAR of the vault is a stake
 * for the wasm, not spendable money. Earlier demo runs paid the vendor 0.6 NEAR per run,
 * which is why the vendor has more than the vault does. This script puts some of it back
 * so the conformance suite has room to move small amounts.
 *
 *   node scripts/testnet-topup.ts [amountNeAR]
 *
 * Never run by CI: it moves testnet funds and needs the local key file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';

const RPC = process.env.FERAL_RPC ?? 'https://rpc.testnet.fastnear.com';
const ONE_NEAR = 10n ** 24n;
const root = join(import.meta.dirname, '..');
const rolesPath = join(root, 'data', 'testnet-roles.json');

interface KeyFile {
  accountId: string;
  secretKey: string;
}

if (!existsSync(rolesPath)) {
  console.error(`no accounts at ${rolesPath}`);
  process.exit(2);
}

const roles = JSON.parse(readFileSync(rolesPath, 'utf8')) as { owner: KeyFile; vendor: KeyFile };
const provider = new JsonRpcProvider({ url: RPC });
const vendor = new Account(roles.vendor.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.vendor.secretKey)));

const requested = process.argv[2] ? BigInt(process.argv[2]) : 3n;
const amount = requested * ONE_NEAR;

const before = (await provider.viewAccount({ accountId: roles.owner.accountId })) as unknown as { amount: string };
const vendorBefore = (await provider.viewAccount({ accountId: roles.vendor.accountId })) as unknown as { amount: string };
console.log(`vault  before: ${(Number(BigInt(before.amount)) / 1e24).toFixed(4)} NEAR`);
console.log(`vendor before: ${(Number(BigInt(vendorBefore.amount)) / 1e24).toFixed(4)} NEAR`);

const outcome = (await vendor.signAndSendTransaction({
  receiverId: roles.owner.accountId,
  actions: [actions.transfer(amount)],
})) as { transaction_outcome?: { id?: string } };
console.log(`transfer ${Number(amount) / 1e24} NEAR -> ${outcome.transaction_outcome?.id ?? 'unknown'}`);

const after = (await provider.viewAccount({ accountId: roles.owner.accountId })) as unknown as { amount: string; storage_usage: number };
const spendable = BigInt(after.amount) - BigInt(after.storage_usage) * 10n ** 19n;
console.log(`vault  after:  ${(Number(BigInt(after.amount)) / 1e24).toFixed(4)} NEAR`);
console.log(`available after the storage stake: ${(Number(spendable) / 1e24).toFixed(4)} NEAR`);
