# cctp-stellar

A static page that moves USDC from Polygon to Stellar through Circle's CCTP V2.
One direction for now; the layout leaves room for more.
USDC is burned on Polygon (`TokenMessengerV2.depositForBurnWithHook`), Circle attests the burn,
and the attestation is submitted to Circle's `CctpForwarder` contract on Stellar, which mints
native USDC to the recipient.

No backend and no custody: MetaMask signs on Polygon, Albedo or Freighter sign on Stellar.
The page only builds, simulates and submits transactions.

## Run

```bash
npm install
npm run dev
```

`npm run build` writes the static site to `dist/`; `npm run check` runs the TypeScript compiler.

## Layout

- `src/cctp.ts`: the transfer itself, no DOM: checks, burn, attestation polling, message decoding, Stellar mint.
- `src/wallets/`: wallet adapters. `stellar.ts` exposes `connect()` and `sign(xdr, address)` per wallet; a signer must start its popup synchronously from the click, so no `await` before the wallet call.
- `src/main.ts`: the three-step UI and its state.
- `src/i18n.ts`, `src/locales/*.json`: translations. Add a language by adding a JSON file and importing it in `i18n.ts`.

## Contracts

Addresses are listed in the page footer and in `src/cctp.ts`. Compare them with
[Circle's published CCTP contracts](https://developers.circle.com/cctp/references/stellar) before use.
