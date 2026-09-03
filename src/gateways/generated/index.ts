/**
 * Generated gateway adapters — GENERATED FILE (scripts/port-gateways/generate.py).
 * One lazy factory per ported provider. Do not edit; regenerate.
 */

import { gatewayRegistry, type BaseGatewayAdapter } from '../base';
import { PLANNED_GATEWAY_SLUGS } from '../catalog.data';
import { Gw2checkoutGateway } from './2checkout.gateway';
import { AdyenGateway } from './adyen.gateway';
import { AffirmGateway } from './affirm.gateway';
import { AfterpayGateway } from './afterpay.gateway';
import { AmazonPayGateway } from './amazon-pay.gateway';
import { AuthorizeNetGateway } from './authorize-net.gateway';
import { BancontactGateway } from './bancontact.gateway';
import { BillerGenieGateway } from './biller-genie.gateway';
import { BitpayGateway } from './bitpay.gateway';
import { BluesnapGateway } from './bluesnap.gateway';
import { BtcpayGateway } from './btcpay.gateway';
import { CellfinGateway } from './cellfin.gateway';
import { ChasePaymentechGateway } from './chase-paymentech.gateway';
import { CoinbaseCommerceGateway } from './coinbase-commerce.gateway';
import { CybersourceGateway } from './cybersource.gateway';
import { DanaGateway } from './dana.gateway';
import { DlocalGateway } from './dlocal.gateway';
import { EasypaisaGateway } from './easypaisa.gateway';
import { EbanxGateway } from './ebanx.gateway';
import { ElavonGateway } from './elavon.gateway';
import { FastspringGateway } from './fastspring.gateway';
import { FattmerchantGateway } from './fattmerchant.gateway';
import { FirstDataGateway } from './first-data.gateway';
import { FiservGateway } from './fiserv.gateway';
import { FlutterwaveGateway } from './flutterwave.gateway';
import { GcashGateway } from './gcash.gateway';
import { GlobalPaymentsGateway } from './global-payments.gateway';
import { GocardlessGateway } from './gocardless.gateway';
import { GrabpayGateway } from './grabpay.gateway';
import { HeartlandGateway } from './heartland.gateway';
import { HelcimGateway } from './helcim.gateway';
import { IdealGateway } from './ideal.gateway';
import { KakaopayGateway } from './kakaopay.gateway';
import { MayaGateway } from './maya.gateway';
import { MercadolibreWalletGateway } from './mercadolibre-wallet.gateway';
import { MercadopagoGateway } from './mercadopago.gateway';
import { MidtransGateway } from './midtrans.gateway';
import { MobikwikGateway } from './mobikwik.gateway';
import { MollieGateway } from './mollie.gateway';
import { MomoGateway } from './momo.gateway';
import { MonerisGateway } from './moneris.gateway';
import { MpesaGateway } from './mpesa.gateway';
import { NetellerGateway } from './neteller.gateway';
import { NexuspayGateway } from './nexuspay.gateway';
import { NmiGateway } from './nmi.gateway';
import { OkWalletGateway } from './ok-wallet.gateway';
import { OpayGateway } from './opay.gateway';
import { OpennodeGateway } from './opennode.gateway';
import { OvoGateway } from './ovo.gateway';
import { PaylineDataGateway } from './payline-data.gateway';
import { PaymeGateway } from './payme.gateway';
import { PaymentDepotGateway } from './payment-depot.gateway';
import { PayoneerGateway } from './payoneer.gateway';
import { PaystackGateway } from './paystack.gateway';
import { PaytraceGateway } from './paytrace.gateway';
import { PayuGateway } from './payu.gateway';
import { PhonepeGateway } from './phonepe.gateway';
import { PromptpayGateway } from './promptpay.gateway';
import { RapydGateway } from './rapyd.gateway';
import { SezzleGateway } from './sezzle.gateway';
import { Shift4Gateway } from './shift4.gateway';
import { ShopeepayGateway } from './shopeepay.gateway';
import { SkrillGateway } from './skrill.gateway';
import { SquareGateway } from './square.gateway';
import { StaxGateway } from './stax.gateway';
import { TapGateway } from './tap.gateway';
import { TouchNGoGateway } from './touch-n-go.gateway';
import { TruemoneyGateway } from './truemoney.gateway';
import { TrustcommerceGateway } from './trustcommerce.gateway';
import { TsysGateway } from './tsys.gateway';
import { UpayGateway } from './upay.gateway';
import { WechatPayGateway } from './wechat-pay.gateway';
import { WiseGateway } from './wise.gateway';
import { WorldlineGateway } from './worldline.gateway';
import { WorldpayGateway } from './worldpay.gateway';
import { XenditGateway } from './xendit.gateway';

