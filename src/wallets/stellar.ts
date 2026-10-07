// Stellar side. Every wallet is an adapter with connect() and sign(xdr, address).
// sign() must start its popup synchronously from the click that calls it, so an
// adapter may not await anything before asking the wallet.
import albedo from '@albedo-link/intent';
import freighter from '@stellar/freighter-api';
import { Networks } from '@stellar/stellar-sdk';
import { AppError } from '../cctp';

export interface StellarWallet {
  name: string;
  connect(): Promise<string>;
  sign(xdr: string, address: string): Promise<string>;
}

export type StellarWalletId = 'albedo' | 'freighter';

export const stellarWallets: Record<StellarWalletId, StellarWallet> = {
  albedo: {
    name: 'Albedo',
    async connect() {
      const res = await albedo.publicKey({});
      return res.pubkey;
    },
    sign(xdr, address) {
      return albedo.tx({ xdr, pubkey: address, network: 'public', submit: false }).then((r) => r.signed_envelope_xdr);
    },
  },
  freighter: {
    name: 'Freighter',
    async connect() {
      const state = await freighter.isConnected();
      if (state.error || !state.isConnected) throw new AppError('err.noFreighter');
      const res = await freighter.requestAccess();
      if (res.error) throw new Error(res.error.message ?? String(res.error));
      return res.address;
    },
    async sign(xdr, address) {
      const res = await freighter.signTransaction(xdr, { networkPassphrase: Networks.PUBLIC, address });
      if (res.error) throw new Error(res.error.message ?? String(res.error));
      return res.signedTxXdr;
    },
  },
};
