// Polygon side: an EIP-1193 provider, in practice MetaMask.
// TODO: discover other wallets through EIP-6963 instead of window.ethereum.
import { createWalletClient, custom, type EIP1193Provider, type WalletClient } from 'viem';
import { polygon } from 'viem/chains';
import { AppError, type EvmAddress } from '../cctp';

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export async function connectMetaMask(): Promise<EvmAddress> {
  if (!window.ethereum) throw new AppError('err.noMetaMask');
  const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  return address;
}

export async function polygonWallet(address: EvmAddress): Promise<WalletClient> {
  if (!window.ethereum) throw new AppError('err.noMetaMask');
  const chainId = await window.ethereum.request({ method: 'eth_chainId' });
  if (chainId !== '0x89') {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
  }
  return createWalletClient({ account: address, chain: polygon, transport: custom(window.ethereum) });
}
