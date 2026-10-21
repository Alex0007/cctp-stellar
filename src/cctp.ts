// Core of the transfer, both ways through Circle CCTP V2.
// Polygon → Stellar: USDC burned on Polygon, attested by Circle, minted on Stellar by the CctpForwarder contract.
// Stellar → Polygon: USDC burned by TokenMessengerMinter on Stellar, attested, received by MessageTransmitterV2 on Polygon.
// No DOM here; the UI lives in main.ts.
import { createPublicClient, fallback, http, parseAbi, toHex, type Hex, type WalletClient } from 'viem';
import { polygon } from 'viem/chains';
import { Address, Contract, Networks, StrKey, TransactionBuilder, nativeToScVal, rpc, scValToNative, type xdr } from '@stellar/stellar-sdk';

export const POLYGON_DOMAIN = 7;
export const STELLAR_DOMAIN = 27;
export const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as const;
export const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as const;
export const MESSAGE_TRANSMITTER_V2 = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64' as const;
export const CCTP_FORWARDER = 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T';
export const TOKEN_MESSENGER_MINTER = 'CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL';
export const STELLAR_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
/** the Stellar Asset Contract of USDC, the burn_token for TokenMessengerMinter */
export const STELLAR_USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

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
const transmitterAbi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
  'function usedNonces(bytes32 nonce) view returns (uint256)',
]);

export const POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com';

