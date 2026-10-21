// Wires the page to cctp.ts. State lives here; the transfer logic does not touch the DOM.
import * as cctp from './cctp';
import type { EvmAddress, IrisMessage, TxHash } from './cctp';
import { connectMetaMask, polygonWallet } from './wallets/evm';
import { stellarWallets, type StellarWalletId } from './wallets/stellar';
import { apply, languageNames, languages, onLangChange, setLang, t } from './i18n';

// 1–3: Polygon → Stellar; 4–6: Stellar → Polygon, shown on the page as 1–3
type Step = 1 | 2 | 3 | 4 | 5 | 6;
type Direction = 'forward' | 'reverse';
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
const NOT_A_BURN_AFTER_MS = 15 * 60 * 1000;
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
let working = false;
const busy = (on: boolean) => {
  working = on;
  document.querySelectorAll('button').forEach((b) => (b.disabled = on || b.classList.contains('done')));
};

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
// The status shows up at once and its clock ticks every second, apart from the polls, so the wait
// visibly goes on; a poll only switches the text once Circle sees the burn. The log gets a line a minute.
async function waitForAttestation(burnHash: string, step: Step = 3, sourceDomain = cctp.POLYGON_DOMAIN): Promise<IrisMessage> {
  const started = Date.now();
  let key = 'status.waitingIndex';
  const tick = (): Status => {
    const sec = Math.floor((Date.now() - started) / 1000);
    const s: Status = { key, vars: { elapsed: `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` }, kind: '' };
    lastStatus[step] = s;
    render(step, s);
    return s;
  };
  tick();
  const clock = setInterval(tick, 1000);
  try {
    // a mistyped or foreign hash fails here at once instead of an hour of polling
    const landed = await cctp.burnTxTime(burnHash, sourceDomain);
    for (let i = 0; i < 360; i++) {
      try {
        const res = await cctp.fetchAttestation(burnHash, sourceDomain);
        if (res.state === 'complete') return res.msg;
        // Circle lists a burn within minutes of its block, long before the attestation;
        // still unknown a quarter of an hour later, the transaction burned nothing through CCTP
        if (res.state === 'not-indexed' && Date.now() - landed > NOT_A_BURN_AFTER_MS) throw new cctp.AppError('err.notABurn');
        key = res.state === 'not-indexed' ? 'status.waitingIndex' : 'status.waitingAttestation';
        const s = tick();
        if (i % 6 === 0) log(`[${step}] ${t(s.key, s.vars)}`);
      } catch (e) {
        if (e instanceof cctp.AppError && e.key === 'err.notABurn') throw e;
        log('attestation poll failed, retrying:', describe(e));
      }
      await sleep(10_000);
    }
  } finally {
    clearInterval(clock); // whatever ends the wait, the clock must not paint over the next status
  }
  throw new cctp.AppError('err.attestationTimeout');
}

async function prepare() {
  const burnHash = input('burnTx').value.trim();
  if (!cctp.isTxHash(burnHash)) throw new cctp.AppError('err.burnTx');
  if (!state.signer || !state.signerWallet) throw new cctp.AppError('status.needSigner');
  state.prepared = null;
  showSign(false);
  showWaiting($('prepare'));
  let built: NonNullable<State['prepared']>;
  try {
    const msg = await waitForAttestation(burnHash);
    const info = cctp.decodeBurnMessage(msg.message);
    state.transfer = { amount: cctp.formatUsdc(info.amount), recipient: info.recipient };
    status(3, 'status.attested', { amount: cctp.formatUsdc(info.amount), recipient: short(info.recipient) }, '', { href: cctp.links.stellarAccount(info.recipient), label: 'stellar.expert' });
    const xdr = await cctp.prepareMint({ msg, signer: state.signer });
    built = { xdr, signer: state.signer, wallet: state.signerWallet };
  } finally {
    showSign(false); // back to plain Prepare if anything above failed
  }
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
    prepare.classList.remove('done', 'waiting');
    prepare.disabled = working; // busy() owns the buttons while something runs
    prepare.hidden = false;
  }
  sign.hidden = !(on && p);
}