/** Registry slugs of every adapter produced by the port pipeline (raw, includes quarantined). */
const RAW_GENERATED_GATEWAY_SLUGS = [
  '2checkout',
  'adyen',
  'affirm',
  'afterpay',
  'amazon-pay',
  'authorize-net',
  'bancontact',
  'biller-genie',
  'bitpay',
  'bluesnap',
  'btcpay',
  'cellfin',
  'chase-paymentech',
  'coinbase-commerce',
  'cybersource',
  'dana',
  'dlocal',
  'easypaisa',
  'ebanx',
  'elavon',
  'fastspring',
  'fattmerchant',
  'first-data',
  'fiserv',
  'flutterwave',
  'gcash',
  'global-payments',
  'gocardless',
  'grabpay',
  'heartland',
  'helcim',
  'ideal',
  'kakaopay',
  'maya',
  'mercadolibre-wallet',
  'mercadopago',
  'midtrans',
  'mobikwik',
  'mollie',
  'momo',
  'moneris',
  'mpesa',
  'neteller',
  'nexuspay',
  'nmi',
  'ok-wallet',
  'opay',
  'opennode',
  'ovo',
  'payline-data',
  'payme',
  'payment-depot',
  'payoneer',
  'paystack',
  'paytrace',
  'payu',
  'phonepe',
  'promptpay',
  'rapyd',
  'sezzle',
  'shift4',
  'shopeepay',
  'skrill',
  'square',
  'stax',
  'tap',
  'touch-n-go',
  'truemoney',
  'trustcommerce',
  'tsys',
  'upay',
  'wechat-pay',
  'wise',
  'worldline',
  'worldpay',
  'xendit',
] as const;

/**
 * Registry slugs of generated adapters that are actually usable.
 * Quarantined ports (slugs the catalog marks `planned`) are excluded so the
 * planned stub (GatewayNotPortedError, fail-closed) wins. Files stay on disk.
 */
export const GENERATED_GATEWAY_SLUGS: readonly string[] = (
  RAW_GENERATED_GATEWAY_SLUGS as readonly string[]
).filter((s) => !(PLANNED_GATEWAY_SLUGS as readonly string[]).includes(s));

/**
 * Generated registration helper — skips any slug the catalog marks planned
 * so registerPlannedGateways() can claim it as a fail-closed stub.
 */
function registerGenerated(slug: string, factory: () => BaseGatewayAdapter): void {
  if ((PLANNED_GATEWAY_SLUGS as readonly string[]).includes(slug)) return;
  gatewayRegistry.register(slug, factory);
}

