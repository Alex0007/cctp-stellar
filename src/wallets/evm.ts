// Polygon side: MetaMask through MetaMask Connect, which gives one EIP-1193
// provider for three cases: the browser extension on desktop, the MetaMask app
// on a phone (the page in Safari or Chrome deep-links to the app and talks to
// it through MetaMask's relay) and a desktop browser without the extension
// (a QR code for the app).
import { createEVMClient, type MetamaskConnectEVM } from '@metamask/connect-evm';
import { createWalletClient, custom, type EIP1193Provider, type WalletClient } from 'viem';
import { polygon } from 'viem/chains';
import { AppError, POLYGON_RPC, type EvmAddress } from '../cctp';

const POLYGON = '0x89';

// Created on first use: the client restores an earlier session on its own.
let client: Promise<MetamaskConnectEVM> | undefined;

function evm(): Promise<MetamaskConnectEVM> {
  client ??= createEVMClient({
    dapp: {
      name: 'USDC from Polygon to Stellar',
      url: location.origin,
      iconUrl: `${location.origin}/brand/usdc.svg`,
    },
    // read-only RPC the client may use on its own; signing goes to the wallet
    api: { supportedNetworks: { [POLYGON]: POLYGON_RPC } },
    ui: { preferExtension: true },
    analytics: { enabled: false },
  }).catch((e) => {
    client = undefined;
    throw e;
  });
  return client;
}

export async function connectMetaMask(): Promise<EvmAddress> {
  const c = await evm();
  const { accounts } = await c.connect({ chainIds: [POLYGON] });
  const address = accounts[0];
  if (!address) throw new AppError('err.noMetaMask');
  return address;
}

export async function polygonWallet(address: EvmAddress): Promise<WalletClient> {
  const c = await evm();
  if (c.getChainId() !== POLYGON) await c.switchChain({ chainId: POLYGON });
  const provider = c.getProvider() as unknown as EIP1193Provider;
  return createWalletClient({ account: address, chain: polygon, transport: custom(provider) });
}