// the button says what is going on, so a press during the wait is not a dead click
function showWaiting(button: HTMLElement) {
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  button.replaceChildren(spinner, document.createTextNode(t('step3.waiting')));
  button.classList.add('waiting');
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
    $('prepare').hidden = true; // nothing left to prepare for this burn; another hash brings it back
  });
}

// ---- Stellar → Polygon (steps 4–6)

interface Reverse {
  sender: string;
  wallet: StellarWalletId | null;
  evm: EvmAddress | ''; // the connected MetaMask account, the recipient unless another address was typed
  recipient: EvmAddress | '';
  amount: bigint;
  maxFee: bigint; // Circle's fee in 7-decimal units, the burn's max_fee
  tx: (cctp.ReverseTx & { built: number }) | null; // approve or burn, built and simulated, signed by the step 2 button
  msg: IrisMessage | null; // attested and simulated on Polygon, ready for Receive
  transfer: { amount: string; recipient: string } | null;
}
const rev: Reverse = { sender: '', wallet: null, evm: '', recipient: '', amount: 0n, maxFee: 0n, tx: null, msg: null, transfer: null };
const STELLAR_BURN_KEY = 'cctp:lastBurnTx:stellar';

function readReverseInputs(): cctp.ReverseInputs {
  const sender = input('rSender').value.trim();
  const recipient = input('rRecipient').value.trim();
  if (!cctp.isStellarAddress(sender) || !rev.wallet) throw new cctp.AppError('err.sender');
  if (!cctp.isEvmAddress(recipient)) throw new cctp.AppError('err.evmRecipient');
  const amount = cctp.parseAmount(input('rAmount').value.trim());
  return { sender, recipient, amount, relayer: rev.evm || undefined };
}

// Any edit to the inputs throws the built transaction away: it would burn the old amount for the old recipient.
function dropBurn() {
  rev.tx = null;
  if ($('step4').dataset.state === 'done') {
    setStep(4, 'active');
    setStep(5, 'idle');
  }
}

async function checkReverse() {
  setStep(5, 'idle');
  rev.tx = null;
  const inputs = readReverseInputs();
  status(4, 'status.checking');
  const { fee, tx } = await cctp.checkReverse(inputs);
  Object.assign(rev, { amount: inputs.amount, recipient: inputs.recipient, maxFee: fee, tx: { ...tx, built: Date.now() } });
  status(4, 'status.checked', { amount: cctp.formatUsdc(inputs.amount), evm: short(inputs.sender), recipient: short(inputs.recipient), fee: cctp.formatUsdc(fee / 10n) }, 'ok');
  setStep(4, 'done');
  setStep(5, 'active');
  renderBurnButton();
  status(5, tx.kind === 'approve' ? 'status.rReadyApprove' : 'status.rReady', { amount: cctp.formatUsdc(inputs.amount), recipient: inputs.recipient });
}

// One button, two jobs: Approve in <wallet> while the allowance is missing, then Burn in <wallet>.
function renderBurnButton() {
  const b = $('rBurn');
  const key = rev.tx?.kind === 'approve' ? 'r2.approveIn' : 'r2.burnIn';
  if (rev.wallet) b.replaceChildren(icon(`/brand/${rev.wallet}.png`), document.createTextNode(t(key, { wallet: stellarWallets[rev.wallet].name })));
  else b.textContent = t('r2.burn');
}

