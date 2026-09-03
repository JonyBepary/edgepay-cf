/**
 * EdgePay Gateway Brand & Configuration Registry
 */

export interface GatewayBrandInfo {
  id: string;
  name: string;
  shortName: string;
  color: string;
  textColor: string;
  instructions: string;
  trxPlaceholder: string;
  trxRegex: RegExp;
}

export const GATEWAY_BRANDS: Record<string, GatewayBrandInfo> = {
  bkash: {
    id: 'bkash',
    name: 'bKash Send Money',
    shortName: 'bKash',
    color: '#E2136E',
    textColor: '#FFFFFF',
    instructions: 'Open your bKash app, select Send Money to the merchant number below, and enter your Transaction ID (TrxID).',
    trxPlaceholder: 'e.g. BL9A4K8M10',
    trxRegex: /^[A-Za-z0-9]{8,12}$/,
  },
  nagad: {
    id: 'nagad',
    name: 'Nagad Send Money',
    shortName: 'Nagad',
    color: '#F6921E',
    textColor: '#FFFFFF',
    instructions: 'Open your Nagad app, Send Money to the account number shown, and submit the 8-character TrxID.',
    trxPlaceholder: 'e.g. 71A89KC2',
    trxRegex: /^[A-Za-z0-9]{8,10}$/,
  },
  rocket: {
    id: 'rocket',
    name: 'Rocket MFS',
    shortName: 'Rocket',
    color: '#8C3494',
    textColor: '#FFFFFF',
    instructions: 'Dial *322# or open Rocket app, send money to the 12-digit account, and enter your TxnId.',
    trxPlaceholder: 'e.g. 2948194012',
    trxRegex: /^[A-Za-z0-9]{8,12}$/,
  },
  upay: {
    id: 'upay',
    name: 'Upay Mobile Wallet',
    shortName: 'Upay',
    color: '#005696',
    textColor: '#FFFFFF',
    instructions: 'Open Upay app, complete Send Money to merchant account, and input the receipt reference.',
    trxPlaceholder: 'e.g. UP89302194',
    trxRegex: /^[A-Za-z0-9]{8,12}$/,
  },
};
