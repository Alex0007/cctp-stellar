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
interface Status { key: string; vars: Vars; kind: '' | 'ok' | 'err' | 'done'; link?: StatusLink }

interface State {
  evm: EvmAddress | '';
  recipient: string;
  amount: bigint;
  fee: bigint;
  allowance: bigint;
  signer: string;
  signerWallet: StellarWalletId | null;
  prepared: { xdr: string; signer: string; wallet: StellarWalletId } | null;
  transfer: { amount: string; recipient: string } | null; // what the attested message says
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
  transfer: null,
};
const TX_LIFETIME_MS = 10 * 60 * 1000; // setTimeout(600) in prepareMint
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

// a finished button (Prepare after the attestation) stays disabled
const busy = (on: boolean) => document.querySelectorAll('button').forEach((b) => (b.disabled = on || b.classList.contains('done')));

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
  showSign(false);
  const msg = await waitForAttestation(burnHash);
  const info = cctp.decodeBurnMessage(msg.message);
  state.transfer = { amount: cctp.formatUsdc(info.amount), recipient: info.recipient };
  status(3, 'status.attested', { amount: cctp.formatUsdc(info.amount), recipient: short(info.recipient) }, '', { href: cctp.links.stellarAccount(info.recipient), label: 'stellar.expert' });
  const xdr = await cctp.prepareMint({ msg, signer: state.signer });
  const built = { xdr, signer: state.signer, wallet: state.signerWallet };
  state.prepared = built;
  showSign(true);
  status(3, 'status.prepared', {}, 'ok');
  // the transaction carries a 10-minute time bound: past it, Sign would only
  // fail, so Prepare comes back instead
  setTimeout(() => {
    if (state.prepared !== built) return;
    state.prepared = null;
    showSign(false);
    status(3, 'status.expired');
  }, TX_LIFETIME_MS);
}

// Step 3 keeps both buttons in view so the hand-over is visible: Prepare
// turns into a finished, greyed "Attestation received" and Sign in <wallet>
// appears next to it. Anything that invalidates the built transaction
// (another hash, another signer) brings Prepare back.
function showSign(on: boolean) {
  const prepare = $('prepare') as HTMLButtonElement;
  const sign = $('sign');
  const p = state.prepared;
  if (on && p) {
    sign.replaceChildren(icon(`/brand/${p.wallet}.png`), document.createTextNode(t('step3.sign', { wallet: stellarWallets[p.wallet].name })));
    prepare.replaceChildren(checkIcon(), document.createTextNode(t('step3.prepared')));
    prepare.classList.add('done');
    prepare.disabled = true;
  } else {
    prepare.textContent = t('step3.prepare');
    prepare.classList.remove('done');
    prepare.disabled = false;
  }
  sign.hidden = !(on && p);
}

function icon(src: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'btn-icon';
  img.src = src;
  img.alt = '';
  return img;
}

function checkIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'btn-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M20 6 9 17l-5-5');
  svg.append(path);
  return svg;
}

function sign() {
  const p = state.prepared;
  if (!p) return;
  // No await before this call: the wallet popup must open straight from the click.
  const signing = stellarWallets[p.wallet].sign(p.xdr, p.signer);
  run(3, async () => {
    const signed = await signing; // a declined signature leaves the built transaction usable
    const hash = await cctp.submitSigned(signed).catch((e) => {
      // rejected by the network (expired, bad sequence): build it again
      state.prepared = null;
      showSign(false);
      throw e;
    });
    status(3, 'status.submitted', { hash: short(hash) }, '', { href: cctp.links.stellarTx(hash), label: 'stellar.expert' });
    state.prepared = null;
    showSign(false);
    await cctp.waitForStellarTx(hash);
    localStorage.removeItem('cctp:lastBurnTx');
    const tr = state.transfer;
    status(3, 'status.done', { amount: tr?.amount ?? '', recipient: short(tr?.recipient ?? '') }, 'done', { href: cctp.links.stellarTx(hash), label: 'stellar.expert' });
    setStep(3, 'done');
  });
}

// ---- wallets

async function connectStellar(target: 'recipient' | 'signer', walletId: StellarWalletId) {
  const address = await stellarWallets[walletId].connect();
  // step 1 has a recipient field; step 3 only names the signer in text
  if (target === 'recipient') input('recipient').value = address;
  log(`${stellarWallets[walletId].name}:`, address);
  // The recipient's wallet becomes the signer unless a signer was chosen explicitly.
  if (target === 'signer' || !state.signer) {
    state.signer = address;
    state.signerWallet = walletId;
    state.prepared = null;
    showSign(false);
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
// Pasting a burn hash wakes step 3 up: that is how a transfer is resumed.
input('burnTx').oninput = () => {
  state.prepared = null;
  showSign(false);
  if (cctp.isTxHash(input('burnTx').value.trim()) && $('step3').dataset.state === 'idle') {
    setStep(3, 'active');
    status(3, 'status.needSigner');
  }
};
$('sign').onclick = sign;

// ---- footer, language, resume

const contracts: { key: string; chain: 'polygon' | 'stellar'; address: string; link: (a: string) => string }[] = [
  { key: 'contracts.usdc', chain: 'polygon', address: cctp.POLYGON_USDC, link: cctp.links.polygonAddress },
  { key: 'contracts.messenger', chain: 'polygon', address: cctp.TOKEN_MESSENGER_V2, link: cctp.links.polygonAddress },
  { key: 'contracts.forwarder', chain: 'stellar', address: cctp.CCTP_FORWARDER, link: cctp.links.stellarContract },
  { key: 'contracts.stellarUsdc', chain: 'stellar', address: `USDC-${cctp.STELLAR_USDC_ISSUER}`, link: () => cctp.links.stellarAsset('USDC', cctp.STELLAR_USDC_ISSUER) },
  { key: 'contracts.issuer', chain: 'stellar', address: cctp.STELLAR_USDC_ISSUER, link: cctp.links.stellarAccount },
];
function renderContracts() {
  $('contracts').innerHTML = contracts
    .map(
      (c) => `<div class="contract">
        <span class="chain ${c.chain}">${t('chain.' + c.chain)}</span>
        <span class="contract-name">${t(c.key)}</span>
        <a class="contract-address" href="${c.link(c.address)}" target="_blank" rel="noopener" title="${c.address}"><code>${c.address}</code></a>
      </div>`,
    )
    .join('');
}

const langSelect = $<HTMLSelectElement>('lang');
langSelect.innerHTML = languages.map((l) => `<option value="${l}">${languageNames[l] ?? l}</option>`).join('');
langSelect.onchange = () => setLang(langSelect.value);
onLangChange(() => {
  renderContracts();
  renderSigner();
  for (const [step, s] of Object.entries(lastStatus)) if (s) render(Number(step) as Step, s);
  if (state.prepared) showSign(true);
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