registerGenerated('2checkout', () => new Gw2checkoutGateway());
registerGenerated('adyen', () => new AdyenGateway());
registerGenerated('affirm', () => new AffirmGateway());
registerGenerated('afterpay', () => new AfterpayGateway());
registerGenerated('amazon-pay', () => new AmazonPayGateway());
registerGenerated('authorize-net', () => new AuthorizeNetGateway());
registerGenerated('bancontact', () => new BancontactGateway());
registerGenerated('biller-genie', () => new BillerGenieGateway());
registerGenerated('bitpay', () => new BitpayGateway());
registerGenerated('bluesnap', () => new BluesnapGateway());
registerGenerated('btcpay', () => new BtcpayGateway());
registerGenerated('cellfin', () => new CellfinGateway());
registerGenerated('chase-paymentech', () => new ChasePaymentechGateway());
registerGenerated('coinbase-commerce', () => new CoinbaseCommerceGateway());
registerGenerated('cybersource', () => new CybersourceGateway());
registerGenerated('dana', () => new DanaGateway());
registerGenerated('dlocal', () => new DlocalGateway());
registerGenerated('easypaisa', () => new EasypaisaGateway());
registerGenerated('ebanx', () => new EbanxGateway());
registerGenerated('elavon', () => new ElavonGateway());
registerGenerated('fastspring', () => new FastspringGateway());
registerGenerated('fattmerchant', () => new FattmerchantGateway());
registerGenerated('first-data', () => new FirstDataGateway());
registerGenerated('fiserv', () => new FiservGateway());
registerGenerated('flutterwave', () => new FlutterwaveGateway());
registerGenerated('gcash', () => new GcashGateway());
registerGenerated('global-payments', () => new GlobalPaymentsGateway());
registerGenerated('gocardless', () => new GocardlessGateway());
registerGenerated('grabpay', () => new GrabpayGateway());
registerGenerated('heartland', () => new HeartlandGateway());
registerGenerated('helcim', () => new HelcimGateway());
registerGenerated('ideal', () => new IdealGateway());
registerGenerated('kakaopay', () => new KakaopayGateway());
registerGenerated('maya', () => new MayaGateway());
registerGenerated('mercadolibre-wallet', () => new MercadolibreWalletGateway());
registerGenerated('mercadopago', () => new MercadopagoGateway());
registerGenerated('midtrans', () => new MidtransGateway());
registerGenerated('mobikwik', () => new MobikwikGateway());
registerGenerated('mollie', () => new MollieGateway());
registerGenerated('momo', () => new MomoGateway());
registerGenerated('moneris', () => new MonerisGateway());
registerGenerated('mpesa', () => new MpesaGateway());
registerGenerated('neteller', () => new NetellerGateway());
registerGenerated('nexuspay', () => new NexuspayGateway());
registerGenerated('nmi', () => new NmiGateway());
registerGenerated('ok-wallet', () => new OkWalletGateway());
registerGenerated('opay', () => new OpayGateway());
registerGenerated('opennode', () => new OpennodeGateway());
registerGenerated('ovo', () => new OvoGateway());
registerGenerated('payline-data', () => new PaylineDataGateway());
registerGenerated('payme', () => new PaymeGateway());
registerGenerated('payment-depot', () => new PaymentDepotGateway());
registerGenerated('payoneer', () => new PayoneerGateway());
registerGenerated('paystack', () => new PaystackGateway());
registerGenerated('paytrace', () => new PaytraceGateway());
registerGenerated('payu', () => new PayuGateway());
registerGenerated('phonepe', () => new PhonepeGateway());
registerGenerated('promptpay', () => new PromptpayGateway());
registerGenerated('rapyd', () => new RapydGateway());
registerGenerated('sezzle', () => new SezzleGateway());
registerGenerated('shift4', () => new Shift4Gateway());
registerGenerated('shopeepay', () => new ShopeepayGateway());
registerGenerated('skrill', () => new SkrillGateway());
registerGenerated('square', () => new SquareGateway());
registerGenerated('stax', () => new StaxGateway());
registerGenerated('tap', () => new TapGateway());
registerGenerated('touch-n-go', () => new TouchNGoGateway());
registerGenerated('truemoney', () => new TruemoneyGateway());
registerGenerated('trustcommerce', () => new TrustcommerceGateway());
registerGenerated('tsys', () => new TsysGateway());
registerGenerated('upay', () => new UpayGateway());
registerGenerated('wechat-pay', () => new WechatPayGateway());
registerGenerated('wise', () => new WiseGateway());
registerGenerated('worldline', () => new WorldlineGateway());
registerGenerated('worldpay', () => new WorldpayGateway());
registerGenerated('xendit', () => new XenditGateway());