function burnOnStellar() {
  const tx = rev.tx;
  if (!tx || !rev.wallet) return;
  if (Date.now() - tx.built > TX_LIFETIME_MS) {
    rev.tx = null;
    setStep(5, 'error');
    status(5, 'status.rExpired', {}, 'err');
    setStep(4, 'active');
    return;
  }
  const walletName = stellarWallets[rev.wallet].name;
  // No await before this call: the wallet popup must open straight from the click.
  const signing = stellarWallets[rev.wallet].sign(tx.xdr, rev.sender);
  run(5, async () => {
    status(5, tx.kind === 'approve' ? 'status.rSigningApprove' : 'status.rSigning', { wallet: walletName });
    const signed = await signing; // a declined signature leaves the built transaction usable
    const hash = await cctp.submitSigned(signed).catch((e) => {
      rev.tx = null; // rejected by the network (expired, bad sequence): Check builds it again
      setStep(4, 'active');
      throw e;
    });
    rev.tx = null;
    if (tx.kind === 'approve') {
      status(5, 'status.rApproveSent', { hash: short(hash) }, '', { href: cctp.links.stellarTx(hash), label: 'stellar.expert' });
      await cctp.waitForStellarTx(hash);
      // the burn can only be simulated once the allowance exists; its signature needs a click of its own
      const xdr = await cctp.prepareBurn({ sender: rev.sender, recipient: rev.recipient as EvmAddress, amount: rev.amount }, rev.maxFee);
      rev.tx = { kind: 'burn', xdr, built: Date.now() };
      renderBurnButton();
      status(5, 'status.rApproved', { wallet: walletName }, 'ok', { href: cctp.links.stellarTx(hash), label: 'stellar.expert' });
      return;
    }
    input('rBurnTx').value = hash;
    localStorage.setItem(STELLAR_BURN_KEY, hash);
    status(5, 'status.rSent', { hash: short(hash) }, '', { href: cctp.links.stellarTx(hash), label: 'stellar.expert' });
    await cctp.waitForStellarTx(hash);
    status(5, 'status.rConfirmed', {}, 'ok', { href: cctp.links.stellarTx(hash), label: 'stellar.expert' });
    setStep(5, 'done');
    setStep(6, 'active');
    log('burn:', hash);
    await prepareReceive();
  });
}

async function prepareReceive() {
  const burnHash = input('rBurnTx').value.trim().replace(/^0x/, '').toLowerCase();
  if (!cctp.isStellarTxHash(burnHash)) throw new cctp.AppError('err.rBurnTx');
  rev.msg = null;
  showReceive(false);
  showWaiting($('rPrepare'));
  try {
    const msg = await waitForAttestation(burnHash, 6, cctp.STELLAR_DOMAIN);
    // simulated from the connected account if there is one, otherwise from the recipient: anyone may relay
    const info = cctp.decodeBurnToEvm(msg.message);
    rev.transfer = { amount: cctp.formatUsdc(info.amount), recipient: info.recipient };
    status(6, 'status.attested', { amount: rev.transfer.amount, recipient: short(info.recipient) }, '', { href: cctp.links.polygonAddress(info.recipient), label: 'polygonscan' });
    await cctp.checkReceive(msg, rev.evm || info.recipient);
    rev.msg = msg;
  } finally {
    showReceive(Boolean(rev.msg));
  }
  status(6, 'status.rPrepared', {}, 'ok');
}

// Same hand-over as in step 3: Prepare turns into a finished "Attestation received", Receive in MetaMask appears beside it.
function showReceive(on: boolean) {
  const prepare = $('rPrepare') as HTMLButtonElement;
  if (on) {
    prepare.replaceChildren(checkIcon(), document.createTextNode(t('step3.prepared')));
    prepare.classList.add('done');
    prepare.disabled = true;
  } else {
    prepare.textContent = t('step3.prepare');
    prepare.classList.remove('done', 'waiting');
    prepare.disabled = working;
    prepare.hidden = false;
  }
  $('rReceive').hidden = !on;
}

