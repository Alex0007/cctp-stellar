<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/header-dark.svg">
    <img src="docs/header.svg" width="300" height="64" alt="USDC, Polygon to Stellar">
  </picture>
</p>

<h1 align="center">cctp-stellar</h1>

<p align="center">USDC between Polygon and Stellar through Circle's CCTP V2, as a static page.<br>
Live at <a href="https://usdc.eww.monster">usdc.eww.monster</a>.</p>

## What it does

Polygon → Stellar: USDC is burned on Polygon (`TokenMessengerV2.depositForBurnWithHook`), Circle
attests the burn, and the attestation is submitted to Circle's `CctpForwarder` contract on Stellar,
which mints native USDC to the recipient.

Stellar → Polygon: USDC is burned on Stellar (`TokenMessengerMinter.deposit_for_burn`), Circle
attests the burn, and the attestation is submitted to `MessageTransmitterV2.receiveMessage` on
Polygon, which mints native USDC to the recipient.

The same amount arrives, minus Circle's fee for the standard transfer, which is zero on both
routes at the time of writing.

No backend and no custody: MetaMask signs on Polygon, Albedo or Freighter sign on Stellar.
The page only builds, simulates and submits transactions.

The switch under the title picks the direction; `#stellar-polygon` links straight to the reverse one.

## Using it: Polygon → Stellar

1. Connect MetaMask (Polygon) and the Stellar wallet that will receive the USDC.
   The recipient must already hold a USDC trustline.
2. Check: balance, allowance, trustline and Circle's fee are read without a signature.
3. Approve and burn: two confirmations in MetaMask, one if an earlier approval still covers the amount.
4. Receive on Stellar: the page waits for Circle's attestation, simulates the mint and asks the
   Stellar wallet for one signature.

## Using it: Stellar → Polygon

1. Connect the Stellar wallet that sends the USDC and MetaMask on Polygon, which receives it.
   The MetaMask account needs a little POL: receiving is a Polygon transaction.
2. Check: balance, XLM, POL and Circle's fee are read, and the next Stellar transaction is built
   and simulated, so the wallet can open straight from the click.
3. Approve and burn: two signatures in the Stellar wallet. `deposit_for_burn` takes the USDC with
   `transfer_from`, so it needs an allowance on the USDC contract first, and a Soroban transaction
   holds one contract call. The approval is skipped when an earlier one still covers the amount.
4. Receive on Polygon: the page waits for Circle's attestation, simulates `receiveMessage` and
   asks MetaMask for one confirmation.

Stellar USDC has 7 decimals and CCTP carries 6: the 7th decimal stays on the sender's account.

## Both directions

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

- `src/cctp.ts`: the transfer itself, both directions, no DOM: checks, approve and burn, attestation polling, message decoding, the mint on the other side.
- `src/wallets/`: wallet adapters. `stellar.ts` exposes `connect()` and `sign(xdr, address)` per wallet; a signer must start its popup synchronously from the click, so no `await` before the wallet call.
- `src/main.ts`: the three-step UI for each direction and its state; steps 4–6 in the code are the reverse direction.
- `src/i18n.ts`, `src/locales/*.json`: translations. Add a language by adding a JSON file and importing it in `i18n.ts`.
- `docs/cover.html`: source of the social card `public/og.png`; open it in a browser at 1200×630 and screenshot it.
- `public/brand/`: the USDC token mark from [Circle's brand kit](https://www.circle.com/brand), the Polygon mark from the [Polygon brand kit](https://polygon.technology/brand-kit) and the Stellar symbol from the [Stellar press kit](https://stellar.org/brand), used to refer to the asset and the networks.

## Contracts

Addresses are listed in the page footer and in `src/cctp.ts`. Compare them with
[Circle's published CCTP contracts](https://developers.circle.com/cctp/references/stellar) before use.
