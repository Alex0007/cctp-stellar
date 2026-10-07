// Core of the transfer: USDC burned on Polygon through Circle CCTP V2,
// attested by Circle, minted on Stellar by the CctpForwarder contract.
// No DOM here; the UI lives in main.ts.
import { createPublicClient, fallback, http, parseAbi, toHex, type Hex, type WalletClient } from 'viem';
import { polygon } from 'viem/chains';
import { Contract, Networks, StrKey, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk';

export const POLYGON_DOMAIN = 7;
export const STELLAR_DOMAIN = 27;
export const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as const;
export const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as const;
export const CCTP_FORWARDER = 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T';
export const STELLAR_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const IRIS = 'https://iris-api.circle.com';
const SOROBAN_RPC = 'https://mainnet.sorobanrpc.com';
const HORIZON = 'https://horizon.stellar.org';
const STANDARD_FINALITY = 2000;

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const messengerAbi = parseAbi([
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
]);

export const publicClient = createPublicClient({
  chain: polygon,
  transport: fallback([
    http('https://polygon.drpc.org'),
    http('https://polygon-bor-rpc.publicnode.com'),
    http('https://1rpc.io/matic'),
  ]),
});
const soroban = new rpc.Server(SOROBAN_RPC);

export type EvmAddress = `0x${string}`;
export type TxHash = `0x${string}`;

// An error the UI can translate: `key` is a locale key, `vars` fill its placeholders.
export class AppError extends Error {
  constructor(public key: string, public vars: Record<string, string | number> = {}) {
    super(key);
  }
}

export function parseAmount(text: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new AppError('err.amount');
  const [whole, frac = ''] = text.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  if (amount <= 0n) throw new AppError('err.amount');
  return amount;
}

export const formatUsdc = (n: bigint): string => (Number(n) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });

export const isEvmAddress = (s: string): s is EvmAddress => /^0x[0-9a-fA-F]{40}$/.test(s);
export const isTxHash = (s: string): s is TxHash => /^0x[0-9a-fA-F]{64}$/.test(s);
export const isStellarAddress = (s: string): boolean => StrKey.isValidEd25519PublicKey(s);

// Hook data layout from Circle's Stellar reference: 24 zero bytes, u32 version 0,
// u32 length of the recipient strkey, then the strkey as UTF-8.
function buildHookData(recipient: string): Hex {
  const strkey = new TextEncoder().encode(recipient);
  const out = new Uint8Array(32 + strkey.length);
  new DataView(out.buffer).setUint32(28, strkey.length, false);
  out.set(strkey, 32);
  return toHex(out);
}

function burnArgs(recipient: string, amount: bigint, maxFee: bigint) {
  const forwarder = toHex(StrKey.decodeContract(CCTP_FORWARDER));
  return [amount, STELLAR_DOMAIN, forwarder, POLYGON_USDC, forwarder, maxFee, STANDARD_FINALITY, buildHookData(recipient)] as const;
}

async function standardFee(amount: bigint): Promise<bigint> {
  const res = await fetch(`${IRIS}/v2/burn/USDC/fees/${POLYGON_DOMAIN}/${STELLAR_DOMAIN}`);
  if (!res.ok) throw new AppError('err.feeApi', { status: res.status });
  const tiers: { finalityThreshold: number; minimumFee: number }[] = await res.json();
  const tier = tiers.find((t) => t.finalityThreshold === STANDARD_FINALITY);
  if (!tier) throw new AppError('err.noFeeTier');
  // minimumFee is in basis points of the amount; round up.
  return (amount * BigInt(Math.ceil(tier.minimumFee * 100)) + 999_999n) / 1_000_000n;
}

export interface StellarAccountInfo {
  exists: boolean;
  trustline: boolean;
  xlm: number;
}

// What Horizon knows about an account: whether it exists, holds the USDC trustline, has XLM.
export async function stellarAccount(address: string): Promise<StellarAccountInfo> {
  const res = await fetch(`${HORIZON}/accounts/${address}`);
  if (res.status === 404) return { exists: false, trustline: false, xlm: 0 };
  if (!res.ok) throw new AppError('err.horizon', { status: res.status });
  const data: { balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }[] } = await res.json();
  const native = data.balances.find((b) => b.asset_type === 'native');
  return {
    exists: true,
    trustline: data.balances.some((b) => b.asset_code === 'USDC' && b.asset_issuer === STELLAR_USDC_ISSUER),
    xlm: Number(native?.balance ?? 0),
  };
}

export function gasBalance(evm: EvmAddress): Promise<bigint> {
  return publicClient.getBalance({ address: evm });
}

export function usdcBalance(evm: EvmAddress): Promise<bigint> {
  return publicClient.readContract({ address: POLYGON_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [evm] });
}

export interface TransferInputs {
  evm: EvmAddress;
  recipient: string;
  amount: bigint;
}

// Everything that can be checked without a signature. Throws an AppError on the first problem.
export async function check({ evm, recipient, amount }: TransferInputs) {
  const [balance, allowance, fee, account, gas] = await Promise.all([
    usdcBalance(evm),
    publicClient.readContract({ address: POLYGON_USDC, abi: erc20Abi, functionName: 'allowance', args: [evm, TOKEN_MESSENGER_V2] }),
    standardFee(amount),
    stellarAccount(recipient),
    gasBalance(evm),
  ]);
  if (gas === 0n) throw new AppError('err.noGas');
  if (!account.exists) throw new AppError('err.noAccount');
  if (!account.trustline) throw new AppError('err.noTrustline');
  if (balance < amount) throw new AppError('err.balance', { balance: formatUsdc(balance) });
  if (allowance >= amount) {
    await publicClient.simulateContract({
      account: evm,
      address: TOKEN_MESSENGER_V2,
      abi: messengerAbi,
      functionName: 'depositForBurnWithHook',
      args: burnArgs(recipient, amount, fee),
    });
  }
  return { balance, allowance, fee };
}