function receive() {
  const msg = rev.msg;
  if (!msg) return;
  run(6, async () => {
    const evm = rev.evm || (await connectReverseEvm());
    if ((await cctp.gasBalance(evm)) === 0n) throw new cctp.AppError('err.noGasRelayer');
    const wallet = await polygonWallet(evm);
    status(6, 'status.rReceiving');
    const hash = await cctp.receiveOnPolygon(wallet, msg, (h) => {
      rev.msg = null;
      showReceive(false);
      status(6, 'status.rReceiveSent', { hash: short(h) }, '', { href: cctp.links.polygonTx(h), label: 'polygonscan' });
    });
    localStorage.removeItem(STELLAR_BURN_KEY);
    const tr = rev.transfer;
    status(6, 'status.done', { amount: tr?.amount ?? '', recipient: short(tr?.recipient ?? '') }, 'done', { href: cctp.links.polygonTx(hash), label: 'polygonscan' });
    setStep(6, 'done');
    $('rPrepare').hidden = true;
  });
}

async function connectReverseEvm(): Promise<EvmAddress> {
  const address = await connectMetaMask();
  rev.evm = address;
  // MetaMask fills the recipient unless another address was typed in
  if (input('rRecipient').readOnly) input('rRecipient').value = address;
  log('MetaMask:', address);
  return address;
}

$('rConnectEvm').onclick = () => run(4, async () => { await connectReverseEvm(); dropBurn(); });
$('rOtherRecipient').onclick = () => {
  const field = input('rRecipient');
  field.readOnly = false;
  field.value = '';
  field.focus();
  $('rRecipientWarning').hidden = false;
  $('rOtherRecipient').hidden = true;
  dropBurn();
};
input('rRecipient').oninput = dropBurn;
input('rAmount').oninput = dropBurn;
$('rMax').onclick = () =>
  run(4, async () => {
    const sender = input('rSender').value.trim();
    if (!cctp.isStellarAddress(sender)) throw new cctp.AppError('err.sender');
    const { usdc } = await cctp.stellarAccount(sender);
    input('rAmount').value = (Number(usdc) / 1e6).toFixed(6).replace(/\.?0+$/, '');
    dropBurn();
  });
$('rCheck').onclick = () => run(4, checkReverse);
$('rBurn').onclick = burnOnStellar;
$('rPrepare').onclick = () => run(6, prepareReceive);
$('rReceive').onclick = receive;
input('rBurnTx').oninput = () => {
  rev.msg = null;
  showReceive(false);
  if (cctp.isStellarTxHash(input('rBurnTx').value.trim().replace(/^0x/, '')) && $('step6').dataset.state === 'idle') setStep(6, 'active');
};

// ---- direction

function setDirection(dir: Direction) {
  document.body.dataset.dir = dir;
  document.title = t(dir === 'reverse' ? 'meta.titleReverse' : 'meta.title');
  history.replaceState(null, '', dir === 'reverse' ? '#stellar-polygon' : location.pathname + location.search);
}
$('routeSwap').onclick = () => {
  document.body.classList.add('swapping'); // plays the motion, see style.css
  setDirection(document.body.dataset.dir === 'reverse' ? 'forward' : 'reverse');
};

// ---- wallets