export const publicClient = createPublicClient({
  chain: polygon,
  transport: fallback([
    http('https://polygon.drpc.org'),
    http(POLYGON_RPC),
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
// Stellar hashes are bare hex; Circle's API finds them only without a 0x prefix
export const isStellarTxHash = (s: string): boolean => /^[0-9a-fA-F]{64}$/.test(s);

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

// `amount` in the burn token's own units: the fee comes back in the same units.
async function standardFee(amount: bigint, from = POLYGON_DOMAIN, to = STELLAR_DOMAIN): Promise<bigint> {
  const res = await fetch(`${IRIS}/v2/burn/USDC/fees/${from}/${to}`);
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
  /** XLM above the reserve and liabilities, what can actually pay a fee */
  spendableXlm: number;
  /** USDC in 6-decimal units, as CCTP counts it: the 7th Stellar decimal is dropped */
  usdc: bigint;
}

// What Horizon knows about an account: whether it exists, holds the USDC trustline, has XLM.
export async function stellarAccount(address: string): Promise<StellarAccountInfo> {
  const res = await fetch(`${HORIZON}/accounts/${address}`);
  if (res.status === 404) return { exists: false, trustline: false, xlm: 0, spendableXlm: 0, usdc: 0n };
  if (!res.ok) throw new AppError('err.horizon', { status: res.status });
  const data: {
    balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string; selling_liabilities?: string }[];
    subentry_count: number;
    num_sponsoring: number;
    num_sponsored: number;
  } = await res.json();
  const native = data.balances.find((b) => b.asset_type === 'native');
  const xlm = Number(native?.balance ?? 0);
  // base reserve 0.5 XLM: two for the account itself plus one per subentry (trustlines, offers, signers)
  const reserve = (2 + data.subentry_count + data.num_sponsoring - data.num_sponsored) * 0.5;
  const usdc = data.balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === STELLAR_USDC_ISSUER);
  return {
    exists: true,
    trustline: Boolean(usdc),
    xlm,
    spendableXlm: Math.max(0, xlm - reserve - Number(native?.selling_liabilities ?? 0)),
    usdc: usdc ? usdcUnits(usdc.balance) - usdcUnits(usdc.selling_liabilities ?? '0') : 0n,
  };
}

// Horizon's "12.3456789" to 6-decimal units, the 7th decimal cut off
function usdcUnits(text: string): bigint {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(frac.slice(0, 6).padEnd(6, '0'));
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

// Before waiting on Circle: the transaction exists on the source network and succeeded. Returns when it
// landed (ms), so the wait can tell a slow attestation from a transaction that is no CCTP burn at all.
export async function burnTxTime(burnHash: string, sourceDomain = POLYGON_DOMAIN): Promise<number> {
  if (sourceDomain === STELLAR_DOMAIN) {
    const res = await fetch(`${HORIZON}/transactions/${burnHash}`);
    if (res.status === 404) throw new AppError('err.txNotFound', { chain: 'Stellar' });
    if (!res.ok) throw new AppError('err.horizon', { status: res.status });
    const tx: { successful: boolean; created_at: string } = await res.json();
    if (!tx.successful) throw new AppError('err.txFailed', { chain: 'Stellar' });
    return Date.parse(tx.created_at);
  }
  const receipt = await publicClient.getTransactionReceipt({ hash: burnHash as TxHash }).catch((e: Error) => {
    if (e.name === 'TransactionReceiptNotFoundError') throw new AppError('err.txNotFound', { chain: 'Polygon' });
    throw e;
  });
  if (receipt.status !== 'success') throw new AppError('err.txFailed', { chain: 'Polygon' });
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  return Number(block.timestamp) * 1000;
}

// One poll of Circle's attestation service. Right after the burn the API answers 404
// for a short while: the transaction is not indexed yet, which is normal.
export async function fetchAttestation(burnHash: string, sourceDomain = POLYGON_DOMAIN): Promise<AttestationState> {
  const res = await fetch(`${IRIS}/v2/messages/${sourceDomain}?transactionHash=${burnHash}`);
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

// The same message read the other way round: a burn on Stellar for an EVM address.
// mintRecipient (bytes 184..216) is the address left-padded to 32 bytes; the nonce sits at 12..44.
export function decodeBurnToEvm(messageHex: string) {
  const b = hexToBytes(messageHex);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let amount = 0n;
  for (const byte of b.subarray(216, 248)) amount = (amount << 8n) | BigInt(byte);
  return {
    sourceDomain: view.getUint32(4, false),
    destinationDomain: view.getUint32(8, false),
    nonce: toHex(b.subarray(12, 44)),
    recipient: toHex(b.subarray(196, 216)) as EvmAddress,
    amount,
  };
}

// Builds and simulates mint_and_forward. Returns the XDR to sign; any Stellar account may sign it.
export async function prepareMint({ msg, signer }: { msg: IrisMessage; signer: string }): Promise<string> {
  const info = await stellarAccount(signer);
  if (!info.exists) throw new AppError('err.noSignerAccount');
  // the mint has cost about 0.03 XLM in practice; the max fee set below is 0.1 XLM
  if (info.spendableXlm < 0.15) throw new AppError('err.noXlm', { xlm: info.spendableXlm.toFixed(2) });
  const account = await soroban.getAccount(signer);
  const op = new Contract(CCTP_FORWARDER).call(
    'mint_and_forward',
    nativeToScVal(hexToBytes(msg.message), { type: 'bytes' }),
    nativeToScVal(hexToBytes(msg.attestation), { type: 'bytes' }),
  );
  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: Networks.PUBLIC }).addOperation(op).setTimeout(600).build();
  // prepareTransaction simulates the call; it throws if the mint would fail.
  try {
    const ready = await soroban.prepareTransaction(tx);
    return ready.toXDR();
  } catch (e) {
    // MessageTransmitterV2 error 6908, NonceAlreadyUsed: this message was minted before
    if (String((e as Error)?.message ?? e).includes('6908')) throw new AppError('err.alreadyMinted');
    throw e;
  }
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

// ---- Stellar → Polygon

export interface ReverseInputs {
  sender: string;
  recipient: EvmAddress;
  amount: bigint;
  /** the Polygon account that will send receiveMessage and pay its gas; the recipient when not given */
  relayer?: EvmAddress;
}

/** a Stellar transaction built and simulated, waiting for its one signature */
export interface ReverseTx {
  kind: 'approve' | 'burn';
  xdr: string;
}

// Everything that can be checked without a signature, and the next transaction built and simulated on the way:
// the wallet popup has to open straight from the click, so the transaction must exist before it.
// TokenMessengerMinter takes the USDC with transfer_from, so the burn needs an allowance first,
// and Soroban fits one contract call in a transaction: approve and burn are two signatures, as on Polygon.
export async function checkReverse({ sender, recipient, amount, relayer }: ReverseInputs) {
  // Stellar USDC has 7 decimals, CCTP messages 6: the contracts take the 7-decimal amount
  const local = amount * 10n;
  const [account, fee, gas, allowance] = await Promise.all([
    stellarAccount(sender),
    standardFee(local, STELLAR_DOMAIN, POLYGON_DOMAIN),
    gasBalance(relayer ?? recipient),
    stellarAllowance(sender),
  ]);
  if (!account.exists) throw new AppError('err.noSenderAccount');
  if (!account.trustline) throw new AppError('err.noSenderTrustline');
  if (account.usdc < amount) throw new AppError('err.stellarBalance', { balance: formatUsdc(account.usdc) });
  // up to two transactions at about 0.03 XLM each, 0.1 XLM max fee each
  if (account.spendableXlm < 0.25) throw new AppError('err.noXlmSender', { xlm: account.spendableXlm.toFixed(2) });
  if (gas === 0n) throw new AppError('err.noGasRecipient');
  const tx: ReverseTx = allowance >= local
    ? { kind: 'burn', xdr: await prepareBurn({ sender, recipient, amount }, fee) }
    : { kind: 'approve', xdr: await prepareApprove(sender, local) };
  return { fee, tx, balance: account.usdc };
}

// Read-only contract call: a simulation from the account itself, nothing is signed.
async function readSoroban(source: string, contract: string, fn: string, ...args: xdr.ScVal[]) {
  const account = await soroban.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.PUBLIC }).addOperation(new Contract(contract).call(fn, ...args)).setTimeout(30).build();
  const sim = await soroban.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) throw new Error(rpc.Api.isSimulationError(sim) ? sim.error : 'empty simulation');
  return scValToNative(sim.result.retval);
}