export type BurnStage = 'approve' | 'approved' | 'burn' | 'sent' | 'confirmed';

// Two signatures at most: approve (skipped when the allowance already covers the amount) and the burn.
export async function approveAndBurn(opts: TransferInputs & {
  wallet: WalletClient;
  fee: bigint;
  allowance: bigint;
  onStage: (stage: BurnStage, hash?: TxHash) => void;
}): Promise<TxHash> {
  const { wallet, evm, recipient, amount, fee, allowance, onStage } = opts;
  const account = wallet.account!;
  if (allowance < amount) {
    onStage('approve');
    const hash = await wallet.writeContract({ account, chain: polygon, address: POLYGON_USDC, abi: erc20Abi, functionName: 'approve', args: [TOKEN_MESSENGER_V2, amount] });
    await publicClient.waitForTransactionReceipt({ hash });
    onStage('approved', hash);
  }
  const args = burnArgs(recipient, amount, fee);
  // Simulate with the allowance in place: a revert here costs nothing.
  await publicClient.simulateContract({ account: evm, address: TOKEN_MESSENGER_V2, abi: messengerAbi, functionName: 'depositForBurnWithHook', args });
  onStage('burn');
  const hash = await wallet.writeContract({ account, chain: polygon, address: TOKEN_MESSENGER_V2, abi: messengerAbi, functionName: 'depositForBurnWithHook', args });
  onStage('sent', hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new AppError('err.burnReverted', { hash });
  onStage('confirmed', hash);
  return hash;
}

export interface IrisMessage {
  status: string;
  message: Hex;
  attestation: string;
}
export type AttestationState =
  | { state: 'not-indexed' }
  | { state: 'pending'; msg: IrisMessage }
  | { state: 'complete'; msg: IrisMessage };

// One poll of Circle's attestation service. Right after the burn the API answers 404
// for a short while: the transaction is not indexed yet, which is normal.
export async function fetchAttestation(burnHash: TxHash): Promise<AttestationState> {
  const res = await fetch(`${IRIS}/v2/messages/${POLYGON_DOMAIN}?transactionHash=${burnHash}`);
  if (res.status === 404) return { state: 'not-indexed' };
  if (!res.ok) throw new AppError('err.irisApi', { status: res.status });
  const msg: IrisMessage | undefined = (await res.json()).messages?.[0];
  if (!msg) return { state: 'not-indexed' };
  if (msg.status === 'complete' && msg.attestation && msg.attestation !== 'PENDING') return { state: 'complete', msg };
  return { state: 'pending', msg };
}

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.slice(2).match(/.{2}/g)!.map((b) => parseInt(b, 16)));

// Reads the recipient and the amount back out of a CCTP V2 message, so a transfer can be
// resumed from the burn hash alone. Header is 148 bytes, the BurnMessage body 228 bytes,
// then the hook data built by buildHookData.
export function decodeBurnMessage(messageHex: string) {
  const b = hexToBytes(messageHex);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const destinationDomain = view.getUint32(8, false);
  let amount = 0n;
  for (const byte of b.subarray(216, 248)) amount = (amount << 8n) | BigInt(byte);
  const len = view.getUint32(404, false);
  const recipient = new TextDecoder().decode(b.subarray(408, 408 + len));
  return { destinationDomain, amount, recipient };
}

// Builds and simulates mint_and_forward. Returns the XDR to sign; any Stellar account may sign it.
export async function prepareMint({ msg, signer }: { msg: IrisMessage; signer: string }): Promise<string> {
  const info = await stellarAccount(signer);
  if (!info.exists) throw new AppError('err.noSignerAccount');
  if (info.xlm < 0.5) throw new AppError('err.noXlm', { xlm: info.xlm });
  const account = await soroban.getAccount(signer);
  const op = new Contract(CCTP_FORWARDER).call(
    'mint_and_forward',
    nativeToScVal(hexToBytes(msg.message), { type: 'bytes' }),
    nativeToScVal(hexToBytes(msg.attestation), { type: 'bytes' }),
  );
  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: Networks.PUBLIC }).addOperation(op).setTimeout(600).build();
  // prepareTransaction simulates the call; it throws if the mint would fail.
  const ready = await soroban.prepareTransaction(tx);
  return ready.toXDR();
}

export async function submitSigned(signedXdr: string): Promise<string> {
  const sent = await soroban.sendTransaction(TransactionBuilder.fromXDR(signedXdr, Networks.PUBLIC));
  if (sent.status === 'ERROR') throw new AppError('err.stellarRejected', { detail: JSON.stringify(sent.errorResult ?? sent) });
  return sent.hash;
}

export async function waitForStellarTx(hash: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const got = await soroban.getTransaction(hash);
    if (got.status === 'SUCCESS') return;
    if (got.status === 'FAILED') throw new AppError('err.stellarFailed', { hash });
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new AppError('err.stellarUnconfirmed', { hash });
}

export const links = {
  polygonTx: (h: string) => `https://polygonscan.com/tx/${h}`,
  polygonAddress: (a: string) => `https://polygonscan.com/address/${a}`,
  stellarTx: (h: string) => `https://stellar.expert/explorer/public/tx/${h}`,
  stellarAccount: (a: string) => `https://stellar.expert/explorer/public/account/${a}`,
  stellarContract: (a: string) => `https://stellar.expert/explorer/public/contract/${a}`,
  stellarAsset: (code: string, issuer: string) => `https://stellar.expert/explorer/public/asset/${code}-${issuer}`,
};