async function connectStellar(target: 'recipient' | 'signer' | 'sender', walletId: StellarWalletId) {
  const address = await stellarWallets[walletId].connect();
  if (target === 'sender') {
    input('rSender').value = address;
    rev.sender = address;
    rev.wallet = walletId;
    log(`${stellarWallets[walletId].name}:`, address);
    dropBurn();
    renderBurnButton();
    return;
  }
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
  const target = b.dataset.connect as 'recipient' | 'signer' | 'sender';
  const walletId = b.dataset.wallet as StellarWalletId;
  const step: Step = target === 'recipient' ? 1 : target === 'signer' ? 3 : 4;
  b.onclick = () => run(step, () => connectStellar(target, walletId));
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

// Grouped by network, so a name needs no "on Polygon" of its own. USDC and its issuer lead each group.
const contracts: { chain: 'polygon' | 'stellar'; icon: string; items: { name: string; address: string; link: string }[] }[] = [
  {
    chain: 'polygon',
    icon: '/brand/polygon.svg',
    items: [
      { name: 'USDC', address: cctp.POLYGON_USDC, link: cctp.links.polygonAddress(cctp.POLYGON_USDC) },
      { name: 'TokenMessengerV2', address: cctp.TOKEN_MESSENGER_V2, link: cctp.links.polygonAddress(cctp.TOKEN_MESSENGER_V2) },
      { name: 'MessageTransmitterV2', address: cctp.MESSAGE_TRANSMITTER_V2, link: cctp.links.polygonAddress(cctp.MESSAGE_TRANSMITTER_V2) },
    ],
  },
  {
    chain: 'stellar',
    icon: '/brand/stellar.svg',
    items: [
      { name: 'USDC', address: cctp.STELLAR_USDC, link: cctp.links.stellarContract(cctp.STELLAR_USDC) },
      { name: 'contracts.issuer', address: cctp.STELLAR_USDC_ISSUER, link: cctp.links.stellarAccount(cctp.STELLAR_USDC_ISSUER) },
      { name: 'TokenMessengerMinter', address: cctp.TOKEN_MESSENGER_MINTER, link: cctp.links.stellarContract(cctp.TOKEN_MESSENGER_MINTER) },
      { name: 'CctpForwarder', address: cctp.CCTP_FORWARDER, link: cctp.links.stellarContract(cctp.CCTP_FORWARDER) },
    ],
  },
];
const COPY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
function renderContracts() {
  $('contracts').innerHTML = contracts
    .map(
      (g) => `<div class="contract-group">
        <h3 class="contract-chain"><img src="${g.icon}" width="16" height="16" alt="">${t('chain.' + g.chain)}</h3>
        ${g.items
          .map(
            (c) => `<div class="contract">
              <span class="contract-name">${c.name.startsWith('contracts.') ? t(c.name) : c.name}</span>
              <a class="contract-address" href="${c.link}" target="_blank" rel="noopener"><code>${c.address}</code></a>
              <button type="button" class="copy" data-copy="${c.address}" title="${t('contracts.copy')}" aria-label="${t('contracts.copy')}">${COPY_ICON}</button>
            </div>`,
          )
          .join('')}
      </div>`,
    )
    .join('');
}
// one listener for every copy button; the icon turns into a check for a moment
$('contracts').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button.copy');
  if (!b) return;
  try {
    await navigator.clipboard.writeText(b.dataset.copy!);
  } catch {
    return; // no clipboard access (an old browser, an insecure page): the address stays selectable
  }
  b.innerHTML = COPIED_ICON;
  b.classList.add('copied');
  setTimeout(() => {
    b.innerHTML = COPY_ICON;
    b.classList.remove('copied');
  }, 1500);
});

const langSelect = $<HTMLSelectElement>('lang');
langSelect.innerHTML = languages.map((l) => `<option value="${l}">${languageNames[l] ?? l}</option>`).join('');
langSelect.onchange = () => setLang(langSelect.value);
onLangChange(() => {
  renderContracts();
  renderSigner();
  for (const [step, s] of Object.entries(lastStatus)) if (s) render(Number(step) as Step, s);
  if (state.prepared) showSign(true);
  if (rev.msg) showReceive(true);
  renderBurnButton();
  document.title = t(document.body.dataset.dir === 'reverse' ? 'meta.titleReverse' : 'meta.title');
});
if (languages.length < 2) langSelect.hidden = true;
apply();
renderContracts();
renderSigner();
renderBurnButton();

const saved = localStorage.getItem('cctp:lastBurnTx');
if (saved) {
  input('burnTx').value = saved;
  setStep(3, 'active');
  status(3, 'status.needSigner');
}
const savedStellar = localStorage.getItem(STELLAR_BURN_KEY);
if (savedStellar) {
  input('rBurnTx').value = savedStellar;
  setStep(6, 'active');
}
// a link to #stellar-polygon opens the reverse direction; so does an unfinished reverse transfer alone
setDirection(location.hash === '#stellar-polygon' || (savedStellar && !saved) ? 'reverse' : 'forward');
