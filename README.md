<p align="center">
  <img src="public/brand/usdc.svg" width="56" height="56" alt="USDC">
  &nbsp;&nbsp;<img src="public/brand/polygon.svg" width="52" height="47" alt="Polygon">
  &nbsp;&nbsp;<img src="docs/arrow.svg" width="40" height="20" alt="to">&nbsp;&nbsp;
  <img src="public/brand/stellar.svg" width="52" height="52" alt="Stellar">
</p>

<h1 align="center">cctp-stellar</h1>

<p align="center">USDC from Polygon to Stellar through Circle's CCTP V2, as a static page.<br>
Live at <a href="https://usdc.eww.monster">usdc.eww.monster</a>.</p>

## What it does

USDC is burned on Polygon (`TokenMessengerV2.depositForBurnWithHook`), Circle attests the burn,
and the attestation is submitted to Circle's `CctpForwarder` contract on Stellar, which mints
native USDC to the recipient. The same amount arrives, minus Circle's fee for the standard
transfer, which is zero on this route at the time of writing.

No backend and no custody: MetaMask signs on Polygon, Albedo or Freighter sign on Stellar.
The page only builds, simulates and submits transactions.

One direction for now. The layout leaves room for more.

## Using it

1. Connect MetaMask (Polygon) and the Stellar wallet that will receive the USDC.
   The recipient must already hold a USDC trustline.
2. Check: balance, allowance, trustline and Circle's fee are read without a signature.
3. Approve and burn: two confirmations in MetaMask, one if an earlier approval still covers the amount.
4. Receive on Stellar: the page waits for Circle's attestation, simulates the mint and asks the
   Stellar wallet for one signature.

A transfer can be resumed from the burn hash alone: the recipient and the amount are inside
Circle's message. CCTP carries no memo, so the recipient must be an address you control, never
an exchange deposit address.

## Run

```bash
npm install
npm run dev
```

`npm run build` writes the static site to `dist/`; `npm run check` runs the TypeScript compiler.
Deployed as a Cloudflare Worker with static assets (`wrangler.toml`).

## Layout

- `src/cctp.ts`: the transfer itself, no DOM: checks, burn, attestation polling, message decoding, Stellar mint.
- `src/wallets/`: wallet adapters. `stellar.ts` exposes `connect()` and `sign(xdr, address)` per wallet; a signer must start its popup synchronously from the click, so no `await` before the wallet call.
- `src/main.ts`: the three-step UI and its state.
- `src/i18n.ts`, `src/locales/*.json`: translations. Add a language by adding a JSON file and importing it in `i18n.ts`.
- `public/brand/`: the USDC token mark from [Circle's brand kit](https://www.circle.com/brand), the Polygon mark from the [Polygon brand kit](https://polygon.technology/brand-kit) and the Stellar symbol from the [Stellar press kit](https://stellar.org/brand), used to refer to the asset and the networks.

## Contracts

Addresses are listed in the page footer and in `src/cctp.ts`. Compare them with
[Circle's published CCTP contracts](https://developers.circle.com/cctp/references/stellar) before use.
