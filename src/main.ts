// Wires the page to cctp.ts. State lives here; the transfer logic does not touch the DOM.
import * as cctp from './cctp';
import type { EvmAddress, IrisMessage, TxHash } from './cctp';
import { connectMetaMask, polygonWallet } from './wallets/evm';
import { stellarWallets, type StellarWalletId } from './wallets/stellar';
import { apply, languageNames, languages, onLangChange, setLang, t } from './i18n';

type Step = 1 | 2 | 3;
type StepState = 'idle' | 'active' | 'done' | 'error';
type Vars = Record<string, string | number>;
interface StatusLink { href: string; label: string }
interface Status { key: string; vars: Vars; kind: '' | 'ok' | 'err'; link?: StatusLink }

interface State {
  evm: EvmAddress | '';
  recipient: string;
  amount: bigint;
  fee: bigint;
  allowance: bigint;
  signer: string;
  signerWallet: StellarWalletId | null;
  prepared: { xdr: string; signer: string; wallet: StellarWalletId } | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const state: State = {
  evm: '',
  recipient: '',
  amount: 0n,
  fee: 0n,
  allowance: 0n,
  signer: '',
  signerWallet: null,
  prepared: null,
};
const lastStatus: Partial<Record<Step, Status | null>> = {}; // re-rendered on language change

function log(...a: unknown[]) {
  const el = $('log');
  el.textContent += (el.textContent ? '\n' : '') + a.join(' ');
  el.scrollTop = el.scrollHeight;
}

function render(step: Step, s: Status) {
  const el = $('status' + step);
  el.className = 'status ' + s.kind;
  el.textContent = t(s.key, s.vars) + (s.link ? ' ' : '');
  if (s.link) {
    const a = document.createElement('a');
    a.href = s.link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = s.link.label;
    el.append(a);
  }
}

function status(step: Step, key: string, vars: Vars = {}, kind: Status['kind'] = '', link?: StatusLink) {
  const s: Status = { key, vars, kind, link };
  lastStatus[step] = s;
  render(step, s);
  log(`[${step}] ${t(key, vars)}${link ? ' ' + link.href : ''}`);
}

const setStep = (step: Step, st: StepState) => ($('step' + step).dataset.state = st);

function describe(e: unknown): string {
  if (e instanceof cctp.AppError) return t(e.key, e.vars);
  const err = e as { shortMessage?: string; message?: string };
  return err?.shortMessage ?? err?.message ?? String(e);
}

const busy = (on: boolean) => document.querySelectorAll('button').forEach((b) => (b.disabled = on));

async function run(step: Step, fn: () => Promise<void>) {
  busy(true);
  setStep(step, 'active');
  try {
    await fn();
  } catch (e) {
    setStep(step, 'error');
    const el = $('status' + step);
    el.className = 'status err';
    el.textContent = describe(e);
    lastStatus[step] = null;
    log('ERROR:', describe(e));
  } finally {
    busy(false);
  }
}

const short = (s: string) => (s.length > 16 ? s.slice(0, 6) + '…' + s.slice(-4) : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- step 1: inputs and the free checks

function readInputs(): cctp.TransferInputs {
  const evm = input('evm').value.trim();
  const recipient = input('recipient').value.trim();
  if (!cctp.isEvmAddress(evm)) throw new cctp.AppError('err.evm');
  if (!cctp.isStellarAddress(recipient)) throw new cctp.AppError('err.recipient');
  const amount = cctp.parseAmount(input('amount').value.trim());
  return { evm, recipient, amount };
}

async function check() {
  setStep(2, 'idle');
  const inputs = readInputs();
  status(1, 'status.checking');
  const { allowance, fee } = await cctp.check(inputs);
  Object.assign(state, inputs, { allowance, fee });
  status(1, 'status.checked', { amount: cctp.formatUsdc(inputs.amount), evm: short(inputs.evm), recipient: short(inputs.recipient), fee: cctp.formatUsdc(fee) }, 'ok');
  setStep(1, 'done');
  setStep(2, 'active');
}

// ---- step 2: approve and burn

async function burn() {
  const { evm, recipient, amount, fee, allowance } = state;
  if (!evm) throw new cctp.AppError('err.evm');
  if (!window.confirm(t('confirm.burn', { amount: cctp.formatUsdc(amount), recipient }))) return;
  const wallet = await polygonWallet(evm);
  const hash = await cctp.approveAndBurn({
    wallet, evm, recipient, amount, fee, allowance,
    onStage(stage, h) {
      if (stage === 'approve') status(2, 'status.approve');
      if (stage === 'approved' && h) status(2, 'status.approved', { hash: short(h) }, '', { href: cctp.links.polygonTx(h), label: 'polygonscan' });
      if (stage === 'burn') status(2, 'status.burn');
      if (stage === 'sent' && h) {
        input('burnTx').value = h;
        localStorage.setItem('cctp:lastBurnTx', h);
        status(2, 'status.sent', { hash: short(h) }, '', { href: cctp.links.polygonTx(h), label: 'polygonscan' });
      }
      if (stage === 'confirmed' && h) status(2, 'status.confirmed', {}, 'ok', { href: cctp.links.polygonTx(h), label: 'polygonscan' });
    },
  });
  setStep(2, 'done');
  setStep(3, 'active');
  log('burn:', hash);
  if (state.signer) await prepare();
  else status(3, 'status.needSigner');
}

// ---- step 3: attestation, simulation, signature

// Keeps polling through 404s and network hiccups; only gives up after an hour.
async function waitForAttestation(burnHash: TxHash): Promise<IrisMessage> {
  for (let i = 0; i < 360; i++) {
    try {
      const res = await cctp.fetchAttestation(burnHash);
      if (res.state === 'complete') return res.msg;
      if (i % 6 === 0) status(3, res.state === 'not-indexed' ? 'status.waitingIndex' : 'status.waitingAttestation');
    } catch (e) {
      log('attestation poll failed, retrying:', describe(e));
    }
    await sleep(10_000);
  }
  throw new cctp.AppError('err.attestationTimeout');
}

async function prepare() {
  const burnHash = input('burnTx').value.trim();
  if (!cctp.isTxHash(burnHash)) throw new cctp.AppError('err.burnTx');
  if (!state.signer || !state.signerWallet) throw new cctp.AppError('status.needSigner');
  state.prepared = null;
  $('sign').hidden = true;
  const msg = await waitForAttestation(burnHash);
  const info = cctp.decodeBurnMessage(msg.message);
  status(3, 'status.attested', { amount: cctp.formatUsdc(info.amount), recipient: short(info.recipient) }, '', { href: cctp.links.stellarAccount(info.recipient), label: 'stellar.expert' });
  const xdr = await cctp.prepareMint({ msg, signer: state.signer });
  state.prepared = { xdr, signer: state.signer, wallet: state.signerWallet };
  $('sign').textContent = t('step3.sign', { wallet: stellarWallets[state.signerWallet].name });
  $('sign').hidden = false;
  status(3, 'status.prepared', {}, 'ok');
}

function sign() {
  const p = state.prepared;
  if (!p) return;
  // No await before this call: the wallet popup must open straight from the click.
  const signing = stellarWallets[p.wallet].sign(p.xdr, p.signer);
  run(3, async () => {
    const signed = await signing;
    const hash = await cctp.submitSigned(signed);
    status(3, 'status.submitted', { hash: short(hash) }, '', { href: cctp.links.stellarTx(hash), label: 'stellar.expert' });
    state.prepared = null;
    $('sign').hidden = true;
    await cctp.waitForStellarTx(hash);
    localStorage.removeItem('cctp:lastBurnTx');
    status(3, 'status.done', {}, 'ok', { href: cctp.links.stellarTx(hash), label: 'stellar.expert' });
    setStep(3, 'done');
  });
}

// ---- wallets

async function connectStellar(target: 'recipient' | 'signer', walletId: StellarWalletId) {
  const address = await stellarWallets[walletId].connect();
  input(target).value = address;
  log(`${stellarWallets[walletId].name}:`, address);
  // The recipient's wallet becomes the signer unless a signer was chosen explicitly.
  if (target === 'signer' || !state.signer) {
    state.signer = address;
    state.signerWallet = walletId;
  }
  renderSigner();
}

// Step 3 shows the wallet buttons only while no signer is known.
function renderSigner(pick = false) {
  const known = Boolean(state.signer && state.signerWallet) && !pick;
  $('signerPick').hidden = known;
  $('signerKnown').hidden = !known;
  if (known) $('signerText').textContent = t('step3.signerKnown', { address: short(state.signer), wallet: stellarWallets[state.signerWallet!].name });
}
$('signerChange').onclick = () => renderSigner(true);

// Manual recipient is opt-in: CCTP has no memo, so an exchange deposit address loses the funds.
$('otherRecipient').onclick = () => {
  const field = input('recipient');
  field.readOnly = false;
  field.value = '';
  field.focus();
  $('recipientWarning').hidden = false;
  $('otherRecipient').hidden = true;
};

$('connectEvm').onclick = () =>
  run(1, async () => {
    const address = await connectMetaMask();
    input('evm').value = address;
    log('MetaMask:', address);
  });
document.querySelectorAll<HTMLButtonElement>('[data-connect]').forEach((b) => {
  const target = b.dataset.connect as 'recipient' | 'signer';
  const walletId = b.dataset.wallet as StellarWalletId;
  b.onclick = () => run(target === 'recipient' ? 1 : 3, () => connectStellar(target, walletId));
});
$('max').onclick = () =>
  run(1, async () => {
    const evm = input('evm').value.trim();
    if (!cctp.isEvmAddress(evm)) throw new cctp.AppError('err.evm');
    const balance = await cctp.usdcBalance(evm);
    input('amount').value = (Number(balance) / 1e6).toFixed(6).replace(/\.?0+$/, '');
  });
$('check').onclick = () => run(1, check);
$('burn').onclick = () => run(2, burn);
$('prepare').onclick = () => run(3, prepare);
$('sign').onclick = sign;

// ---- footer, language, resume

const contracts: [string, string, (a: string) => string][] = [
  ['contracts.usdc', cctp.POLYGON_USDC, cctp.links.polygonAddress],
  ['contracts.messenger', cctp.TOKEN_MESSENGER_V2, cctp.links.polygonAddress],
  ['contracts.forwarder', cctp.CCTP_FORWARDER, cctp.links.stellarContract],
  ['contracts.issuer', cctp.STELLAR_USDC_ISSUER, cctp.links.stellarAccount],
];
function renderContracts() {
  $('contracts').innerHTML = contracts
    .map(([key, addr, link]) => `<li>${t(key)}: <a href="${link(addr)}" target="_blank" rel="noopener"><code>${addr}</code></a></li>`)
    .join('');
}

const langSelect = $<HTMLSelectElement>('lang');
langSelect.innerHTML = languages.map((l) => `<option value="${l}">${languageNames[l] ?? l}</option>`).join('');
langSelect.onchange = () => setLang(langSelect.value);
onLangChange(() => {
  renderContracts();
  renderSigner();
  for (const [step, s] of Object.entries(lastStatus)) if (s) render(Number(step) as Step, s);
  if (state.prepared) $('sign').textContent = t('step3.sign', { wallet: stellarWallets[state.prepared.wallet].name });
});
if (languages.length < 2) langSelect.hidden = true;
apply();
renderContracts();
renderSigner();

const saved = localStorage.getItem('cctp:lastBurnTx');
if (saved) {
  input('burnTx').value = saved;
  setStep(3, 'active');
  status(3, 'status.needSigner');
}