// USDC the sender has allowed TokenMessengerMinter to take, 7-decimal units
export async function stellarAllowance(sender: string): Promise<bigint> {
  return BigInt(await readSoroban(sender, STELLAR_USDC, 'allowance', new Address(sender).toScVal(), new Address(TOKEN_MESSENGER_MINTER).toScVal()));
}

// approve on the USDC contract for the exact amount, live for about 3 hours (2000 ledgers):
// long enough to burn right after it, and nothing lingers if the burn never happens
async function prepareApprove(sender: string, amount: bigint): Promise<string> {
  const [account, latest] = await Promise.all([soroban.getAccount(sender), soroban.getLatestLedger()]);
  const op = new Contract(STELLAR_USDC).call(
    'approve',
    new Address(sender).toScVal(),
    new Address(TOKEN_MESSENGER_MINTER).toScVal(),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(latest.sequence + 2000, { type: 'u32' }),
  );
  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: Networks.PUBLIC }).addOperation(op).setTimeout(600).build();
  return (await soroban.prepareTransaction(tx)).toXDR();
}

const bytes32 = (b: Uint8Array) => {
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return nativeToScVal(out, { type: 'bytes' });
};

// deposit_for_burn on TokenMessengerMinter, once the allowance is in place. The caller's authorisation
// is recorded by the simulation and covered by the one signature on the transaction itself.
// `amount` in 6-decimal units like the rest of the page, `maxFee` in the token's 7-decimal units.
export async function prepareBurn({ sender, recipient, amount }: ReverseInputs, maxFee: bigint): Promise<string> {
  const account = await soroban.getAccount(sender);
  const op = new Contract(TOKEN_MESSENGER_MINTER).call(
    'deposit_for_burn',
    new Address(sender).toScVal(),
    nativeToScVal(amount * 10n, { type: 'i128' }),
    nativeToScVal(POLYGON_DOMAIN, { type: 'u32' }),
    bytes32(hexToBytes(recipient)),
    new Address(STELLAR_USDC).toScVal(),
    bytes32(new Uint8Array(0)), // no destination caller: anyone may relay, the USDC still go to the recipient
    nativeToScVal(maxFee, { type: 'i128' }),
    nativeToScVal(STANDARD_FINALITY, { type: 'u32' }),
  );
  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: Networks.PUBLIC }).addOperation(op).setTimeout(600).build();
  const ready = await soroban.prepareTransaction(tx);
  return ready.toXDR();
}

// Before asking for a signature on Polygon: the message is for Polygon, not received yet, and receiveMessage would pass.
export async function checkReceive(msg: IrisMessage, from: EvmAddress) {
  const info = decodeBurnToEvm(msg.message);
  if (info.destinationDomain !== POLYGON_DOMAIN) throw new AppError('err.notToPolygon');
  const used = await publicClient.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: transmitterAbi, functionName: 'usedNonces', args: [info.nonce] });
  if (used !== 0n) throw new AppError('err.alreadyReceived');
  await publicClient.simulateContract({
    account: from,
    address: MESSAGE_TRANSMITTER_V2,
    abi: transmitterAbi,
    functionName: 'receiveMessage',
    args: [msg.message, msg.attestation as Hex],
  });
  return info;
}

// receiveMessage needs no particular caller: whoever sends it pays the gas, the USDC go to the recipient in the message.
export async function receiveOnPolygon(wallet: WalletClient, msg: IrisMessage, onSent: (hash: TxHash) => void): Promise<TxHash> {
  const hash = await wallet.writeContract({
    account: wallet.account!,
    chain: polygon,
    address: MESSAGE_TRANSMITTER_V2,
    abi: transmitterAbi,
    functionName: 'receiveMessage',
    args: [msg.message, msg.attestation as Hex],
  });
  onSent(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new AppError('err.receiveReverted', { hash });
  return hash;
}

export const links = {
  polygonTx: (h: string) => `https://polygonscan.com/tx/${h}`,
  polygonAddress: (a: string) => `https://polygonscan.com/address/${a}`,
  stellarTx: (h: string) => `https://stellar.expert/explorer/public/tx/${h}`,
  stellarAccount: (a: string) => `https://stellar.expert/explorer/public/account/${a}`,
  stellarContract: (a: string) => `https://stellar.expert/explorer/public/contract/${a}`,
  stellarAsset: (code: string, issuer: string) => `https://stellar.expert/explorer/public/asset/${code}-${issuer}`,
};
